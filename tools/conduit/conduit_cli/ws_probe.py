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

    # Inter-frame gap stats (post-auth). Useful for catching the
    # "looks fine but pauses for 15 s every minute" symptom.
    frame_count: int = 0
    max_gap_s: float = 0.0
    gaps_over_1s: int = 0
    gaps_over_5s: int = 0
    gaps_over_10s: int = 0
    longest_gaps: list = field(default_factory=list)   # top 5 [(t_offset, gap_s)]
    duration_s: float = 0.0

    # Re/disconnect phase timings (ms, monotonic). Populated by probe()
    # regardless of --exit-on-status; the flag only controls whether we
    # break out as soon as STATUS lands or keep listening.
    #   t_connect_ms   : TCP (or TLS-over-TCP) socket open
    #   t_handshake_ms : HTTP Upgrade → 101 received
    #   t_auth_ms      : CMD reply to the auth frame received
    #   t_status_ms    : first STATUS frame received
    #   t_close_ms     : CLOSE frame sent + socket closed (post-listen)
    #   total_ms       : whole probe() round-trip including close
    t_connect_ms: float = 0.0
    t_handshake_ms: float = 0.0
    t_auth_ms: float = 0.0
    t_status_ms: float = 0.0
    t_close_ms: float = 0.0
    total_ms: float = 0.0

    # TLS session resumption signal. True iff the server accepted a
    # session ticket / session-ID resumption (`SSLSocket.session_reused`).
    # `tls_session` is the post-handshake `SSLSession` object; pass it
    # into probe(reuse_session=...) on the next call to attempt
    # resumption. Both stay None for non-TLS probes.
    tls_resumed: Optional[bool] = None
    tls_session: object = None


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
    exit_on_status: bool = False,
    tls_context: Optional[ssl.SSLContext] = None,
    reuse_session: object = None,
) -> ProbeResult:
    """Connect, authenticate, listen for `duration_s` seconds, return
    the aggregate of what we saw. Raises on protocol errors.

    If `exit_on_status` is set, the listen loop breaks as soon as the
    server has both echoed the auth reply AND emitted its first STATUS
    frame — used by the reconnect-timing harness so we measure
    end-to-end "back online" latency without paying the trailing
    duration_s observation tax.

    For TLS resumption testing: pass a stable `tls_context` (reused
    across cycles) and the `reuse_session` returned from a previous
    call's `ProbeResult.tls_session`. The wrap_socket call will offer
    the session to the server; `result.tls_resumed` reflects what the
    server accepted. `tls_context` may be None — a fresh default
    context is created with verify off when `tls_verify` is False."""
    result = ProbeResult()
    t_start = time.monotonic()
    t_close_start = t_start    # safety: overwritten before the finally close

    sock = socket.create_connection((host, port), timeout=timeout_s)
    if use_tls:
        ctx = tls_context
        if ctx is None:
            ctx = ssl.create_default_context()
            if not tls_verify:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
        # Python's ssl.wrap_socket accepts `session=` to offer a prior
        # SSLSession to the server; if the server's session-ticket /
        # session-cache layer accepts it, the handshake is abbreviated
        # (no fresh ECDHE/ECDSA) and SSLSocket.session_reused goes True.
        wrap_kwargs = {"server_hostname": host}
        if reuse_session is not None:
            wrap_kwargs["session"] = reuse_session
        sock = ctx.wrap_socket(sock, **wrap_kwargs)
        result.tls_resumed = bool(getattr(sock, "session_reused", False))
        # Snapshot the new session for the caller to reuse next cycle.
        result.tls_session = getattr(sock, "session", None)
    result.t_connect_ms = round((time.monotonic() - t_start) * 1000, 2)

    try:
        leftover = _http_upgrade(sock, host)
        result.handshake_ok = True
        result.t_handshake_ms = round((time.monotonic() - t_start) * 1000, 2)

        # Send the auth frame immediately (matches stream.js's onopen).
        auth_body = b"C" + f"seq=0&name=auth&token={token}".encode("utf-8")
        _send_frame(sock, OP_TEXT, auth_body)

        deadline = time.monotonic() + duration_s
        start_t = time.monotonic()
        # Use a short socket timeout so we can sample the wall clock
        # frequently and accumulate gap stats even when frames are dense.
        # The exit_on_status fast-path also needs this short slice so
        # the reconnect harness doesn't sit blocked on recv() for 500 ms
        # past the STATUS that already arrived.
        sock.settimeout(0.05 if exit_on_status else 0.5)
        last_frame_t: Optional[float] = None

        while time.monotonic() < deadline:
            try:
                fin, opcode, payload, leftover = _read_frame(sock, leftover)
            except socket.timeout:
                # No frame in this slice — keep waiting until deadline.
                continue
            except (ConnectionResetError, OSError) as e:
                result.errors.append(f"socket error: {e}")
                break

            now = time.monotonic()
            if last_frame_t is not None:
                gap = now - last_frame_t
                if gap > result.max_gap_s:
                    result.max_gap_s = gap
                if gap > 10.0:
                    result.gaps_over_10s += 1
                if gap > 5.0:
                    result.gaps_over_5s += 1
                if gap > 1.0:
                    result.gaps_over_1s += 1
                # Track top-5 longest with their time offset since auth.
                t_offset = round(now - start_t, 2)
                result.longest_gaps.append((t_offset, round(gap, 3)))
                result.longest_gaps.sort(key=lambda p: -p[1])
                result.longest_gaps = result.longest_gaps[:5]
            last_frame_t = now
            result.frame_count += 1

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
                    if obj.get("seq") == 0 and obj.get("ok") and not result.auth_ok:
                        result.auth_ok = True
                        result.t_auth_ms = round((time.monotonic() - t_start) * 1000, 2)
            elif channel == CH_STATUS:
                obj = _json_loads(body, result, "STATUS")
                if obj:
                    if not result.status_seen:
                        result.t_status_ms = round((time.monotonic() - t_start) * 1000, 2)
                    result.status_seen = True
                    result.last_status = obj
                    if exit_on_status and result.auth_ok:
                        break
            elif channel == CH_NOTICE:
                obj = _json_loads(body, result, "NOTICE")
                if obj:
                    result.notice_seen = True
                    result.last_notice = obj
            else:
                result.errors.append(f"unknown channel {channel!r}")

        result.duration_s = round(time.monotonic() - start_t, 2)
        # Polite close. t_close_ms measures the round-trip of "tell the
        # peer we're going away + tear the socket down" — i.e. the
        # disconnect side of the dis/reconnect budget. Captured before
        # the finally-block sock.close() so we time the same operation
        # in both the success and post-error path.
        t_close_start = time.monotonic()
        try:
            _send_frame(sock, OP_CLOSE, struct.pack(">H", 1000))
        except OSError:
            pass
    finally:
        try:
            sock.close()
        except OSError:
            pass
        result.t_close_ms = round((time.monotonic() - t_close_start) * 1000, 2)
        result.total_ms = round((time.monotonic() - t_start) * 1000, 2)
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
        f"  duration_s          : {r.duration_s}",
        f"  frame_count         : {r.frame_count}",
        f"  log_bytes           : {r.log_bytes}",
        f"  data_bytes          : {r.data_bytes}",
        f"  keepalive_seen      : {r.keepalive_seen}",
        f"  cmd_reply_seen      : {r.cmd_reply_seen}",
        f"  pings_received      : {r.pings_received}",
        f"  max_gap_s           : {r.max_gap_s:.2f}",
        f"  gaps_over_1s        : {r.gaps_over_1s}",
        f"  gaps_over_5s        : {r.gaps_over_5s}",
        f"  gaps_over_10s       : {r.gaps_over_10s}",
        # Phase timings — what the reconnect-budget gate uses.
        f"  t_connect_ms        : {r.t_connect_ms:.1f}",
        f"  t_handshake_ms      : {r.t_handshake_ms:.1f}",
        f"  t_auth_ms           : {r.t_auth_ms:.1f}",
        f"  t_status_ms         : {r.t_status_ms:.1f}",
        f"  t_close_ms          : {r.t_close_ms:.1f}",
        f"  total_ms            : {r.total_ms:.1f}",
    ]
    if r.longest_gaps:
        gaps_str = ', '.join(f"{g}s@{t}s" for t, g in r.longest_gaps)
        lines.append(f"  longest_gaps        : [{gaps_str}]")
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
    p.add_argument(
        "--exit-on-status",
        action="store_true",
        help="break the listen loop as soon as the first STATUS frame "
             "arrives — used by the reconnect-budget timing harness "
             "(implies a tighter 0.05 s recv slice).",
    )
    p.add_argument(
        "--repeat",
        type=int,
        default=1,
        help="run N back-to-back probe cycles and print a per-iteration "
             "timing table + pass/fail vs --threshold-s (default: 1).",
    )
    p.add_argument(
        "--threshold-s",
        type=float,
        default=2.0,
        help="per-cycle total_ms budget in seconds (default: 2.0). When "
             "--repeat>1, exit 0 only if EVERY cycle's total_ms is "
             "≤ threshold AND auth+status landed.",
    )
    p.add_argument(
        "--gap-s",
        type=float,
        default=0.0,
        help="seconds to sleep between --repeat cycles (default: 0). A "
             "short non-zero gap can be useful when measuring the "
             "device's recovery from one socket teardown to the next "
             "accept without slamming it.",
    )
    p.add_argument(
        "--reuse-session",
        action="store_true",
        help="Carry the TLS session from one --repeat cycle into the "
             "next so the server's session-ticket/cache path can "
             "abbreviate the handshake. Only meaningful with --tls. "
             "Reports `resumed` per cycle and adds a yes/no column to "
             "the timing table.",
    )
    p.add_argument("--json", action="store_true", help="emit JSON instead of text")
    args = p.parse_args(argv)

    # TLS context is shared across all cycles when --tls is set so
    # Python's internal session machinery and any user-passed session
    # state survive between probe() invocations. Without this, each
    # cycle would create a fresh SSLContext and no resumption could ever
    # happen even if both sides supported it.
    shared_tls_ctx: Optional[ssl.SSLContext] = None
    if args.tls:
        shared_tls_ctx = ssl.create_default_context()
        if not args.tls_verify:
            shared_tls_ctx.check_hostname = False
            shared_tls_ctx.verify_mode = ssl.CERT_NONE
    carried_session: object = None       # only set when --reuse-session

    def _run_one() -> tuple[Optional[ProbeResult], Optional[str]]:
        nonlocal carried_session
        try:
            r = probe(
                host=args.device,
                port=args.port,
                token=args.token,
                use_tls=args.tls,
                duration_s=args.duration,
                exit_on_status=args.exit_on_status,
                tls_context=shared_tls_ctx,
                reuse_session=carried_session if args.reuse_session else None,
            )
            if args.reuse_session and r.tls_session is not None:
                carried_session = r.tls_session
            return r, None
        except Exception as e:
            return None, str(e)

    # ------------------------------ single-shot ---------------------------
    if args.repeat <= 1:
        result, err = _run_one()
        if err is not None:
            if args.json:
                print(json.dumps({"ok": False, "error": err}))
            else:
                print(f"probe failed: {err}", file=sys.stderr)
            return 2
        assert result is not None
        if args.json:
            print(json.dumps(_result_to_dict(result)))
        else:
            print(_format_report(result))
        if not result.handshake_ok:
            return 2
        if not (result.auth_ok and result.status_seen):
            return 1
        return 0

    # ------------------------------ N-cycle harness -----------------------
    # Used to verify the dis/reconnect budget across multiple consecutive
    # cycles. Per-iteration table mirrors the JSON shape so the same
    # output can be diffed across firmware iterations.
    threshold_ms = args.threshold_s * 1000.0
    rows: list[dict] = []
    pass_count = 0
    for i in range(args.repeat):
        result, err = _run_one()
        if err is not None:
            rows.append({"i": i + 1, "ok": False, "error": err})
        else:
            assert result is not None
            ok = (
                result.handshake_ok
                and result.auth_ok
                and result.status_seen
                and result.total_ms <= threshold_ms
            )
            if ok:
                pass_count += 1
            rows.append({
                "i": i + 1,
                "ok": ok,
                "t_connect_ms":   result.t_connect_ms,
                "t_handshake_ms": result.t_handshake_ms,
                "t_auth_ms":      result.t_auth_ms,
                "t_status_ms":    result.t_status_ms,
                "t_close_ms":     result.t_close_ms,
                "total_ms":       result.total_ms,
                "auth_ok":        result.auth_ok,
                "status_seen":    result.status_seen,
                "tls_resumed":    result.tls_resumed,
            })
        if args.gap_s > 0 and i + 1 < args.repeat:
            time.sleep(args.gap_s)

    if args.json:
        print(json.dumps({
            "ok": pass_count == args.repeat,
            "repeat": args.repeat,
            "pass": pass_count,
            "threshold_ms": threshold_ms,
            "rows": rows,
        }))
    else:
        print(f"WebSocket reconnect timing — {args.repeat} cycles, "
              f"budget {args.threshold_s:.2f}s")
        print("-" * 86)
        # The trailing `tls` column is only meaningful with --tls; we
        # render it always to keep the header stable, but it shows '-'
        # for non-TLS cycles.
        print(f"  {'#':>2}  {'conn':>6}  {'hshk':>6}  {'auth':>6}  "
              f"{'stat':>6}  {'close':>6}  {'total':>7}  ok  tls")
        for row in rows:
            if "error" in row:
                print(f"  {row['i']:>2}  ERROR: {row['error']}")
                continue
            marker = "✓" if row["ok"] else "✗"
            tls_col = ("-" if row.get("tls_resumed") is None
                       else "resumed" if row["tls_resumed"]
                       else "full")
            print(f"  {row['i']:>2}  "
                  f"{row['t_connect_ms']:>6.1f}  "
                  f"{row['t_handshake_ms']:>6.1f}  "
                  f"{row['t_auth_ms']:>6.1f}  "
                  f"{row['t_status_ms']:>6.1f}  "
                  f"{row['t_close_ms']:>6.1f}  "
                  f"{row['total_ms']:>7.1f}  {marker}  {tls_col}")
        ok_rows = [r for r in rows if "error" not in r]
        if ok_rows:
            totals = [r["total_ms"] for r in ok_rows]
            print("-" * 78)
            print(f"  total_ms: min={min(totals):.1f}  "
                  f"max={max(totals):.1f}  "
                  f"avg={sum(totals)/len(totals):.1f}  "
                  f"median={sorted(totals)[len(totals)//2]:.1f}")
        print(f"  PASSED {pass_count}/{args.repeat} "
              f"(threshold ≤ {args.threshold_s:.2f}s, all checks)")
    return 0 if pass_count == args.repeat else 1


def _result_to_dict(result: ProbeResult) -> dict:
    return {
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
        "t_connect_ms":   result.t_connect_ms,
        "t_handshake_ms": result.t_handshake_ms,
        "t_auth_ms":      result.t_auth_ms,
        "t_status_ms":    result.t_status_ms,
        "t_close_ms":     result.t_close_ms,
        "total_ms":       result.total_ms,
        "tls_resumed":    result.tls_resumed,
    }


if __name__ == "__main__":
    raise SystemExit(main())
