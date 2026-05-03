# CONDUIT OTA — integration guide

This document is for anyone writing a client (web page, CLI tool, scripts)
that updates CONDUIT firmware over the network.

It assumes the board is already provisioned (the first-install UF2 has been
flashed via BOOTSEL) and reachable on the LAN at a known IP.

## At a glance

- **Transport:** HTTP/1.1, plain text, no TLS.
- **Auth:** pre-shared token in the `X-Auth-Token` header. Default
  `"changeme"`, overridden at compile time with `-DCONDUIT_AUTH_TOKEN=...`.
- **Upload is chunked.** A single large POST overflows the RMII RX ring
  and hangs the device. Split the UF2 into `≤ 8 KB` chunks and send each
  as its own POST.
- **Rollback safety via TBYB.** An uploaded image only becomes the
  permanent boot choice after the client POSTs `/api/commit`. Any reset
  before that — watchdog, power cut, `/api/reboot` — rolls the device
  back to the previous partition on the next boot.
- **CORS + Private Network Access** headers are set, so a browser served
  from an HTTPS origin (e.g. GitHub Pages) can talk to the device on the
  LAN from user-initiated actions.

## Two UF2 variants

Both are produced by the same build (`firmware/build/app/`):

| File | Bootable on plain power-on? | Purpose |
|---|---|---|
| `conduit_app_initial.uf2` | yes | First install via BOOTSEL. |
| `conduit_app.uf2` | only via flash-update reboot | OTA payload. Carries the TBYB flag so a failed update is rolled back by the RP2350 bootrom. |

A partition-table UF2 is also produced at `firmware/build/bootloader/partition_table.uf2` — used once during the BOOTSEL provisioning sequence.

## HTTP API

### `OPTIONS *`

CORS preflight. The device responds with:

```
Access-Control-Allow-Origin: <configured>       # default "*"
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: X-Auth-Token, Content-Type, X-OTA-Start, X-OTA-Finish
Access-Control-Allow-Private-Network: true
Access-Control-Max-Age: 86400
```

### `GET /api/status`

No auth. Returns JSON:

```json
{
  "version": "1.0.17",
  "ip": "192.168.178.200",
  "mac": "B8:27:EB:91:77:01",
  "uptime": 42,
  "link": true,
  "poe": false,
  "partition": "A",            // "A", "B", or "-" (unpartitioned)
  "board_id": "29166ac0...",
  "ota_in_progress": false,
  "ota_bytes_written": 0,
  "rx_drops": 0,               // RMII ring drops since boot (should stay 0)
  "boot_type": "normal",       // "normal" | "flash_update" | "bootsel" | ...
  "tbyb_pending": false,       // true = update is unconfirmed, POST /api/commit
  "device": "conduit"
}
```

### `POST /api/upload`

Auth required. Body is a raw slice of the UF2 file (binary, not multipart).

The session is split across many requests. Each request declares its role
via headers:

| First chunk | `X-OTA-Start: 1` | Calls `ota_begin()` on the device. |
| Middle chunks | *(neither)* | Append bytes to the open session. |
| Last chunk | `X-OTA-Finish: 1` | Writes the last bytes, calls `ota_finish()`, reboots into the new image via `REBOOT2_FLAG_REBOOT_TYPE_FLASH_UPDATE`. |

A single chunk may set both `X-OTA-Start` and `X-OTA-Finish` for tiny uploads,
but for real UF2s always chunk.

**Constraints**

- Chunk body size: keep at or below `8 KiB`. Larger values hang the RMII
  NCE driver's receive ring. The CLI and the JS reference below use
  `8192`.
- `Content-Length` must be set on every chunk.
- The final response is typically *not* readable — the device reboots
  mid-TCP-close. Treat a `Connection reset` / timeout on the last chunk
  as success.

Intermediate chunks respond with `{"ok":true,"bytes_written":N}`. Errors
are HTTP 4xx/5xx with `{"error":"..."}`.

### `POST /api/commit`

Auth required. No body (`Content-Length: 0`). Call this after a successful
chunked upload, once `/api/status` reports the new version. Response:

| Body | Meaning |
|---|---|
| `{"ok":true,"committed":true}` | `rom_explicit_buy()` succeeded. The image is now permanent. |
| `{"ok":true,"committed":false,"message":"not in TBYB mode"}` | Nothing to commit (the device already booted a committed image or a non-TBYB image). Treat as success. |
| `{"ok":false,"error":"rom_explicit_buy failed"}` | ROM refused; a subsequent reboot rolls back. Retry later or accept the rollback. |

### `POST /api/reboot`

Auth required. Reboots the device normally. Useful to test rollback:
if `tbyb_pending: true` and you call `/api/reboot`, the next boot comes
up on the previous partition.

## End-to-end integration flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLIENT                │       DEVICE         │
├──────────────────────────────────────────┼──────────────────────┤
│ GET /api/status                          │                      │
│   remember status.version as v_pre       │                      │
│   require status.partition ∈ {A, B}      │                      │
│                                          │                      │
│ split uf2 into ~8KB chunks               │                      │
│ for chunk in chunks:                     │                      │
│   POST /api/upload                       │                      │
│     X-Auth-Token: <token>                │                      │
│     X-OTA-Start: 1  (first only)         │                      │
│     X-OTA-Finish: 1 (last only)          │                      │
│     body: <chunk bytes>                  │                      │
│   (ignore aborted connection on last one)│   device reboots     │
│                                          │                      │
│ poll GET /api/status                     │                      │
│   until it answers OR timeout            │                      │
│                                          │                      │
│ CASE 1 — success                         │                      │
│   version != v_pre                       │                      │
│   tbyb_pending == true                   │                      │
│   POST /api/commit                       │                      │
│     → {"committed":true}                 │  rom_explicit_buy    │
│   done                                   │                      │
│                                          │                      │
│ CASE 2 — rollback                        │                      │
│   version == v_pre, partition unchanged  │                      │
│   → the new image reset before commit.   │                      │
│     old firmware is still running.       │                      │
│   report failure; no commit call needed. │                      │
│                                          │                      │
│ CASE 3 — unreachable                     │                      │
│   status never answers                   │                      │
│   → device is wedged. Next power cycle   │                      │
│     will roll back to old firmware.      │                      │
└──────────────────────────────────────────┴──────────────────────┘
```

## JavaScript reference client

Minimal working integration, ~70 lines. Works from a browser (XHR/fetch)
or Node.

```javascript
const CHUNK_SIZE = 8 * 1024;

async function uploadAndCommit(ip, token, uf2File) {
  const pre = await getStatus(ip);
  if (!['A', 'B'].includes(pre.partition)) {
    throw new Error(`device not on A/B partition: ${pre.partition}`);
  }

  // Chunked upload
  const size = uf2File.size;
  const n = Math.ceil(size / CHUNK_SIZE) || 1;
  for (let i = 0; i < n; i++) {
    const chunk = uf2File.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const headers = {
      'X-Auth-Token': token,
      'Content-Type': 'application/octet-stream',
    };
    if (i === 0)     headers['X-OTA-Start']  = '1';
    if (i === n - 1) headers['X-OTA-Finish'] = '1';
    try {
      const res = await fetch(`http://${ip}/api/upload`, {
        method: 'POST',
        mode: 'cors',
        headers,
        body: chunk,
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`chunk ${i + 1}/${n} failed: HTTP ${res.status} ${msg}`);
      }
      try { await res.json(); } catch (_) {}
    } catch (e) {
      // Final chunk: device reboots mid-TCP-close. Expected.
      if (i === n - 1 && /network|fetch|load failed/i.test(String(e.message))) break;
      throw e;
    }
  }

  // Wait for reboot and verify
  const post = await waitForStatus(ip, 60_000);
  if (!post) throw new Error('device did not come back after upload');

  if (post.version === pre.version && post.partition === pre.partition) {
    throw new Error(`rollback: still on v${pre.version}/${pre.partition}`);
  }

  // Confirm with the uploading client — this is the only thing that
  // flips the new image from "on probation" to "permanent".
  if (post.tbyb_pending) {
    const commit = await fetch(`http://${ip}/api/commit`, {
      method: 'POST', mode: 'cors',
      headers: { 'X-Auth-Token': token, 'Content-Length': '0' },
    }).then(r => r.json());
    if (!commit.committed && !commit.ok) {
      throw new Error(`commit refused: ${JSON.stringify(commit)}`);
    }
  }
  return post;
}

async function getStatus(ip) {
  const r = await fetch(`http://${ip}/api/status`, { mode: 'cors' });
  if (!r.ok) throw new Error(`status HTTP ${r.status}`);
  return r.json();
}

async function waitForStatus(ip, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://${ip}/api/status`, {
        mode: 'cors',
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return await r.json();
    } catch (_) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}
```

## Safety guarantees

- **If the new image crashes/hangs during early boot**, the hardware
  watchdog fires within 4 s. The next boot skips the uncommitted TBYB
  image and runs the previous partition — the image you had working.
- **If the network between client and device drops after upload but
  before commit**, the device stays alive on the new image (main loop
  still pats the watchdog) until power is cycled. At power-up it rolls
  back.
- **If the update succeeds but the client dies before committing**,
  nothing is lost on the next reboot — the device falls back to the
  previous firmware, exactly as if the update had never happened.
- **Idempotency**: `/api/commit` is safe to call multiple times. Extra
  calls return `committed: false` with `ok: true`.

Consequence: the only way the new firmware becomes permanent is an
explicit POST to `/api/commit` from a client that has already confirmed
the new version is reachable. Reachable + committable by the same
network path a future OTA would take.

## Gotchas

- **Chunks must stay small.** 8 KiB in testing is fine; 16 KiB–32 KiB
  sometimes works but is not safe. Do not send the whole UF2 at once.
- **Chunk-1 must carry `X-OTA-Start`**, chunk-N must carry
  `X-OTA-Finish`, or the device returns `409 Conflict: no OTA session
  in progress`.
- **`/api/upload` body is raw binary**, not multipart, not base64.
- **Final-chunk connection reset is expected.** The device reboots
  inside the response. Browsers fire a `TypeError` ("network error",
  "load failed"); Python raises `RemoteDisconnected`. Treat any
  network-layer error on the last chunk as success and poll
  `/api/status` to confirm.
- **HTTP only.** If you serve your page over HTTPS, you must opt into
  Private Network Access. Browsers prompt once; the device already
  returns `Access-Control-Allow-Private-Network: true`.
- **Rebooting during an active upload** leaves OTA state in flash. The
  next `/api/upload` with `X-OTA-Start` will erase and retry cleanly.
- **`rx_drops` > 0** on `/api/status` means TCP is retransmitting —
  reduce your chunk size or slow the rate.

## First install (BOOTSEL)

The device only accepts OTA updates once something is already running.
For the very first install:

1. Build:
   ```
   cd firmware
   export PICO_SDK_PATH=~/.pico-sdk/sdk/2.2.0
   export PATH=~/.pico-sdk/toolchain/14_2_Rel1/bin:$PATH
   cmake --build build -j$(sysctl -n hw.ncpu)
   ```
   This produces both `conduit_app_initial.uf2` and `conduit_app.uf2`.
2. Hold BOOTSEL and plug USB. Device appears as a flash drive.
3. Copy `firmware/build/bootloader/partition_table.uf2`, wait for device
   to re-mount, then `picotool reboot -u -f`.
4. Copy `firmware/build/app/conduit_app_initial.uf2` to partition A:
   `picotool load -p 0 -F .../conduit_app_initial.uf2 && picotool reboot`.

Or just run `conduit provision -d <ip>` which does the above.

After that, the device is OTA-ready and all subsequent updates ship the
TBYB-flagged `conduit_app.uf2` through the HTTP flow above.
