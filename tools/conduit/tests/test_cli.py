"""Unit tests for conduit_cli.cli — the click command surface.

We use click.testing.CliRunner to invoke commands as a user would,
and patch out the api module so no real HTTP is attempted.
"""

import json
import httpx
import pytest
from click.testing import CliRunner

from conduit_cli import cli


# ── Test doubles ─────────────────────────────────────────────────────


class FakeDevice:
    """Stand-in for ConduitDevice. Records every call + lets each
    method be overridden per-test via the `responses` dict."""

    instances: list["FakeDevice"] = []

    def __init__(self, ip, token=""):
        self.ip = ip
        self.token = token
        self.calls = []
        FakeDevice.instances.append(self)

    @classmethod
    def reset(cls):
        cls.instances = []

    def status(self):
        self.calls.append(("status",))
        return {"version": "1.2.0", "ip": self.ip, "mac": "AA:BB:CC:DD:EE:FF",
                "uptime": 42, "link": True, "poe": True,
                "partition": "A", "board_id": "abcd1234"}

    def upload(self, data, progress_cb=None):
        self.calls.append(("upload", len(data)))
        return {"status": "ok"}

    def reboot(self):
        self.calls.append(("reboot",))
        return {"ok": True}

    def command(self, name, **args):
        self.calls.append(("command", name, args))
        return {"ok": True, "result": args}


@pytest.fixture(autouse=True)
def stub_device(monkeypatch):
    """Every test runs with ConduitDevice swapped for FakeDevice."""
    FakeDevice.reset()
    monkeypatch.setattr(cli, "ConduitDevice", FakeDevice)
    yield
    FakeDevice.reset()


# ── status command ──────────────────────────────────────────────────


def test_status_prints_fields():
    runner = CliRunner()
    res = runner.invoke(cli.main, ["status", "-d", "10.0.0.5"])
    assert res.exit_code == 0, res.output
    assert "Version:" in res.output
    assert "1.2.0" in res.output
    assert "Link:" in res.output and "Up" in res.output
    # FakeDevice.calls[0] should be ("status",)
    assert FakeDevice.instances[0].calls == [("status",)]


def test_status_requires_device_flag():
    res = CliRunner().invoke(cli.main, ["status"])
    assert res.exit_code != 0
    assert "--device" in res.output or "device" in res.output.lower()


def test_status_handles_network_error(monkeypatch):
    def fail(self):
        raise httpx.ConnectError("nope", request=httpx.Request("GET", "http://x"))
    monkeypatch.setattr(FakeDevice, "status", fail)
    res = CliRunner().invoke(cli.main, ["status", "-d", "10.0.0.5"])
    assert res.exit_code == 1
    assert "Error" in res.output


def test_status_stays_quiet_when_no_anomalies(monkeypatch):
    """No data-ring evictions and no stream-close events → no extra lines.
    This is the steady-state, so any noise here would train users to
    ignore the section that actually matters during a real incident."""
    def healthy(self):
        return {"version": "1.2.0", "binary_version": "10.80",
                "ip": self.ip, "mac": "AA:BB:CC:DD:EE:FF",
                "uptime": 42, "link": True, "poe": True,
                "partition": "B", "board_id": "abcd1234",
                "data_ring_evictions": 0, "data_ring_evicted_bytes": 0,
                "stream_close_recv_eof": 0, "stream_close_recv_err": 0,
                "stream_close_err_rst": 0, "stream_close_err_abrt": 0,
                "stream_close_err_clsd": 0, "stream_close_err_other": 0,
                "stream_close_write_err": 0,
                "stream_close_ws_parse_fail": 0,
                "stream_close_link_down": 0,
                "stream_last_close_err": 0, "stream_last_close_age_ms": 0,
                "streams_open": 2}
    monkeypatch.setattr(FakeDevice, "status", healthy)
    res = CliRunner().invoke(cli.main, ["status", "-d", "10.0.0.5"])
    assert res.exit_code == 0, res.output
    assert "binary 10.80" in res.output
    assert "Data ring:" not in res.output
    assert "Closes:" not in res.output
    # streams_open still shown so the operator can confirm both
    # IDE channels are tracked when none of them is broken.
    assert "Streams:   2 open" in res.output


def test_status_surfaces_stream_close_buckets(monkeypatch):
    """Non-zero close-cause counters surface with the lwIP err code and
    the age of the most recently closed conn — that's the primary
    diagnostic for 'WS dropped after N min, no close frame, why?'."""
    def unhealthy(self):
        return {"version": "1.2.0", "binary_version": "10.80",
                "ip": self.ip, "mac": "AA:BB:CC:DD:EE:FF",
                "uptime": 12345, "link": True, "poe": False,
                "partition": "B", "board_id": "abcd1234",
                "data_ring_evictions": 3, "data_ring_evicted_bytes": 4096,
                "stream_close_recv_eof": 0, "stream_close_recv_err": 0,
                "stream_close_err_rst": 1, "stream_close_err_abrt": 4,
                "stream_close_err_clsd": 0, "stream_close_err_other": 0,
                "stream_close_write_err": 0,
                "stream_close_ws_parse_fail": 0,
                "stream_close_link_down": 0,
                "stream_last_close_err": -13,
                "stream_last_close_age_ms": 1369158,
                "streams_open": 1}
    monkeypatch.setattr(FakeDevice, "status", unhealthy)
    res = CliRunner().invoke(cli.main, ["status", "-d", "10.0.0.5"])
    assert res.exit_code == 0, res.output
    assert "Data ring: 3 evictions, 4096 bytes lost" in res.output
    assert "err_abrt=4" in res.output and "err_rst=1" in res.output
    # The two buckets without a non-zero count must not appear.
    assert "err_clsd" not in res.output
    assert "ws_parse_fail" not in res.output
    # Age is rendered in seconds with one decimal so a 22-min lifetime
    # is glanceable vs a 30-s one without manual ms→min conversion.
    assert "age=1369.2s" in res.output and "err=-13" in res.output


def test_status_json_flag_emits_raw_dict():
    res = CliRunner().invoke(cli.main, ["status", "-d", "10.0.0.5", "--json"])
    assert res.exit_code == 0, res.output
    parsed = json.loads(res.output)
    assert parsed["version"] == "1.2.0"
    assert parsed["partition"] == "A"


def test_status_surfaces_phase0_diag_fields(monkeypatch):
    """Phase 0 wedge-attribution: pool usage, PCB census, drop counters,
    mbedtls slab exhaustion, liveness triplet. Each block stays quiet
    unless something is interesting, but the liveness triplet always
    shows so two successive calls can confirm 'still running'."""
    def diag(self):
        return {"version": "1.2.0", "binary_version": "10.82",
                "ip": self.ip, "mac": "AA:BB:CC:DD:EE:FF",
                "uptime": 600, "link": True, "poe": False,
                "partition": "A", "board_id": "abcd1234",
                "core1_iter": 1234567, "http_poll_fires": 9876,
                "http_accepts": 42, "http_streams_started": 7,
                "pbuf_used": 12, "pbuf_max": 64,
                "tcp_pcb_used": 4, "tcp_pcb_max": 24,
                "sys_timeout_used": 16, "sys_timeout_max": 16,
                "tcp_pcbs_active": 3, "tcp_pcbs_timewait": 1,
                "tcp_pcbs_listen": 2,
                "ip_drops": 5, "tcp_drops": 0, "tcp_errs": 0, "tcp_chkerrs": 0,
                "mbedtls_slab_exhausted_in": 0,
                "mbedtls_slab_exhausted_out": 2,
                "streams_open": 1,
                # All stream_close_* zero so the existing close-cause
                # block stays silent; we're isolating the diag fields.
                "stream_close_recv_eof": 0, "stream_close_recv_err": 0,
                "stream_close_err_rst": 0, "stream_close_err_abrt": 0,
                "stream_close_err_clsd": 0, "stream_close_err_other": 0,
                "stream_close_write_err": 0,
                "stream_close_ws_parse_fail": 0,
                "stream_close_link_down": 0}
    monkeypatch.setattr(FakeDevice, "status", diag)
    res = CliRunner().invoke(cli.main, ["status", "-d", "10.0.0.5"])
    assert res.exit_code == 0, res.output
    # Pool fill-levels visible
    assert "pbuf 12/64" in res.output
    assert "tcp_pcb 4/24" in res.output
    # sys_timeout at max — the smoking gun for tcp_tmr reschedule failure
    assert "sys_timeout 16/16" in res.output
    # PCB census
    assert "active=3" in res.output and "listen=2" in res.output
    # Only non-zero drop counters shown
    assert "ip_drops=5" in res.output
    assert "tcp_drops" not in res.output  # zero, suppressed
    # mbedtls exhaustion surfaced
    assert "exhausted in=0 out=2" in res.output
    # Liveness triplet always shown
    assert "core1_iter=1234567" in res.output
    assert "poll_fires=9876" in res.output
    assert "accepts=42" in res.output


def test_status_diag_quiet_when_nothing_interesting(monkeypatch):
    """Healthy device: pools well below max, no drops, no slab exhaust.
    Should suppress pool/drop/slab lines but still show liveness."""
    def healthy(self):
        return {"version": "1.2.0", "binary_version": "10.82",
                "ip": self.ip, "mac": "AA:BB:CC:DD:EE:FF",
                "uptime": 60, "link": True, "poe": False,
                "partition": "A", "board_id": "abcd1234",
                "core1_iter": 500, "http_poll_fires": 100,
                "http_accepts": 5, "http_streams_started": 1,
                "pbuf_used": 4, "pbuf_max": 64,
                "tcp_pcb_used": 3, "tcp_pcb_max": 24,
                "sys_timeout_used": 2, "sys_timeout_max": 16,
                "tcp_pcbs_active": 1, "tcp_pcbs_timewait": 0,
                "tcp_pcbs_listen": 2,
                "ip_drops": 0, "tcp_drops": 0, "tcp_errs": 0, "tcp_chkerrs": 0,
                "mbedtls_slab_exhausted_in": 0,
                "mbedtls_slab_exhausted_out": 0,
                "streams_open": 1,
                "stream_close_recv_eof": 0, "stream_close_recv_err": 0,
                "stream_close_err_rst": 0, "stream_close_err_abrt": 0,
                "stream_close_err_clsd": 0, "stream_close_err_other": 0,
                "stream_close_write_err": 0,
                "stream_close_ws_parse_fail": 0,
                "stream_close_link_down": 0}
    monkeypatch.setattr(FakeDevice, "status", healthy)
    res = CliRunner().invoke(cli.main, ["status", "-d", "10.0.0.5"])
    assert res.exit_code == 0, res.output
    # Pools section still shows fill levels — they're always informative
    # even when low. (If we ever want to quiet them at low fill the test
    # tightens.)
    assert "pbuf 4/64" in res.output
    # Drops line is suppressed when all counters zero
    assert "Drops:" not in res.output
    # mbedtls line suppressed when zero
    assert "mbedtls:" not in res.output
    # Liveness triplet always shown
    assert "core1_iter=500" in res.output


# ── cmd command ──────────────────────────────────────────────────────


def test_cmd_with_kv_args():
    runner = CliRunner()
    res = runner.invoke(cli.main, [
        "cmd", "set_amp", "value=1.5", "channel=0",
        "-d", "10.0.0.5", "-t", "changeme",
    ])
    assert res.exit_code == 0, res.output
    body = json.loads(res.output)
    assert body == {"ok": True, "result": {"value": "1.5", "channel": "0"}}
    # The api was called with the parsed kwargs
    last = FakeDevice.instances[0].calls[-1]
    assert last[0] == "command"
    assert last[1] == "set_amp"
    assert last[2] == {"value": "1.5", "channel": "0"}


def test_cmd_without_args():
    runner = CliRunner()
    res = runner.invoke(cli.main, [
        "cmd", "led_on", "-d", "10.0.0.5", "-t", "t",
    ])
    assert res.exit_code == 0, res.output
    last = FakeDevice.instances[0].calls[-1]
    assert last == ("command", "led_on", {})


def test_cmd_rejects_arg_without_equals():
    runner = CliRunner()
    res = runner.invoke(cli.main, [
        "cmd", "do", "no_eq_here", "-d", "10.0.0.5", "-t", "t",
    ])
    assert res.exit_code == 2
    assert "k=v" in res.output


def test_cmd_exits_nonzero_when_device_returns_not_ok(monkeypatch):
    def fail_cmd(self, name, **args):
        return {"ok": False, "error": "bad pin"}
    monkeypatch.setattr(FakeDevice, "command", fail_cmd)
    runner = CliRunner()
    res = runner.invoke(cli.main, [
        "cmd", "gpio_init", "pin=99",
        "-d", "10.0.0.5", "-t", "t",
    ])
    assert res.exit_code == 1
    body = json.loads(res.output)
    assert body["ok"] is False


# ── reboot command ───────────────────────────────────────────────────


def test_reboot_calls_api():
    runner = CliRunner()
    res = runner.invoke(cli.main, ["reboot", "-d", "10.0.0.5", "-t", "t"])
    assert res.exit_code == 0, res.output
    assert FakeDevice.instances[0].calls == [("reboot",)]
    assert "Reboot" in res.output


# ── upload command ───────────────────────────────────────────────────


def test_upload_reads_file_and_streams(tmp_path):
    uf2 = tmp_path / "fw.uf2"
    payload = b"\xff" * 8192
    uf2.write_bytes(payload)
    runner = CliRunner()
    res = runner.invoke(cli.main, [
        "upload", "-d", "10.0.0.5", "-t", "t", "-f", str(uf2),
    ])
    assert res.exit_code == 0, res.output
    last = FakeDevice.instances[0].calls[-1]
    assert last == ("upload", len(payload))


def test_upload_rejects_missing_file(tmp_path):
    res = CliRunner().invoke(cli.main, [
        "upload", "-d", "10.0.0.5", "-t", "t", "-f", str(tmp_path / "missing.uf2"),
    ])
    assert res.exit_code != 0
    assert "does not exist" in res.output.lower() or "exist" in res.output.lower()


# ── scan command removed ─────────────────────────────────────────────


def test_scan_command_is_gone():
    """`conduit scan` was deprecated when `conduit discover` (multicast)
    landed; the /24 sweep was removed for the public release. If anyone
    re-adds it, this test catches the regression so we can intercept the
    discussion before it ships.
    """
    res = CliRunner().invoke(cli.main, ["scan", "-s", "192.168.1"])
    assert res.exit_code != 0
    # Click prints "No such command 'scan'." on an unknown subcommand.
    assert "scan" in res.output.lower() and "no such command" in res.output.lower()
