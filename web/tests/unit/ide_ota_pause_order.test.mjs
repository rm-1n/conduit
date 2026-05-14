// ide_ota_pause_order.test.mjs — regression fence for the "stream
// reconnects starve the precheck handshake" bug.
//
// Background: Cortex-M33 mbedtls (software ChaCha20) can only service
// ~1 concurrent TLS session reliably. The IDE's telemetry + console
// streams reconnect at >1 Hz under the device's keepalive cadence. If
// onBuildUpload calls getStatus or starts an OTA while those streams
// are alive, the new TLS handshake races them at the device, the
// handshake stalls, and updateFirmware returns 'unreachable' — the
// user sees `[precheck] device did not come back` without ever
// uploading a byte.
//
// The fix is structural: tlm.pause() and con.pauseStream() must be
// called BEFORE any window.Conduit.getStatus / updateFirmware call.
// This test parses ide.js's onBuildUpload body and asserts that
// ordering, so a future edit that moves the pause back into the
// middle of the function fails CI loudly.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { webRoot } from './_load.mjs';

function extractFunctionBody(src, name) {
  const startIdx = src.indexOf(`function ${name}`);
  assert.ok(startIdx >= 0, `function ${name} not found in source`);
  // Walk forward to the first '{' (function body opener), then track
  // brace depth until we hit the matching '}'.
  let i = src.indexOf('{', startIdx);
  assert.ok(i >= 0, `opening brace for ${name} not found`);
  const bodyStart = i + 1;
  let depth = 1;
  i++;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return src.slice(bodyStart, i - 1);
}

test('ide: tlm.pause + con.pauseStream fire before any HTTPS request in onBuildUpload', () => {
  const src = readFileSync(join(webRoot, 'ide.js'), 'utf8');
  const body = extractFunctionBody(src, 'onBuildUpload');

  const pauseIdx       = body.search(/\btlm\.pause\s*\(/);
  const pauseStreamIdx = body.search(/\bcon\.pauseStream\s*\(/);
  const getStatusIdx   = body.search(/window\.Conduit\.getStatus\s*\(/);
  const updateFwIdx    = body.search(/window\.Conduit\.updateFirmware\s*\(/);

  assert.ok(pauseIdx       >= 0, 'tlm.pause() must be called in onBuildUpload');
  assert.ok(pauseStreamIdx >= 0, 'con.pauseStream() must be called in onBuildUpload');
  assert.ok(getStatusIdx   >= 0, 'getStatus() must be called in onBuildUpload');
  assert.ok(updateFwIdx    >= 0, 'updateFirmware() must be called in onBuildUpload');

  assert.ok(pauseIdx < getStatusIdx,
    'tlm.pause() must fire BEFORE the first getStatus() — otherwise the ' +
    'telemetry stream competes with the precheck handshake at the device’s ' +
    'mbedtls layer and the precheck stalls. See ' +
    'project_https_keepalive_cadence_wedge.md.');
  assert.ok(pauseStreamIdx < getStatusIdx,
    'con.pauseStream() must fire BEFORE the first getStatus() — same ' +
    'reason as tlm.pause: the /api/log stream races the precheck handshake.');
  assert.ok(pauseIdx       < updateFwIdx, 'tlm.pause() must precede updateFirmware()');
  assert.ok(pauseStreamIdx < updateFwIdx, 'con.pauseStream() must precede updateFirmware()');
});

test('ide: onBuildUpload awaits a settle delay after pausing streams', () => {
  // The browser sends FIN on the aborted fetches asynchronously, and
  // the device's mbedtls needs a tick to free per-session state back
  // to the lwIP heap. Without a small awaited delay after pause, the
  // very next getStatus() can race the in-flight FIN. The fix's design
  // includes `await new Promise(r => setTimeout(r, N))` between the
  // pause calls and the first HTTPS request — assert that pattern is
  // present (any N ≥ 100 ms is fine).
  const src = readFileSync(join(webRoot, 'ide.js'), 'utf8');
  const body = extractFunctionBody(src, 'onBuildUpload');

  const pauseIdx     = body.search(/\btlm\.pause\s*\(/);
  const getStatusIdx = body.search(/window\.Conduit\.getStatus\s*\(/);
  assert.ok(pauseIdx >= 0 && getStatusIdx > pauseIdx);

  // Look for an awaited setTimeout in the window between pause and
  // getStatus. Generous regex — any `await … setTimeout(…, N)` with
  // N ≥ 100 inside that window passes.
  const window_ = body.slice(pauseIdx, getStatusIdx);
  const m = window_.match(/await[^;]*setTimeout\([^,]+,\s*(\d+)\s*\)/);
  assert.ok(m,
    'expected `await new Promise(r => setTimeout(r, N))` between the ' +
    'pause() calls and the first getStatus() — needed for browser FIN ' +
    'and device mbedtls cleanup.');
  const ms = parseInt(m[1], 10);
  assert.ok(ms >= 100,
    `settle delay is ${ms} ms; bump to at least 100 ms so the device's ` +
    'mbedtls has time to release the per-session state before the next ' +
    'TLS handshake opens.');
});

test('ide: streams resume on every exit path (outer finally exists)', () => {
  // If pause is at the top of onBuildUpload but resume only fires on
  // the success path, a build failure leaves telemetry + console
  // paused forever (frozen chart, dead log). The fix wraps the
  // post-pause body in a try/finally so resume runs whether the upload
  // succeeded, errored, or early-returned from a buildUf2 failure.
  const src = readFileSync(join(webRoot, 'ide.js'), 'utf8');
  const body = extractFunctionBody(src, 'onBuildUpload');

  const pauseIdx        = body.search(/\btlm\.pause\s*\(/);
  const resumeIdx       = body.search(/\btlm\.resume\s*\(/);
  const resumeStreamIdx = body.search(/\bcon\.resumeStream\s*\(/);
  const finallyIdx      = body.indexOf('finally');

  assert.ok(resumeIdx       >= 0, 'tlm.resume() must be called somewhere in onBuildUpload');
  assert.ok(resumeStreamIdx >= 0, 'con.resumeStream() must be called somewhere in onBuildUpload');
  assert.ok(finallyIdx > pauseIdx,
    'a `finally {` block must exist after the pause() calls so streams ' +
    'resume on every exit path (success, error, build failure).');
  assert.ok(resumeIdx       > finallyIdx, 'tlm.resume() must live inside the finally block');
  assert.ok(resumeStreamIdx > finallyIdx, 'con.resumeStream() must live inside the finally block');
});
