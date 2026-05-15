// streams_gate.test.mjs — regression fence for the stream / OTA wiring.
//
// Two contracts are checked here:
//
// 1. hardware.js's Add-device submit must PAUSE telemetry + console
//    before calling probeAndRemember, and resume them on every exit
//    path. The probe is a one-off HTTPS handshake; running it while
//    the streams' own reconnect loop is hammering the device used to
//    wedge the precheck.
//
// 2. ide.js's onBuildUpload must PAUSE both streams at the start of
//    the upload phase and RESUME them in the outer finally on every
//    exit path. The build phase (pure CPU WASM compile) runs with
//    streams live; the upload + verify + commit phase runs with them
//    paused so mbedtls focuses its slab + lwIP heap on the OTA TLS
//    session alone. The stream's own retry loop reconnects against
//    the post-reboot device after resume().
//
// 3. ide.js's reconnect() (page-load path) must NOT pause or resume
//    streams. Streams stay running through the probe; their own
//    retry loop is the lifecycle owner. The previous design's
//    pause/resume choreography had a fatal bug: any probe failure
//    skipped the resume branch via early return, leaving streams
//    paused with no path back online except a full page reload.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { webRoot } from './_load.mjs';

function extractFunctionBody(src, name) {
  const startIdx = src.indexOf(`function ${name}`);
  assert.ok(startIdx >= 0, `function ${name} not found`);
  let i = src.indexOf('{', startIdx);
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

// Strip // line-comments AND /* block-comments */ so regex searches
// only match the real code, not header/docstring mentions.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

test('hardware: Add-device submit pauses streams before probing', () => {
  const src = stripComments(readFileSync(join(webRoot, 'hardware.js'), 'utf8'));

  const pauseIdx        = src.indexOf('tlm.pause(');
  const pauseStreamIdx  = src.indexOf('con.pauseStream(');
  // hardware.js has two probeAndRemember sites: the `reprobe` function
  // (re-probing a device already in the list, no fresh handshake load)
  // and the Add-device submit handler. We care about the submit one —
  // that's the path users hit when their saved-device autoresumed
  // streams have wedged the device and they're trying to recover.
  // lastIndexOf reliably picks the submit-handler call since it comes
  // after the reprobe one in the file.
  const probeIdx        = src.lastIndexOf('Conduit.probeAndRemember(');

  assert.ok(pauseIdx       >= 0, 'hardware.js must pause telemetry before probing');
  assert.ok(pauseStreamIdx >= 0, 'hardware.js must pause console before probing');
  assert.ok(probeIdx       >= 0, 'hardware.js must call probeAndRemember');

  assert.ok(pauseIdx       < probeIdx,
    'tlm.pause() must come before the submit handler\'s probeAndRemember() — ' +
    'otherwise the probe races the in-flight stream handshakes and the device ' +
    'wedges. See memory project_https_keepalive_cadence_wedge.md.');
  assert.ok(pauseStreamIdx < probeIdx,
    'con.pauseStream() must come before the submit handler\'s probeAndRemember() — same reason.');
});

test('hardware: streams resume on every exit path (success, failure, error)', () => {
  const src = readFileSync(join(webRoot, 'hardware.js'), 'utf8');
  const finallyIdx = src.indexOf('} finally {');
  const resumeIdx  = src.search(/\btlm\.resume\s*\(/);
  const resumeStreamIdx = src.search(/\bcon\.resumeStream\s*\(/);
  assert.ok(finallyIdx > 0, 'hardware.js must wrap probe in try/finally so streams resume on every path');
  assert.ok(resumeIdx > finallyIdx, 'tlm.resume() must live in the finally block');
  assert.ok(resumeStreamIdx > finallyIdx, 'con.resumeStream() must live in the finally block');
});

test('ide: onBuildUpload pauses streams before the upload + resumes in finally', () => {
  // Pause-at-upload-start frees mbedtls slab + lwIP heap for the
  // upload's TLS session, and stops the keepalive traffic the device
  // would otherwise be encrypting between OTA blocks. The resume must
  // live in the outer finally so every exit path (build error early
  // return, updateFirmware throw, clean outcome) restores the streams
  // — otherwise a failed OTA leaves them paused with no recovery path.
  const src = readFileSync(join(webRoot, 'ide.js'), 'utf8');
  const body = extractFunctionBody(src, 'onBuildUpload');

  const pauseTlmIdx   = body.search(/\btlm\.pause\s*\(/);
  const pauseConIdx   = body.search(/\bcon\.pauseStream\s*\(/);
  const updateFwIdx   = body.search(/Conduit\.updateFirmware\s*\(/);
  const finallyIdx    = body.lastIndexOf('finally');
  const resumeTlmIdx  = body.search(/\btlm\.resume\s*\(/);
  const resumeConIdx  = body.search(/\bcon\.resumeStream\s*\(/);

  assert.ok(pauseTlmIdx >= 0,
    'onBuildUpload must call tlm.pause() before the upload — frees mbedtls slab + lwIP heap.');
  assert.ok(pauseConIdx >= 0,
    'onBuildUpload must call con.pauseStream() before the upload — same reason.');
  assert.ok(updateFwIdx >= 0, 'onBuildUpload must call Conduit.updateFirmware');
  assert.ok(pauseTlmIdx < updateFwIdx,
    'tlm.pause() must come BEFORE the updateFirmware call so the upload runs with streams paused.');
  assert.ok(pauseConIdx < updateFwIdx,
    'con.pauseStream() must come BEFORE the updateFirmware call — same reason.');

  assert.ok(finallyIdx >= 0, 'onBuildUpload must wrap the OTA in a try/finally so streams resume on every exit path');
  assert.ok(resumeTlmIdx > finallyIdx,
    'tlm.resume() must live in the finally block so build errors and OTA throws still resume streams.');
  assert.ok(resumeConIdx > finallyIdx,
    'con.resumeStream() must live in the finally block — same reason.');
});

test('ide: reconnect() does NOT pause or resume streams', () => {
  // The probe is a one-off /api/status handshake. The pause/resume
  // choreography around it used to make sense back when 3 concurrent
  // HTTPS handshakes wedged the device, but the slab + 128 KB MEM_SIZE
  // make that load fine now. The choreography was load-bearing for a
  // subtle bug: if the probe failed for ANY reason (transient network
  // glitch, brief device reboot, browser-side quirk), the resume
  // branch was skipped via the early return, leaving both streams
  // paused with no path back online without a manual page reload.
  // The streamLoop's own retry logic handles stream lifecycle through
  // the probe.
  const src = readFileSync(join(webRoot, 'ide.js'), 'utf8');
  const body = extractFunctionBody(src, 'reconnect');

  assert.ok(!/\btel\.pause\s*\(/.test(body),
    'reconnect() must not call tel.pause() — streams stay running through the probe. ' +
    'See the comment in reconnect() for the failure mode this guards against.');
  assert.ok(!/\bcon\.pauseStream\s*\(/.test(body),
    'reconnect() must not call con.pauseStream() — same reason.');
  assert.ok(!/\btel\.resume\s*\(/.test(body),
    'reconnect() must not call tel.resume() — they were never paused, there is nothing to resume.');
  assert.ok(!/\bcon\.resumeStream\s*\(/.test(body),
    'reconnect() must not call con.resumeStream() — same reason.');
});

test('telemetry: exposes onNextConnect that fires once and is removable', () => {
  // Source-level smoke check: telemetry.js exports onNextConnect on
  // the public API and fires it from the runStream success path. The
  // exact semantics (one-shot, returns unsubscribe) are documented in
  // the function comment.
  const src = readFileSync(join(webRoot, 'telemetry.js'), 'utf8');
  assert.ok(/onNextConnect\s*\(/.test(src),
    'telemetry.js must export onNextConnect on Conduit.telemetry');
  assert.ok(/fireConnect\s*\(/.test(src),
    'telemetry.js must call fireConnect() (or equivalent) from runStream so the listener fires post-reboot');
});

test('console: exposes onNextConnect that fires once and is removable', () => {
  const src = readFileSync(join(webRoot, 'console.js'), 'utf8');
  assert.ok(/onNextConnect\s*\(/.test(src),
    'console.js must export onNextConnect on Conduit.console');
  assert.ok(/fireConnect\s*\(/.test(src),
    'console.js must call fireConnect() (or equivalent) from runStream so the listener fires post-reboot');
});

test('upload: waitForDevice accepts fastReady and races it against the poll', () => {
  const src = readFileSync(join(webRoot, 'upload.js'), 'utf8');
  // The function destructures fastReady from opts. We accept either
  // `fastReady = null` (with a default) or a bare `fastReady`.
  const wfdSrc = src.slice(src.indexOf('function waitForDevice'),
                          src.indexOf('function commitFirmware'));
  assert.ok(/\bfastReady\b/.test(wfdSrc),
    'waitForDevice must accept a fastReady promise from opts so OTA flows can short-circuit the poll on stream reconnect.');
  assert.ok(/Promise\.race/.test(wfdSrc),
    'waitForDevice must race fastReady against its own poll/interval.');
});

test('upload: updateFirmware threads fastReady through to waitForDevice', () => {
  const src = readFileSync(join(webRoot, 'upload.js'), 'utf8');
  const ufSrc = src.slice(src.indexOf('async function updateFirmware'),
                          src.length);
  assert.ok(/\bfastReady\b/.test(ufSrc),
    'updateFirmware must accept fastReady and pass it through to waitForDevice — otherwise the IDE has no way to wire the stream signal in.');
});
