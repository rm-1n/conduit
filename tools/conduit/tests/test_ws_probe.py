"""Integration test for the /api/stream WebSocket endpoint.

Runs only when CONDUIT_TEST_IP is set in the env — the assumption is
a CONDUIT device is reachable at that IP and has the firmware with
the WS endpoint installed (firmware/app/ws_server.c). Without that
var the test is skipped, so CI (which has no board) stays green and
local developers can run it with:

    CONDUIT_TEST_IP=192.168.178.200 pytest tests/test_ws_probe.py -v

Also covers the offline pieces of conduit_cli.ws_probe (the channel
constants + frame round-trip mechanics) without needing a device, so
schema drift between the prober and the firmware shows up in CI too.
"""

from __future__ import annotations

import os
import socket
import struct
import secrets

import pytest

from conduit_cli import ws_probe


# ── Pure-codec checks (always run; no device needed) ─────────────────


def test_channel_tags_match_firmware_constants():
    """The probe's channel tags MUST match ws_server.h."""
    assert ws_probe.CH_LOG == b"L"
    assert ws_probe.CH_DATA == b"D"
    assert ws_probe.CH_CMD == b"C"
    assert ws_probe.CH_STATUS == b"S"
    assert ws_probe.CH_NOTICE == b"N"


def test_opcodes_match_rfc6455():
    assert ws_probe.OP_CONT == 0x0
    assert ws_probe.OP_TEXT == 0x1
    assert ws_probe.OP_BIN == 0x2
    assert ws_probe.OP_CLOSE == 0x8
    assert ws_probe.OP_PING == 0x9
    assert ws_probe.OP_PONG == 0xA


def test_ws_guid_matches_rfc6455():
    assert ws_probe.WS_GUID == "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


# ── Live device tests — only when CONDUIT_TEST_IP is set ─────────────


_TEST_IP = os.environ.get("CONDUIT_TEST_IP")
_TEST_TOKEN = os.environ.get("CONDUIT_TEST_TOKEN", "changeme")
needs_device = pytest.mark.skipif(
    not _TEST_IP,
    reason="set CONDUIT_TEST_IP=<device> to run the live WS integration tests",
)


@needs_device
def test_http_ws_handshake_and_auth():
    """End-to-end protocol smoke: GET /api/stream, send auth frame,
    expect a STATUS frame back within the listen window."""
    result = ws_probe.probe(
        host=_TEST_IP,
        port=80,
        token=_TEST_TOKEN,
        use_tls=False,
        duration_s=4.0,
    )
    assert result.handshake_ok, f"handshake failed: {result.errors}"
    assert result.notice_seen, "expected pre-auth NOTICE need_auth"
    assert result.auth_ok, f"auth failed: {result.last_cmd_reply}"
    assert result.status_seen, f"no STATUS frame received: {result.errors}"
    assert result.last_status is not None
    # The status JSON should have the same shape /api/status returns.
    for key in ("version", "partition", "uptime", "link", "device"):
        assert key in result.last_status, f"status missing {key}"
    assert result.last_status["device"] == "conduit"


@needs_device
def test_idle_stream_emits_data_keepalive():
    """The firmware emits a 16-byte zero-payload DATA record on the
    'D' channel every WS_KEEPALIVE_MS (500 ms) when both rings are
    idle. Over a 4-second window we should see several."""
    result = ws_probe.probe(
        host=_TEST_IP,
        port=80,
        token=_TEST_TOKEN,
        use_tls=False,
        duration_s=4.0,
    )
    assert result.handshake_ok and result.auth_ok
    assert result.keepalive_seen, (
        f"no idle keepalive DATA frame in 4 s — got {result.data_bytes} data bytes"
    )
    # 16-byte record × ~8 ticks per 4 s (500 ms cadence) ≈ 128 B. Allow
    # slack: at minimum we should see one record (16 B).
    assert result.data_bytes >= 16


@needs_device
def test_tls_path_matches_http_path():
    """The TLS endpoint should behave identically to plain HTTP — same
    handshake, same auth, same channels."""
    result = ws_probe.probe(
        host=_TEST_IP,
        port=443,
        token=_TEST_TOKEN,
        use_tls=True,
        duration_s=4.0,
    )
    assert result.handshake_ok, f"TLS handshake failed: {result.errors}"
    assert result.auth_ok, f"TLS auth failed: {result.last_cmd_reply}"
    assert result.status_seen, f"no STATUS over TLS: {result.errors}"
    assert result.keepalive_seen


@needs_device
def test_bad_token_rejected():
    """Wrong token → auth_ok stays false, cmd reply carries error,
    no STATUS frame."""
    result = ws_probe.probe(
        host=_TEST_IP,
        port=80,
        token="definitely-not-the-token",
        use_tls=False,
        duration_s=3.0,
    )
    assert result.handshake_ok
    # The server replies with a cmd error and stays in the need-auth
    # gate; no STATUS frame ever lands.
    assert not result.auth_ok
    assert not result.status_seen
    assert result.last_cmd_reply is not None
    assert result.last_cmd_reply.get("ok") is False


@needs_device
def test_unknown_cmd_returns_error():
    """Authenticate, then send a CMD with a name that isn't registered.
    Expect {ok: false, error: 'unknown command'}."""
    # Open a raw connection so we can send a custom CMD frame after auth.
    sock = socket.create_connection((_TEST_IP, 80), timeout=10)
    try:
        leftover = ws_probe._http_upgrade(sock, _TEST_IP)
        # Auth.
        ws_probe._send_frame(
            sock,
            ws_probe.OP_TEXT,
            b"C" + f"seq=0&name=auth&token={_TEST_TOKEN}".encode("utf-8"),
        )
        # Spin until we see the auth reply land (we don't care about
        # other frames in between — log/data/status are fine).
        sock.settimeout(4.0)
        deadline_end = 4.0
        auth_seen = False
        for _ in range(50):
            fin, opcode, payload, leftover = ws_probe._read_frame(sock, leftover)
            if opcode == ws_probe.OP_TEXT and payload[:1] == b"C":
                auth_seen = True
                break
        assert auth_seen
        # Send an unknown-cmd request, seq=42.
        ws_probe._send_frame(
            sock,
            ws_probe.OP_TEXT,
            b"C" + b"seq=42&name=__definitely_not_registered__",
        )
        # Read frames until we get a CMD reply with seq=42.
        reply = None
        for _ in range(100):
            fin, opcode, payload, leftover = ws_probe._read_frame(sock, leftover)
            if opcode != ws_probe.OP_TEXT or payload[:1] != b"C":
                continue
            import json as _json
            obj = _json.loads(payload[1:].decode("utf-8"))
            if obj.get("seq") == 42:
                reply = obj
                break
        assert reply is not None
        assert reply.get("ok") is False
        assert "unknown" in (reply.get("error") or "").lower()
    finally:
        try:
            ws_probe._send_frame(sock, ws_probe.OP_CLOSE, struct.pack(">H", 1000))
        except OSError:
            pass
        sock.close()


# ── Helpers for the offline frame-mechanics tests ────────────────────


def _local_unmasked_pair() -> tuple[socket.socket, socket.socket]:
    """Create a connected socketpair so we can drive the read/decode
    helpers without a real network."""
    a, b = socket.socketpair()
    return a, b


def test_read_frame_decodes_short_payload():
    sender, recver = _local_unmasked_pair()
    # Build a small server frame: FIN=1, opcode=TEXT, no mask, len=5
    sender.sendall(bytes([0x81, 5]) + b"hello")
    fin, opcode, payload, leftover = ws_probe._read_frame(recver, b"")
    assert fin == 1
    assert opcode == ws_probe.OP_TEXT
    assert payload == b"hello"
    assert leftover == b""
    sender.close()
    recver.close()


def test_read_frame_decodes_16bit_length():
    sender, recver = _local_unmasked_pair()
    body = b"X" * 300
    sender.sendall(bytes([0x82, 126]) + struct.pack(">H", 300) + body)
    fin, opcode, payload, leftover = ws_probe._read_frame(recver, b"")
    assert opcode == ws_probe.OP_BIN
    assert len(payload) == 300
    assert payload == body
    sender.close()
    recver.close()


def test_read_frame_uses_prebuffer_before_socket():
    """If the Upgrade response landed with frame bytes piggybacked,
    those go into `prebuf` and must be consumed first."""
    sender, recver = _local_unmasked_pair()
    # Pretend all 7 bytes (header + body) arrived in the prebuffer;
    # the socket is empty.
    pre = bytes([0x81, 5]) + b"world"
    fin, opcode, payload, leftover = ws_probe._read_frame(recver, pre)
    assert opcode == ws_probe.OP_TEXT
    assert payload == b"world"
    assert leftover == b""
    sender.close()
    recver.close()


def test_send_frame_masks_client_to_server_payload():
    """A client→server frame MUST have the MASK bit set and the
    payload XOR'd with the 4-byte mask key. The recipient (a server)
    will reject unmasked frames per RFC 6455 §5.1 — which we rely on
    the firmware's WS_RX_NEED_HDR2 check enforcing."""
    sender, recver = _local_unmasked_pair()
    payload = b"D" + b"\xFE\x01\x00\x00\x01\x00\x00\x00" + b"\x00" * 8 + b"\x42"
    ws_probe._send_frame(sender, ws_probe.OP_BIN, payload)

    # Read what landed on the wire.
    blob = recver.recv(4096)
    sender.close()
    recver.close()

    assert blob[0] == 0x80 | ws_probe.OP_BIN  # FIN + BIN
    # MASK bit set on byte 1
    assert (blob[1] & 0x80) == 0x80
    # 7-bit length present (small payload)
    n = blob[1] & 0x7F
    assert n == len(payload)
    mask = blob[2:6]
    masked = blob[6 : 6 + n]
    # Reverse the mask and compare.
    unmasked = bytes(b ^ mask[i & 3] for i, b in enumerate(masked))
    assert unmasked == payload
