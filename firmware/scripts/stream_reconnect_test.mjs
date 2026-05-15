#!/usr/bin/env node
// stream_reconnect_test.mjs — Node-based verification that a long-
// lived HTTPS stream auto-recovers across an OTA upload. Uses the
// same retry pattern as web/telemetry.js: open fetch → read until
// error → backoff → retry, indefinitely. Curl can't replicate this
// because it doesn't auto-retry on RST.
//
// Pass: stream emits its first post-reboot byte within RECONNECT_BUDGET_S
// of the device responding to /api/status.

import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';

const DEVICE  = process.env.DEVICE  || '192.168.178.200';
const BOARD   = process.env.BOARD   || '29166ac0e5917701';
const HOST    = `${DEVICE.replaceAll('.', '-')}.${BOARD}.devices.rm1n.com`;
const URL_BASE = `https://${HOST}`;
const TOKEN   = process.env.TOKEN   || 'changeme';
const UF2     = process.env.UF2     || '/Users/rm1n/Documents/_rm1n/STORE/CONDUIT/conduit/firmware/build/app/conduit_app.uf2';
const RECONNECT_BUDGET_MS = Number(process.env.RECONNECT_BUDGET_MS || 10000);

// Mirrors the browser's telemetry.js retry constants — these are the
// values shipping in web/telemetry.js after the slab-fix tightening.
const RECONNECT_OK_MS  = 750;
const RECONNECT_ERR_MS = 1500;
const STALL_MS         = 3000;
const CONNECT_TIMEOUT_MS = 5000;

function now() { return Date.now(); }

// streamLoop — copy of the runStream + streamLoop pattern in
// web/telemetry.js. Pushes bytesReceived events into the caller's
// observer object so the test can measure reconnect timing.
async function streamLoop(observer) {
  let firstStream = true;
  while (!observer.stopped) {
    const ac = new AbortController();
    let lastByteMs = 0;
    let stallHandle = null;
    observer.activeAbort = ac;

    // Connect-phase timeout. Aborts the fetch if no bytes within
    // CONNECT_TIMEOUT_MS. Mirrors the browser logic.
    const connectTimer = setTimeout(() => {
      if (lastByteMs === 0) {
        observer.diag(`runStream.connectTimeout (${CONNECT_TIMEOUT_MS} ms)`);
        try { ac.abort(); } catch (_) {}
      }
    }, CONNECT_TIMEOUT_MS);

    try {
      observer.diag('runStream.fetch');
      const res = await fetch(`${URL_BASE}/api/data?stream=1`, { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      observer.diag(`runStream.headers ok=${res.ok}`);
      lastByteMs = now();
      clearTimeout(connectTimer);
      observer.onConnect && observer.onConnect();
      firstStream = false;

      // Stall watchdog mirroring telemetry.js
      stallHandle = setInterval(() => {
        if (now() - lastByteMs > STALL_MS) {
          observer.diag('stall.abort');
          try { ac.abort(); } catch (_) {}
        }
      }, 500);

      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { observer.diag('runStream.eof'); break; }
        if (value && value.byteLength) {
          lastByteMs = now();
          observer.onBytes && observer.onBytes(value.byteLength);
        }
      }
      clearInterval(stallHandle); stallHandle = null;
      await sleep(RECONNECT_OK_MS);
    } catch (e) {
      clearTimeout(connectTimer);
      if (stallHandle) clearInterval(stallHandle);
      if (e.name === 'AbortError') {
        observer.diag('runStream.aborted');
      } else {
        observer.diag(`runStream.error: ${e.message || e}`);
      }
      await sleep(RECONNECT_ERR_MS);
    }
  }
}

(async () => {
  console.log('== pre-state ==');
  const pre = await fetch(`${URL_BASE}/api/status`).then(r => r.json());
  console.log(`   partition=${pre.partition} bin=${pre.binary_version} uptime=${pre.uptime}s`);

  const observer = {
    stopped: false,
    activeAbort: null,
    bytesReceived: 0,
    connects: 0,
    lastByteMs: 0,
    diag(msg) { console.log(`   [stream] +${now() - tStart}ms ${msg}`); },
    onConnect() {
      observer.connects++;
      observer.diag(`onConnect #${observer.connects}`);
    },
    onBytes(n) {
      observer.bytesReceived += n;
      observer.lastByteMs = now();
    },
  };
  const tStart = now();

  console.log('== opening stream ==');
  const loopP = streamLoop(observer);

  // Wait for first bytes
  for (let i = 0; i < 20 && observer.bytesReceived === 0; i++) {
    await sleep(500);
  }
  if (observer.bytesReceived === 0) {
    console.error('FAIL: stream produced no bytes pre-OTA');
    observer.stopped = true;
    try { observer.activeAbort && observer.activeAbort.abort(); } catch (_) {}
    process.exit(1);
  }
  console.log(`   pre-OTA bytes=${observer.bytesReceived} connects=${observer.connects}`);

  console.log('== triggering OTA over HTTPS ==');
  const uf2 = readFileSync(UF2);
  const tUploadStart = now();
  let uploadOk = false;
  try {
    const r = await fetch(`${URL_BASE}/api/upload`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': TOKEN,
        'Content-Type': 'application/octet-stream',
        'X-OTA-Start': '1',
        'X-OTA-Finish': '1',
      },
      body: uf2,
    });
    uploadOk = r.ok;
    console.log(`   upload HTTP ${r.status}`);
  } catch (e) {
    // RST on reboot is expected
    if (/reset|network|terminated|aborted/i.test(e.message || '')) {
      console.log(`   upload RST (expected on reboot): ${e.message}`);
      uploadOk = true;
    } else {
      console.log(`   upload threw: ${e.message}`);
    }
  }
  const tUploadEnd = now();
  console.log(`   upload elapsed=${tUploadEnd - tUploadStart}ms`);

  // Mark the byte counter at upload-end. Anything beyond is recovery.
  const preRebootBytes = observer.bytesReceived;
  const preRebootConnects = observer.connects;

  // Wait for /api/status (HTTPS) to confirm device-back
  console.log('== waiting for /api/status (HTTPS) ==');
  let tStatusBack = null;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${URL_BASE}/api/status`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        tStatusBack = now();
        const j = await r.json();
        console.log(`   device back at attempt ${i + 1}, uptime=${j.uptime}s`);
        break;
      }
    } catch (_) {}
    await sleep(1000);
  }
  if (!tStatusBack) {
    console.error('FAIL: device did not respond on HTTPS after upload');
    observer.stopped = true;
    try { observer.activeAbort && observer.activeAbort.abort(); } catch (_) {}
    process.exit(1);
  }

  // Now watch the stream for fresh bytes (post-reboot reconnect)
  console.log(`== watching stream for post-reboot bytes (budget=${RECONNECT_BUDGET_MS} ms) ==`);
  const deadline = tStatusBack + RECONNECT_BUDGET_MS;
  while (now() < deadline) {
    if (observer.bytesReceived > preRebootBytes) {
      const recoveryMs = now() - tStatusBack;
      const newBytes = observer.bytesReceived - preRebootBytes;
      const newConnects = observer.connects - preRebootConnects;
      console.log();
      console.log(`PASS: stream re-emitted +${newBytes} bytes in ${recoveryMs} ms after device-back`);
      console.log(`      total reconnects during the window: ${newConnects}`);
      observer.stopped = true;
      try { observer.activeAbort && observer.activeAbort.abort(); } catch (_) {}
      // Commit so the device doesn't roll back
      try { await fetch(`${URL_BASE}/api/commit`, { method: 'POST', headers: { 'X-Auth-Token': TOKEN } }); } catch (_) {}
      process.exit(0);
    }
    await sleep(200);
  }

  console.error();
  console.error('FAIL: stream did not produce post-reboot bytes within budget');
  console.error(`      preRebootBytes=${preRebootBytes} bytesReceived=${observer.bytesReceived}`);
  console.error(`      connects pre/post = ${preRebootConnects}/${observer.connects}`);
  observer.stopped = true;
  try { observer.activeAbort && observer.activeAbort.abort(); } catch (_) {}
  // Still commit so the device doesn't roll back
  try { await fetch(`${URL_BASE}/api/commit`, { method: 'POST', headers: { 'X-Auth-Token': TOKEN } }); } catch (_) {}
  process.exit(1);
})();
