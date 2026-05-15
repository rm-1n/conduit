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
