"""Tests for the `conduit provision` command surface.

Pattern follows test_cli.py: drive the CLI with click's CliRunner and
monkeypatch the dev module so no picotool, network, or flash actually
runs. The integration with real hardware is exercised manually against
a connected dev board.
"""

import pytest
from click.testing import CliRunner

from conduit_cli import cli, dev


@pytest.fixture
def stub_firmware_paths(monkeypatch):
    """Skip cmake build + return placeholder UF2 paths so the
    provision command runs through end-to-end without a firmware
    tree present."""
    monkeypatch.setattr(dev, "build_firmware", lambda *a, **kw: None)
    monkeypatch.setattr(dev, "firmware_uf2_paths", lambda *a, **kw: (
        "/tmp/fake-pt.uf2", "/tmp/fake-app.uf2", "/tmp/fake-app-tbyb.uf2",
    ))


@pytest.fixture
def stub_provision_clean(monkeypatch):
    """Record every provision_clean call so a test can assert which
    args the CLI passed through."""
    log = []

    def fake_clean(*args, **kwargs):
        log.append({"args": args, "kwargs": kwargs})
        return True

    monkeypatch.setattr(dev, "provision_clean", fake_clean)
    return log


def test_provision_calls_provision_clean(stub_firmware_paths, stub_provision_clean):
    runner = CliRunner()
    result = runner.invoke(cli.main, ["provision", "-d", "10.0.0.5"])
    assert result.exit_code == 0, result.output
    assert len(stub_provision_clean) == 1
    args = stub_provision_clean[0]["args"]
    # provision_clean(picotool, pt_uf2, app_uf2, ip)
    assert args[1] == "/tmp/fake-pt.uf2"
    assert args[2] == "/tmp/fake-app.uf2"
    assert args[3] == "10.0.0.5"


def test_provision_uses_default_device_ip(stub_firmware_paths, stub_provision_clean):
    runner = CliRunner()
    result = runner.invoke(cli.main, ["provision"])
    assert result.exit_code == 0, result.output
    assert stub_provision_clean[0]["args"][3] == dev.DEFAULT_DEVICE_IP


def test_provision_propagates_failure(stub_firmware_paths, monkeypatch):
    monkeypatch.setattr(dev, "provision_clean", lambda *a, **kw: False)
    result = CliRunner().invoke(cli.main, ["provision", "-d", "10.0.0.5"])
    assert result.exit_code == 1


def test_provision_skip_build_skips_cmake(stub_provision_clean, monkeypatch):
    """--skip-build means build_firmware is never invoked."""
    called = []
    monkeypatch.setattr(dev, "build_firmware", lambda *a, **kw: called.append(True))
    monkeypatch.setattr(dev, "firmware_uf2_paths", lambda *a, **kw: (
        "/tmp/pt.uf2", "/tmp/app.uf2", "/tmp/tbyb.uf2",
    ))
    result = CliRunner().invoke(cli.main, ["provision", "--skip-build", "-d", "10.0.0.5"])
    assert result.exit_code == 0, result.output
    assert called == []
    assert len(stub_provision_clean) == 1


def test_provision_rejects_identity_flags(stub_firmware_paths, stub_provision_clean):
    """The leaked --identity / --issuance-token / etc. flags were stripped
    when device commissioning moved to the private commission tool. If
    they reappear, this test fails to flag the regression.
    """
    runner = CliRunner()
    for stripped in ("--identity", "--no-identity", "--issuance-token", "--issuance-url",
                     "--cache-dir", "--unique-id", "--force-refresh"):
        result = runner.invoke(cli.main, ["provision", stripped, "x"])
        assert result.exit_code != 0, (
            f"`provision {stripped}` should be rejected by Click — these flags "
            f"were intentionally removed when provisioning moved to the private "
            f"`commission` CLI. Output was:\n{result.output}"
        )
        assert "no such option" in result.output.lower() or "unexpected" in result.output.lower()
