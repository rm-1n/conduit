// streams_gate.test.mjs — regression fence for the HTTPS-saturation
// fixes that took multiple debugging cycles to get right:
//
// 1. hardware.js's Add-device form must PAUSE telemetry + console
//    streams BEFORE calling probeAndRemember. Without this, the probe
//    races the in-flight stream handshakes at the Cortex-M33 mbedtls
//    layer and the device wedges hard (port 443 + 80 both go
//    unreachable) — matches the "No response from <ip>. Check the
//    unique-id…" symptom users hit on fresh page-load with a saved
//    device.
//
// 2. ide.js's reconnect() must gate stream auto-resume behind an
//    opt-in flag (window.Conduit.streamsAutoResume). Even one probe
//    + one auto-resumed stream is too much steady-state HTTPS load
//    for this chip. Streams stay paused by default; users opt in by
//    setting the flag or clicking the pane play buttons.
//
// 3. ide.js's onBuildUpload outer finally must NOT resume streams
//    unconditionally after an OTA. Doing so fires two parallel TLS
//    handshakes against the freshly-rebooted device while mbedtls is
//    still warming up, fragmenting the heap for the NEXT OTA. The
//    correct pattern: gate on result.outcome ∈ {committed,rebooted},
//    do a stability probe (Conduit.getStatus) AFTER a 2 s settle, and
//    only resume streams if that probe succeeds.

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
  // Block comments first (greedy until */), then line comments.
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

test('ide: onBuildUpload post-OTA resume is outcome-gated, not unconditional', () => {
  // After the 1st OTA succeeds, the OUTER finally used to call
  // tlm.resume() / con.resumeStream() unconditionally — which fired
  // two parallel TLS handshakes immediately against the just-rebooted
  // device. By the 2nd OTA the mbedtls heap had fragmented and the
  // 2nd waitForDevice timed out with "Device did not respond".
  //
  // The fix: gate the resume on result.outcome (only on 'committed'
  // or 'rebooted' — the cases where the device actually came back),
  // AND do a stability probe before opening the floodgates. This
  // test fences that pattern.
  const src = readFileSync(join(webRoot, 'ide.js'), 'utf8');
  const body = extractFunctionBody(src, 'onBuildUpload');
  // We're looking at the OUTER finally — the one wrapping the entire
  // post-pause flow. Both `result.outcome` and the resume calls are
  // inside it. lastIndexOf picks the right finally because the inner
  // updateFirmware try block has no resume in its (now-collapsed)
  // finally — only the outer one does.
  const lastFinallyIdx = body.lastIndexOf('finally');
  assert.ok(lastFinallyIdx >= 0, 'onBuildUpload must have a finally block');

  const tail = body.slice(lastFinallyIdx);
  const outcomeIdx  = tail.search(/\bresult\.outcome\b/);
  const resumeIdx   = tail.search(/\btlm\.resume\s*\(/);
  const conResumeIdx = tail.search(/\bcon\.resumeStream\s*\(/);

  assert.ok(outcomeIdx >= 0,
    'onBuildUpload finally must reference result.outcome to gate the resume — ' +
    'an unconditional resume re-fragments mbedtls between OTAs and breaks the 2nd one.');
  assert.ok(resumeIdx >= 0,
    'onBuildUpload finally should still resume telemetry on the happy outcomes');
  assert.ok(conResumeIdx >= 0,
    'onBuildUpload finally should still resume console on the happy outcomes');
  assert.ok(outcomeIdx < resumeIdx,
    'result.outcome check must come BEFORE tlm.resume() — otherwise the gate is dead code.');
  assert.ok(outcomeIdx < conResumeIdx,
    'result.outcome check must come BEFORE con.resumeStream() — same reason.');
});

test('ide: onBuildUpload runs a stability probe before resuming streams', () => {
  // The waitForDevice that runs inside updateFirmware returns on the
  // first /api/status that comes back with a fresh uptime. The device
  // is reachable at that point but mbedtls / lwIP may still be mid-
  // init for several seconds. Resuming streams immediately fires two
  // parallel handshakes against a device that can't service them.
  //
  // The stability probe: wait ~2 s, do ONE more getStatus call, and
  // only open the floodgates if that succeeds.
  const src = readFileSync(join(webRoot, 'ide.js'), 'utf8');
  const body = extractFunctionBody(src, 'onBuildUpload');
  const lastFinallyIdx = body.lastIndexOf('finally');
  const tail = body.slice(lastFinallyIdx);

  const probeIdx  = tail.search(/Conduit\.getStatus\s*\(/);
  const resumeIdx = tail.search(/\btlm\.resume\s*\(/);

  assert.ok(probeIdx >= 0,
    'onBuildUpload finally must call Conduit.getStatus() as a stability probe ' +
    'before resuming streams — waitForDevice alone isn\'t a strong enough signal ' +
    'because mbedtls warms up several seconds after the first /api/status responds.');
  assert.ok(probeIdx < resumeIdx,
    'The stability probe must come BEFORE tlm.resume() — otherwise it isn\'t guarding anything.');
});

test('ide: reconnect() gates stream auto-resume behind streamsAutoResume flag', () => {
  // The previous design called tel.resume() + con.resumeStream() on
  // every successful reconnect, which created TWO concurrent HTTPS
  // streams against a device that can only service one at a time.
  // Auto-resume must be opt-in via window.Conduit.streamsAutoResume,
  // off by default for HTTPS reliability.
  const src = readFileSync(join(webRoot, 'ide.js'), 'utf8');
  const body = extractFunctionBody(src, 'reconnect');

  const resumeIdx       = body.search(/\btel\.resume\s*\(/);
  const resumeStreamIdx = body.search(/\bcon\.resumeStream\s*\(/);
  const gateIdx         = body.search(/streamsAutoResume/);

  assert.ok(resumeIdx       >= 0, 'reconnect() should still know how to call tel.resume()');
  assert.ok(resumeStreamIdx >= 0, 'reconnect() should still know how to call con.resumeStream()');
  assert.ok(gateIdx         >= 0,
    'reconnect() must gate the resume calls behind a streamsAutoResume flag — ' +
    'unconditional auto-resume bricks the device under realistic HTTPS load.');
  assert.ok(gateIdx < resumeIdx,
    'streamsAutoResume gate must appear before the first tel.resume() call ' +
    'so it actually guards it.');
});
