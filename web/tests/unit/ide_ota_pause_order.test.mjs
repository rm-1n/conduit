// ide_ota_pause_order.test.mjs — locks in the pause/resume *ordering*
// inside ide.js's onBuildUpload finally.
//
// The user-facing requirement: console comes back online before the
// chart pane on every OTA. Console is the lighter pane (text, small
// records) and its log lines are the "device is alive" signal the
// user reads first — having the chart fight for mbedtls slab time
// during the same handshake window pushes both panes' connect
// further out.
//
// Telemetry's streamLoop re-arms an `awaitingConsoleHandoff` gate on
// resume(), and that gate waits for `console.isStreamConnected()` to
// flip true before opening the chart's runStream. The gate works
// regardless of resume call order, but issuing the resumes in
// console-then-telemetry order keeps the streamLoop scheduling
// natural — console gets a head start on the event loop instead of
// racing telemetry's pauseWaiter resolution.
//
// streams_gate.test.mjs already covers the *presence* of pause and
// resume calls. This file covers their *order*.

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

test('ide: onBuildUpload resumes console BEFORE telemetry', () => {
  const src = readFileSync(join(webRoot, 'ide.js'), 'utf8');
  const body = extractFunctionBody(src, 'onBuildUpload');

  // Only inspect the FINAL `finally` — that's where the post-OTA
  // resume lives. Earlier finallys (build-step error handling) don't
  // touch streams.
  const finallyIdx = body.lastIndexOf('finally');
  assert.ok(finallyIdx >= 0, 'onBuildUpload must have a finally block');
  const tail = body.slice(finallyIdx);

  const resumeConIdx = tail.search(/\bcon\.resumeStream\s*\(/);
  const resumeTlmIdx = tail.search(/\btlm\.resume\s*\(/);

  assert.ok(resumeConIdx >= 0,
    'onBuildUpload finally must resume the console stream');
  assert.ok(resumeTlmIdx >= 0,
    'onBuildUpload finally must resume the telemetry stream');
  assert.ok(resumeConIdx < resumeTlmIdx,
    'con.resumeStream() must be called BEFORE tlm.resume() — console-first ' +
    'ordering gives the lighter stream a head start so its `streamConnected` ' +
    'flag flips before telemetry hits the await waitForConsoleConnected gate. ' +
    'Telemetry would still work if the order flipped (the 5 s timeout in ' +
    'waitForConsoleConnected catches that), but the user would then briefly ' +
    'see the chart pane open first — the inverse of what they asked for.');
});

test('telemetry: exposes awaitingConsoleHandoff gate that is set on resume', () => {
  // The gate lives in telemetry.js, not in ide.js — ide.js just calls
  // tlm.resume() and trusts the gate. This test fences the gate so a
  // future "simplify telemetry resume" refactor that removes the
  // re-arm is caught here, not at hardware-test time.
  const src = readFileSync(join(webRoot, 'telemetry.js'), 'utf8');
  assert.ok(/awaitingConsoleHandoff/.test(src),
    'telemetry.js must declare an awaitingConsoleHandoff gate so the chart ' +
    'pane waits for console before opening.');
  assert.ok(/waitForConsoleConnected\s*\(/.test(src),
    'telemetry.js must call waitForConsoleConnected() — that is the await ' +
    'point where the chart pane defers to the console pane.');

  // The gate must be re-armed in resume() — otherwise a post-OTA
  // resume just walks straight past the gate (it was cleared on the
  // very first connect after init) and the chart pane races console.
  const resumeFnIdx = src.indexOf('resume()');
  assert.ok(resumeFnIdx >= 0, 'telemetry.js must define a resume() method');
  // Slice from `resume()` through the next ~25 lines so we only check
  // the resume function body, not a same-named identifier elsewhere.
  const resumeSlice = src.slice(resumeFnIdx, resumeFnIdx + 1500);
  assert.ok(/awaitingConsoleHandoff\s*=\s*true/.test(resumeSlice),
    'resume() must set awaitingConsoleHandoff = true so the next runStream ' +
    'open serializes behind console. Without this, only the page-load init ' +
    'gets the staggered open — every post-OTA resume races.');
});

test('console: exposes isStreamConnected() that telemetry can poll', () => {
  // Telemetry's waitForConsoleConnected() depends on this method.
  // Without it the helper falls back to onNextConnect only — which
  // misses the case where console is *already* connected by the time
  // telemetry hits the gate (page-load races, or a fast post-OTA
  // console reconnect).
  const src = readFileSync(join(webRoot, 'console.js'), 'utf8');
  assert.ok(/isStreamConnected\s*\(\s*\)/.test(src),
    'console.js must expose isStreamConnected() so telemetry can early-resolve ' +
    'its handoff gate when console is already connected.');
});
