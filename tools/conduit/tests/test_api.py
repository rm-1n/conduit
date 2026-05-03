"""Unit tests for conduit_cli.api — the HTTP wrapper around /api/*.

The api module is thin enough that tests are essentially "did we send
the right request?" — captured via monkeypatched httpx callables.
"""

import json
import httpx
import pytest

from conduit_cli import api


# ── Helpers ──────────────────────────────────────────────────────────


class FakeResponse:
    """Minimal httpx.Response stand-in returned by the patched httpx fns."""

    def __init__(self, status_code=200, json_body=None, text=""):
        self.status_code = status_code
        self._json = json_body
        self.text = text

    def json(self):
        if self._json is None:
            raise json.JSONDecodeError("no body", "", 0)
        return self._json

    def raise_for_status(self):
        if 400 <= self.status_code < 600:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=httpx.Request("GET", "http://x/"),
                response=httpx.Response(self.status_code),
            )


class CallRecorder:
    """Drop-in replacement for httpx.get / httpx.post that records the
    call arguments and returns a configurable FakeResponse."""

    def __init__(self, response: FakeResponse):
        self.response = response
        self.calls: list[dict] = []

    def __call__(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        return self.response


# ── status() ─────────────────────────────────────────────────────────


def test_status_sends_correct_url(monkeypatch):
    rec = CallRecorder(FakeResponse(200, {"version": "1.2.0", "ip": "10.0.0.5"}))
    monkeypatch.setattr(httpx, "get", rec)

    dev = api.ConduitDevice("10.0.0.5", token="anytoken")
    out = dev.status()

    assert out["version"] == "1.2.0"
    assert len(rec.calls) == 1
    assert rec.calls[0]["url"] == "http://10.0.0.5/api/status"
    # status() does not require auth — token must NOT be in headers
    assert "headers" not in rec.calls[0] or "X-Auth-Token" not in (rec.calls[0].get("headers") or {})
    assert rec.calls[0]["timeout"] == api.DEFAULT_TIMEOUT


def test_status_propagates_http_error(monkeypatch):
    monkeypatch.setattr(httpx, "get", CallRecorder(FakeResponse(503, None)))
    dev = api.ConduitDevice("10.0.0.5")
    with pytest.raises(httpx.HTTPStatusError):
        dev.status()


# ── command() ────────────────────────────────────────────────────────


def test_command_builds_query_with_name_and_args(monkeypatch):
    rec = CallRecorder(FakeResponse(200, {"ok": True, "result": 42}))
    monkeypatch.setattr(httpx, "post", rec)

    dev = api.ConduitDevice("10.0.0.5", token="changeme")
    out = dev.command("set_amp", value=1.5, channel=0)

    assert out == {"ok": True, "result": 42}
    assert rec.calls[0]["url"] == "http://10.0.0.5/api/cmd"
    assert rec.calls[0]["params"]["name"] == "set_amp"
    assert rec.calls[0]["params"]["value"] == "1.5"
    assert rec.calls[0]["params"]["channel"] == "0"
    # Auth header is required for /api/cmd
    assert rec.calls[0]["headers"]["X-Auth-Token"] == "changeme"


def test_command_drops_none_args(monkeypatch):
    rec = CallRecorder(FakeResponse(200, {"ok": True}))
    monkeypatch.setattr(httpx, "post", rec)
    dev = api.ConduitDevice("10.0.0.5", token="t")
    dev.command("foo", a=1, b=None, c="hello")
    p = rec.calls[0]["params"]
    assert "b" not in p
    assert p["a"] == "1"
    assert p["c"] == "hello"


def test_command_omits_auth_header_when_no_token(monkeypatch):
    rec = CallRecorder(FakeResponse(200, {"ok": True}))
    monkeypatch.setattr(httpx, "post", rec)
    dev = api.ConduitDevice("10.0.0.5")  # no token
    dev.command("ping")
    headers = rec.calls[0]["headers"]
    assert "X-Auth-Token" not in headers


# ── upload() ─────────────────────────────────────────────────────────


def test_upload_sends_octet_stream_with_extended_timeout(monkeypatch):
    rec = CallRecorder(FakeResponse(200, {"status": "ok"}))
    monkeypatch.setattr(httpx, "post", rec)
    dev = api.ConduitDevice("10.0.0.5", token="t")

    payload = b"\x55" * 4096
    out = dev.upload(payload)

    assert out == {"status": "ok"}
    call = rec.calls[0]
    assert call["url"] == "http://10.0.0.5/api/upload"
    assert call["content"] == payload
    assert call["headers"]["X-Auth-Token"] == "t"
    assert call["headers"]["Content-Type"] == "application/octet-stream"
    # Upload uses the longer 120 s timeout (firmware OTA can take time)
    assert call["timeout"] == api.UPLOAD_TIMEOUT


# ── reboot() ─────────────────────────────────────────────────────────


def test_reboot_sends_post_with_auth(monkeypatch):
    rec = CallRecorder(FakeResponse(200, {"ok": True}))
    monkeypatch.setattr(httpx, "post", rec)
    dev = api.ConduitDevice("10.0.0.5", token="t")
    dev.reboot()
    assert rec.calls[0]["url"] == "http://10.0.0.5/api/reboot"
    assert rec.calls[0]["headers"]["X-Auth-Token"] == "t"


# ── headers helper ───────────────────────────────────────────────────


def test_headers_are_pure():
    """Sanity check on the auth-header construction:
    no token → empty dict; with token → only X-Auth-Token set."""
    assert api.ConduitDevice("ip")._headers() == {}
    assert api.ConduitDevice("ip", "t")._headers() == {"X-Auth-Token": "t"}
