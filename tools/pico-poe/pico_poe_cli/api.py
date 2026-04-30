"""HTTP client for PICO-POE device REST API."""

# PEP 563 — defers annotation evaluation so PEP 604 syntax (`dict | None`,
# `list[dict]`) parses cleanly on Python 3.9. Without this the function
# defs in scan_subnet raise TypeError at import time on 3.9.
from __future__ import annotations

import httpx

DEFAULT_TIMEOUT = 5.0
UPLOAD_TIMEOUT = 120.0


class PicoPoEDevice:
    def __init__(self, ip: str, token: str = ""):
        self.base = f"http://{ip}"
        self.token = token

    def _headers(self) -> dict:
        h = {}
        if self.token:
            h["X-Auth-Token"] = self.token
        return h

    def status(self) -> dict:
        r = httpx.get(f"{self.base}/api/status", timeout=DEFAULT_TIMEOUT)
        r.raise_for_status()
        return r.json()

    def upload(self, data: bytes, progress_cb=None) -> dict:
        headers = self._headers()
        headers["Content-Type"] = "application/octet-stream"
        r = httpx.post(
            f"{self.base}/api/upload",
            content=data,
            headers=headers,
            timeout=UPLOAD_TIMEOUT,
        )
        r.raise_for_status()
        return r.json()

    def reboot(self) -> dict:
        r = httpx.post(
            f"{self.base}/api/reboot",
            headers=self._headers(),
            timeout=DEFAULT_TIMEOUT,
        )
        r.raise_for_status()
        return r.json()

    def command(self, name: str, **args) -> dict:
        """POST /api/cmd?name=<name>&<args>. Returns the parsed JSON body.

        Args are stringified and URL-encoded by httpx via the params kwarg.
        Auth token is sent as X-Auth-Token (required by the device unless
        the firmware was built without one).
        """
        params = {"name": name}
        for k, v in args.items():
            if v is None:
                continue
            params[k] = str(v)
        r = httpx.post(
            f"{self.base}/api/cmd",
            params=params,
            headers=self._headers(),
            timeout=DEFAULT_TIMEOUT,
        )
        r.raise_for_status()
        return r.json()


def scan_subnet(subnet: str, timeout: float = 2.0) -> list[dict]:
    """Scan a /24 subnet for PICO-POE devices. Returns list of status dicts."""
    import asyncio

    async def _probe(client: httpx.AsyncClient, ip: str) -> dict | None:
        try:
            r = await client.get(f"http://{ip}/api/status", timeout=timeout)
            if r.status_code == 200:
                d = r.json()
                d["_ip"] = ip
                return d
        except (httpx.HTTPError, httpx.TimeoutException, Exception):
            pass
        return None

    async def _scan():
        async with httpx.AsyncClient() as client:
            tasks = [_probe(client, f"{subnet}.{i}") for i in range(1, 255)]
            results = await asyncio.gather(*tasks)
            return [r for r in results if r is not None]

    return asyncio.run(_scan())
