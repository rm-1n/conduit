// Regression tests for upload.js — specifically the "device rebooted
// mid-response" detection that lets the OTA flow treat a TLS/TCP RST
// after a fully-sent body as success instead of stalling the user.
//
// The race: on HTTPS, the device sends its FIN/RST inside the 200 OK
// response and the browser dispatches xhr.onerror before
// xhr.upload.onload — so `allBytesSent` never flips to true, but
// `bytesSent` did reach `total` via the final onprogress event.
// Without `fullySent()` (allBytesSent || bytesSent >= total) the
// browser shows "upload stalled at N/N bytes (100.0%)" for a
// genuinely successful upload.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadModule, makeWindow } from './_load.mjs';

// Minimal Blob shim — Node 20+ has Blob globally but in a different
// shape; we just need .size for upload.js's bookkeeping. The harness
// inherits globalThis.Blob so we don't have to override unless we want
// fine control.
function makeBlob(bytes) {
  return new Blob([new Uint8Array(bytes)]);
}

// Stub XHR. Tests drive lifecycle explicitly:
//   xhr.upload.onprogress / onload    — body progress dispatch
//   xhr.onload / onerror / onabort    — response dispatch
class FakeXHR {
  constructor() {
    this.upload = {};
    this.requestHeaders = {};
    this.opened = null;
    this.sent = null;
  }
  open(method, url) { this.opened = { method, url }; }
  setRequestHeader(k, v) { this.requestHeaders[k] = v; }
  send(body) { this.sent = body; }
  abort() { if (typeof this.onabort === 'function') this.onabort(); }
}

function setupHarness() {
  const win = makeWindow();
  // upload.js calls window.Conduit.deviceUrlForIp; stub it.
  win.Conduit.deviceUrlForIp = (ip, path) => `http://${ip}${path}`;
  // upload.js does `new XMLHttpRequest()` (bare reference). In a browser
  // that resolves via global scope; in Node we have to plant it on
  // globalThis BEFORE loading the module so the IIFE's `new` finds it.
  const xhrs = [];
  const PrevXHR = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class extends FakeXHR {
    constructor() { super(); xhrs.push(this); }
  };
  win.Blob = globalThis.Blob;
  loadModule('upload.js', win);
  // Caller is expected to call restore() in a try/finally — but in
  // practice tests don't share state, so even leaking is fine. Return
  // a no-op token to keep callers honest if they ever care.
  return { win, xhrs, restore: () => { globalThis.XMLHttpRequest = PrevXHR; } };
}

// Wait until the IIFE's internal async setup has progressed enough
// that an XHR has been allocated and `.send()` called. The async path
// is `await toBlob(...)` → setup → send; one microtask flush is enough.
async function nextTick() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('upload: HTTPS reboot-mid-response with bytesSent === total → onComplete', async () => {
  const { win, xhrs } = setupHarness();
  const events = [];
  win.Conduit.uploadFirmware({
    ip: '192.168.1.1',
    token: 'changeme',
    data: makeBlob(100),
    onProgress: (p) => events.push(['progress', p.loaded, p.total]),
    onComplete: () => events.push(['complete']),
    onError: (e) => events.push(['error', e.message]),
  });
  await nextTick();
  assert.equal(xhrs.length, 1, 'one XHR should have been allocated');
  const xhr = xhrs[0];
  assert.equal(xhr.opened?.method, 'POST');
  assert.equal(xhr.requestHeaders['X-OTA-Start'], '1');
  assert.equal(xhr.requestHeaders['X-OTA-Finish'], '1');

  // Simulate the device-reboot race: progress fires up to 100% but
  // xhr.upload.onload never fires (browser dispatched the error first).
  xhr.upload.onprogress({ lengthComputable: true, loaded: 100, total: 100 });
  // CRITICAL: do NOT call xhr.upload.onload — that's the race we're testing.
  xhr.onerror();

  assert.ok(events.some(e => e[0] === 'complete'),
    `expected onComplete, got: ${JSON.stringify(events)}`);
  assert.ok(!events.some(e => e[0] === 'error'),
    `should not have surfaced error: ${JSON.stringify(events)}`);
});

test('upload: genuine stall (bytes < total) on error → surfaces stalled message', async () => {
  const { win, xhrs } = setupHarness();
  const events = [];
  win.Conduit.uploadFirmware({
    ip: '192.168.1.1',
    token: 'changeme',
    data: makeBlob(1000),
    onComplete: () => events.push(['complete']),
    onError: (e) => events.push(['error', e.message]),
  });
  await nextTick();
  const xhr = xhrs[0];
  xhr.upload.onprogress({ lengthComputable: true, loaded: 400, total: 1000 });
  xhr.onerror();

  assert.ok(events.some(e => e[0] === 'error' && /stalled at 400\/1000/.test(e[1])),
    `expected stalled error, got: ${JSON.stringify(events)}`);
  assert.ok(!events.some(e => e[0] === 'complete'));
});

test('upload: onload firing normally → onComplete', async () => {
  const { win, xhrs } = setupHarness();
  const events = [];
  win.Conduit.uploadFirmware({
    ip: '192.168.1.1',
    token: 'changeme',
    data: makeBlob(100),
    onComplete: () => events.push(['complete']),
    onError: (e) => events.push(['error', e.message]),
  });
  await nextTick();
  const xhr = xhrs[0];
  xhr.upload.onload();  // upload finished cleanly
  xhr.status = 200;
  xhr.onload();         // response arrived
  assert.ok(events.some(e => e[0] === 'complete'));
});

test('upload: abort path with full bytes also collapses to success', async () => {
  const { win, xhrs } = setupHarness();
  const events = [];
  win.Conduit.uploadFirmware({
    ip: '192.168.1.1',
    token: 'changeme',
    data: makeBlob(50),
    onComplete: () => events.push(['complete']),
    onError: (e) => events.push(['error', e.message]),
  });
  await nextTick();
  const xhr = xhrs[0];
  xhr.upload.onprogress({ lengthComputable: true, loaded: 50, total: 50 });
  // No upload.onload — same race as the onerror test, but onabort path.
  xhr.onabort();
  assert.ok(events.some(e => e[0] === 'complete'));
});
