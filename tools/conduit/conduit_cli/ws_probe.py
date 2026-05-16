"""WebSocket probe for /api/stream.

Standalone RFC 6455 client (stdlib only — `socket` + `ssl` + `os`) that
talks to the CONDUIT board's unified stream endpoint. Used both as a
manual diagnostic ("does the WS work end-to-end against my device?")
and as the engine for the integration test under tools/conduit/tests.

Why not use the `websockets` library: the CLI's pyproject.toml only
depends on click + httpx, and we don't want to pull a websocket dep
in just for this probe. The protocol is small enough to hand-roll.

The probe checks the wire format documented in firmware/app/ws_server.h:
  - HTTP Upgrade handshake, Sec-WebSocket-Accept validation
  - Auth via first-frame CMD (seq=0&name=auth&token=...)
  - Channel multiplex (L/D/C/S/N) via 1-byte tag at payload[0]
  - PING/PONG control frames
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import socket
import ssl
import struct
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# Channel tags (must match ws_server.h).
CH_LOG, CH_DATA, CH_CMD, CH_STATUS, CH_NOTICE = b"L", b"D", b"C", b"S", b"N"

# RFC 6455 opcodes.
OP_CONT, OP_TEXT, OP_BIN = 0x0, 0x1, 0x2
OP_CLOSE, OP_PING, OP_PONG = 0x8, 0x9, 0xA


@dataclass
class ProbeResult:
    """What the probe observed during its run."""

    handshake_ok: bool = False
    auth_ok: bool = False
    status_seen: bool = False
    notice_seen: bool = False
    log_bytes: int = 0
    data_bytes: int = 0
    keepalive_seen: bool = False
    cmd_reply_seen: bool = False
    pings_received: int = 0
    last_status: Optional[dict] = None
    last_notice: Optional[dict] = None
    last_cmd_reply: Optional[dict] = None
    sample_log_line: Optional[str] = None
    errors: list = field(default_factory=list)


def _http_upgrade(sock: socket.socket, host: str, path: str = "/api/stream") -> bytes:
    """Send the HTTP Upgrade request, return the bytes that arrived AFTER
    the 101 response headers (any frames the server piled on top)."""
    nonce = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {nonce}\r\n"
        f"Sec-WebSocket-Version: 13\r\n"
        f"\r\n"
    )
    sock.sendall(request.encode("ascii"))

    # Read response until we see the end of headers (\r\n\r\n). Anything
    # after that is the first slice of WS frame bytes.
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("connection closed during Upgrade handshake")
        buf += chunk

    head, _, tail = buf.partition(b"\r\n\r\n")
    status_line, _, headers_blob = head.partition(b"\r\n")
    if not status_line.startswith(b"HTTP/1.1 101"):
        raise RuntimeError(f"expected 101 Switching Protocols, got {status_line!r}")

    headers = {}
    for line in headers_blob.split(b"\r\n"):
        k, _, v = line.partition(b":")
        if k:
            headers[k.strip().lower().decode("ascii")] = v.strip().decode("ascii")

    expected = base64.b64encode(
        hashlib.sha1((nonce + WS_GUID).encode("ascii")).digest()
    ).decode("ascii")
    got = headers.get("sec-websocket-accept", "")
    if got != expected:
        raise RuntimeError(
            f"bad Sec-WebSocket-Accept: got {got!r}, expected {expected!r}"
        )
    return tail


def _send_frame(sock: socket.socket, opcode: int, payload: bytes) -> None:
    """Emit an RFC 6455 client→server (masked) frame."""
    head = bytearray([0x80 | (opcode & 0x0F)])
    n = len(payload)
    if n < 126:
        head.append(0x80 | n)
    elif n <= 0xFFFF:
        head.append(0x80 | 126)
        head += struct.pack(">H", n)
    else:
        head.append(0x80 | 127)
        head += struct.pack(">Q", n)
    mask = secrets.token_bytes(4)
    head += mask
    masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
    sock.sendall(bytes(head) + masked)


def _read_exact(sock: socket.socket, n: int, prebuf: bytes) -> tuple[bytes, bytes]:
    """Drain `n` bytes; return (bytes, leftover_after_drain). May draw
    from prebuf first to consume any bytes that piggybacked the
    Upgrade response."""
    buf = bytearray(prebuf)
    while len(buf) < n:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("connection closed mid-frame")
        buf += chunk
    return bytes(buf[:n]), bytes(buf[n:])


def _read_frame(
    sock: socket.socket, prebuf: bytes
) -> tuple[int, int, bytes, bytes]:
    """Decode one server frame. Returns (fin, opcode, payload, leftover)."""
    hdr, prebuf = _read_exact(sock, 2, prebuf)
    fin = (hdr[0] >> 7) & 1
    if hdr[0] & 0x70:
        raise RuntimeError(f"non-zero RSV bits: {hdr[0]:#x}")
    opcode = hdr[0] & 0x0F
    masked = (hdr[1] >> 7) & 1
    if masked:
        raise RuntimeError("server→client frame must NOT be masked")
    length = hdr[1] & 0x7F
    if length == 126:
        ext, prebuf = _read_exact(sock, 2, prebuf)
        length = struct.unpack(">H", ext)[0]
    elif length == 127:
        ext, prebuf = _read_exact(sock, 8, prebuf)
        length = struct.unpack(">Q", ext)[0]
    payload, prebuf = _read_exact(sock, length, prebuf)
    return fin, opcode, payload, prebuf


def probe(
    host: str,
    port: int = 80,
    token: str = "changeme",
    use_tls: bool = False,
    tls_verify: bool = False,
    timeout_s: float = 20.0,
    duration_s: float = 6.0,
) -> ProbeResult:
    """Connect, authenticate, listen for `duration_s` seconds, return
    the aggregate of what we saw. Raises on protocol errors."""
    result = ProbeResult()

    sock = socket.create_connection((host, port), timeout=timeout_s)
    if use_tls:
        ctx = ssl.create_default_context()
        if not tls_verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        sock = ctx.wrap_socket(sock, server_hostname=host)

    try:
        leftover = _http_upgrade(sock, host)
        result.handshake_ok = True

        # Send the auth frame immediately (matches stream.js's onopen).
        auth_body = b"C" + f"seq=0&name=auth&token={token}".encode("utf-8")
        _send_frame(sock, OP_TEXT, auth_body)

        deadline = time.monotonic() + duration_s
        sock.settimeout(max(0.5, duration_s / 4))

        while time.monotonic() < deadline:
            try:
                fin, opcode, payload, leftover = _read_frame(sock, leftover)
            except socket.timeout:
                # No frame in this slice — keep waiting until deadline.
                continue
            except (ConnectionResetError, OSError) as e:
                result.errors.append(f"socket error: {e}")
                break

            if opcode == OP_PING:
                _send_frame(sock, OP_PONG, payload)
                result.pings_received += 1
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                _send_frame(sock, OP_CLOSE, payload)
                break
            if opcode not in (OP_TEXT, OP_BIN):
                result.errors.append(f"unexpected opcode {opcode:#x}")
                continue

            if not payload:
                result.errors.append("empty payload")
                continue
            channel = payload[:1]
            body = payload[1:]

            if channel == CH_LOG:
                result.log_bytes += len(body)
                if result.sample_log_line is None:
                    line = body.decode("utf-8", errors="replace").rstrip()
                    if line:
                        result.sample_log_line = line
            elif channel == CH_DATA:
                result.data_bytes += len(body)
                # KEEPALIVE_MSG_ID = 0xFFFF — see firmware data_buffer.h.
                if len(body) >= 16 and body[2:4] == b"\xff\xff" and body[5:7] == b"\x00\x00":
                    result.keepalive_seen = True
            elif channel == CH_CMD:
                obj = _json_loads(body, result, "CMD")
                if obj:
                    result.cmd_reply_seen = True
                    result.last_cmd_reply = obj
                    if obj.get("seq") == 0 and obj.get("ok"):
                        result.auth_ok = True
            elif channel == CH_STATUS:
                obj = _json_loads(body, result, "STATUS")
                if obj:
                    result.status_seen = True
                    result.last_status = obj
            elif channel == CH_NOTICE:
                obj = _json_loads(body, result, "NOTICE")
                if obj:
                    result.notice_seen = True
                    result.last_notice = obj
            else:
                result.errors.append(f"unknown channel {channel!r}")

        # Polite close.
        try:
            _send_frame(sock, OP_CLOSE, struct.pack(">H", 1000))
        except OSError:
            pass
    finally:
        try:
            sock.close()
        except OSError:
            pass
    return result


def _json_loads(payload: bytes, result: ProbeResult, label: str) -> Optional[dict]:
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        result.errors.append(f"{label} bad JSON: {e}")
        return None


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _format_report(r: ProbeResult) -> str:
    lines = [
        "WebSocket probe results",
        "-----------------------",
        f"  handshake_ok        : {r.handshake_ok}",
        f"  auth_ok             : {r.auth_ok}",
        f"  status_seen         : {r.status_seen}",
        f"  notice_seen         : {r.notice_seen}",
        f"  log_bytes           : {r.log_bytes}",
        f"  data_bytes          : {r.data_bytes}",
        f"  keepalive_seen      : {r.keepalive_seen}",
        f"  cmd_reply_seen      : {r.cmd_reply_seen}",
        f"  pings_received      : {r.pings_received}",
    ]
    if r.last_notice:
        lines.append(f"  last_notice         : {r.last_notice}")
    if r.last_cmd_reply:
        lines.append(f"  last_cmd_reply      : {r.last_cmd_reply}")
    if r.last_status:
        v = r.last_status
        lines.append(
            f"  last_status         : version={v.get('version')} "
            f"partition={v.get('partition')} uptime={v.get('uptime')} "
            f"link={v.get('link')}"
        )
    if r.sample_log_line:
        lines.append(f"  sample_log_line     : {r.sample_log_line!r}")
    if r.errors:
        lines.append(f"  errors              : {r.errors}")
    return "\n".join(lines)


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("-d", "--device", required=True, help="device IP or hostname")
    p.add_argument("-p", "--port", type=int, default=80, help="default 80; use 443 for TLS")
    p.add_argument("--tls", action="store_true", help="use TLS (wss://)")
    p.add_argument("--tls-verify", action="store_true", help="verify TLS cert chain")
    p.add_argument(
        "-t",
        "--token",
        default=os.environ.get("CONDUIT_AUTH_TOKEN", "changeme"),
        help="auth token (default: env CONDUIT_AUTH_TOKEN or 'changeme')",
    )
    p.add_argument(
        "--duration",
        type=float,
        default=6.0,
        help="seconds to listen after auth (default: 6)",
    )
    p.add_argument("--json", action="store_true", help="emit JSON instead of text")
    args = p.parse_args(argv)

    try:
        result = probe(
            host=args.device,
            port=args.port,
            token=args.token,
            use_tls=args.tls,
            duration_s=args.duration,
        )
    except Exception as e:
        if args.json:
            print(json.dumps({"ok": False, "error": str(e)}))
        else:
            print(f"probe failed: {e}", file=sys.stderr)
        return 2

    if args.json:
        print(
            json.dumps(
                {
                    "ok": result.handshake_ok and result.auth_ok and result.status_seen,
                    "handshake_ok": result.handshake_ok,
                    "auth_ok": result.auth_ok,
                    "status_seen": result.status_seen,
                    "notice_seen": result.notice_seen,
                    "log_bytes": result.log_bytes,
                    "data_bytes": result.data_bytes,
                    "keepalive_seen": result.keepalive_seen,
                    "cmd_reply_seen": result.cmd_reply_seen,
                    "pings_received": result.pings_received,
                    "last_status": result.last_status,
                    "last_notice": result.last_notice,
                    "last_cmd_reply": result.last_cmd_reply,
                    "sample_log_line": result.sample_log_line,
                    "errors": result.errors,
                }
            )
        )
    else:
        print(_format_report(result))
    # Exit code: 0 if the device authed and emitted a STATUS frame; 1 if
    # the handshake worked but auth or status was missing; 2 on hard
    # error (raised exception, handled above).
    if not result.handshake_ok:
        return 2
    if not (result.auth_ok and result.status_seen):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
