"""Unit tests for conduit_cli.discover.

The listener is split from the CLI subcommand so we can drive it
with a fake socket that returns canned packets — no real network
I/O in CI. The CLI test wires the same fake through Click's
CliRunner.
"""

from __future__ import annotations

import json
import socket
from collections.abc import Iterable

import pytest
from click.testing import CliRunner

from conduit_cli import cli, discover


# ── Fake socket ─────────────────────────────────────────────────────


class FakeMulticastSocket:
    """Minimal socket-like that yields a queued list of packets.

    Each ``recvfrom`` either returns the next queued ``(bytes, addr)``
    tuple, or raises ``socket.timeout`` if the queue is empty — which
    matches the behaviour the listener loops on in production.
    """

    def __init__(self, packets: Iterable[tuple[bytes, tuple[str, int]]]):
        self._queue = list(packets)
        self.closed = False

    def settimeout(self, _t: float) -> None:  # called by listener; no-op
        pass

    def recvfrom(self, _buflen: int):
        if not self._queue:
            raise socket.timeout
        return self._queue.pop(0)

    def close(self) -> None:
        self.closed = True


def _beacon(uid: str, ip: str, name: str = "", version: str = "1.2.0",
            src: tuple[str, int] | None = None) -> tuple[bytes, tuple[str, int]]:
    payload = json.dumps({"id": uid, "ip": ip, "name": name, "v": version})
    return payload.encode(), (src or (ip, 5354))


# ── listen_for_devices ──────────────────────────────────────────────


def test_listen_yields_one_per_packet():
    pkts = [
        _beacon("cond-aaa", "192.168.1.10"),
        _beacon("cond-bbb", "192.168.1.11"),
        _beacon("cond-aaa", "192.168.1.10"),  # duplicate id → still yielded
    ]
    sock = FakeMulticastSocket(pkts)
    out = list(discover.listen_for_devices(timeout_s=0.5, recv_factory=lambda: sock))
    assert [d.unique_id for d in out] == ["cond-aaa", "cond-bbb", "cond-aaa"]
    assert sock.closed, "socket should be closed when the listener exits"


def test_listen_drops_malformed():
    pkts = [
        (b"not json", ("192.168.1.10", 5354)),
        _beacon("cond-good", "192.168.1.11"),
        (b"{}", ("192.168.1.12", 5354)),                # missing id
        (b'{"id": ""}', ("192.168.1.13", 5354)),        # empty id
        (b'{"id": "cond-x", "ip": 42}', ("192.168.1.14", 5354)),  # falls back to src
    ]
    sock = FakeMulticastSocket(pkts)
    out = list(discover.listen_for_devices(timeout_s=0.5, recv_factory=lambda: sock))
    ids = [d.unique_id for d in out]
    assert ids == ["cond-good", "cond-x"]
    # Numeric ip in payload → fall back to packet source
    assert out[1].ip == "192.168.1.14"


def test_listen_returns_empty_on_silent_lan():
    sock = FakeMulticastSocket([])
    out = list(discover.listen_for_devices(timeout_s=0.5, recv_factory=lambda: sock))
    assert out == []


# ── collect_unique_devices ──────────────────────────────────────────


def test_collect_dedupes_by_id_keeping_latest():
    pkts = [
        _beacon("cond-a", "192.168.1.10", name="old", version="1.0.0"),
        _beacon("cond-b", "192.168.1.20"),
        _beacon("cond-a", "192.168.1.10", name="new", version="1.2.0"),
    ]
    sock = FakeMulticastSocket(pkts)
    out = discover.collect_unique_devices(timeout_s=0.5, recv_factory=lambda: sock)
    by_id = {d.unique_id: d for d in out}
    assert set(by_id) == {"cond-a", "cond-b"}
    # The latest beacon wins — that's "new" / 1.2.0
    assert by_id["cond-a"].name == "new"
    assert by_id["cond-a"].version == "1.2.0"


# ── CLI subcommand ──────────────────────────────────────────────────


def test_discover_cli_table_output(monkeypatch):
    pkts = [_beacon("cond-table", "192.168.1.50", name="lab", version="1.2.0")]
    monkeypatch.setattr(
        cli._discover, "collect_unique_devices",
        lambda timeout_s, **_: list(discover.listen_for_devices(
            timeout_s=timeout_s,
            recv_factory=lambda: FakeMulticastSocket(pkts),
        )),
    )
    res = CliRunner().invoke(cli.main, ["discover", "--timeout", "0.5"])
    assert res.exit_code == 0, res.output
    assert "Found 1 device" in res.output
    assert "cond-table" in res.output
    assert "192.168.1.50" in res.output
    assert "1.2.0" in res.output


def test_discover_cli_json_output(monkeypatch):
    pkts = [
        _beacon("cond-x", "192.168.1.5"),
        _beacon("cond-y", "192.168.1.6", name="board2"),
    ]
    monkeypatch.setattr(
        cli._discover, "collect_unique_devices",
        lambda timeout_s, **_: list(discover.listen_for_devices(
            timeout_s=timeout_s,
            recv_factory=lambda: FakeMulticastSocket(pkts),
        )),
    )
    res = CliRunner().invoke(cli.main, ["discover", "-t", "0.5", "--json"])
    assert res.exit_code == 0, res.output
    payload = json.loads(res.output)
    assert {d["id"] for d in payload} == {"cond-x", "cond-y"}
    assert all("age_s" in d for d in payload)


def test_discover_cli_empty(monkeypatch):
    monkeypatch.setattr(
        cli._discover, "collect_unique_devices",
        lambda timeout_s, **_: [],
    )
    res = CliRunner().invoke(cli.main, ["discover", "-t", "0.5"])
    assert res.exit_code == 0
    assert "No devices heard" in res.output


