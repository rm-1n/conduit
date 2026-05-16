// ide_ota_pause_order.test.mjs — pause/resume wiring around OTA.
//
// With the single-stream WebSocket transport (stream.js), the old
// "console-then-telemetry handshake serialization" choreography is
// gone — there is exactly ONE TLS session, owned by stream.js, and
// console.js / telemetry.js are pure subscribers. The contract this
// file locks in:
//
//   1. ide.js's onBuildUpload finally still calls con.resumeStream()
//      AND tlm.resume(). Both are kept for back-compat with callers
//      that don't know there's only one transport now; they delegate
//      to stream.resume() under the hood (idempotent).
//   2. telemetry.js's pause()/resume() delegate to stream.pause()/
//      stream.resume() so the WS actually closes during OTA and the
//      device's mbedtls slab is exclusively available for the upload.
//   3. console.js's pauseStream()/resumeStream() do the same.
//   4. console.js still exposes isStreamConnected() for callers that
//      historically polled it (back-compat surface).

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

test('ide: onBuildUpload finally resumes both console and telemetry', () => {
  const src = readFileSync(join(webRoot, 'ide.js'), 'utf8');
  const body = extractFunctionBody(src, 'onBuildUpload');
  const finallyIdx = body.lastIndexOf('finally');
  assert.ok(finallyIdx >= 0, 'onBuildUpload must have a finally block');
  const tail = body.slice(finallyIdx);

  const resumeConIdx = tail.search(/\bcon\.resumeStream\s*\(/);
  const resumeTlmIdx = tail.search(/\btlm\.resume\s*\(/);

  assert.ok(resumeConIdx >= 0,
    'onBuildUpload finally must resume the console stream');
  assert.ok(resumeTlmIdx >= 0,
    'onBuildUpload finally must resume the telemetry stream');
  // Order no longer matters — both ultimately delegate to a single
  // idempotent stream.resume() under the hood — but call both so a
  // future caller that still treats them as independent gets the
  // right behavior in either path.
});

test('telemetry: pause()/resume() delegate to stream.pause()/resume()', () => {
  const src = readFileSync(join(webRoot, 'telemetry.js'), 'utf8');

  const pauseFnStart = src.search(/pause\s*\(\s*\)\s*{/);
  assert.ok(pauseFnStart >= 0, 'telemetry.js must define pause()');
  const pauseSlice = src.slice(pauseFnStart, pauseFnStart + 800);
  assert.ok(/s\.pause\s*\(\s*\)/.test(pauseSlice) || /stream\.pause\s*\(\s*\)/.test(pauseSlice),
    'telemetry.pause() must call stream.pause() so the WS actually closes for the OTA window — ' +
    'leaving the WS open during OTA defeats the slab/heap isolation that pause was designed to give.');

  const resumeFnStart = src.search(/resume\s*\(\s*\)\s*{/);
  assert.ok(resumeFnStart >= 0, 'telemetry.js must define resume()');
  const resumeSlice = src.slice(resumeFnStart, resumeFnStart + 1500);
  assert.ok(/s\.resume\s*\(\s*\)/.test(resumeSlice) || /stream\.resume\s*\(\s*\)/.test(resumeSlice),
    'telemetry.resume() must call stream.resume() so the WS reopens after the OTA completes.');
});

test('console: pauseStream()/resumeStream() delegate to stream.pause()/resume()', () => {
  const src = readFileSync(join(webRoot, 'console.js'), 'utf8');

  const pauseFnStart = src.search(/pauseStream\s*\(\s*\)\s*{/);
  assert.ok(pauseFnStart >= 0, 'console.js must define pauseStream()');
  const pauseSlice = src.slice(pauseFnStart, pauseFnStart + 800);
  assert.ok(/s\.pause\s*\(\s*\)/.test(pauseSlice) || /stream\.pause\s*\(\s*\)/.test(pauseSlice),
    'console.pauseStream() must call stream.pause().');

  const resumeFnStart = src.search(/resumeStream\s*\(\s*\)\s*{/);
  assert.ok(resumeFnStart >= 0, 'console.js must define resumeStream()');
  const resumeSlice = src.slice(resumeFnStart, resumeFnStart + 800);
  assert.ok(/s\.resume\s*\(\s*\)/.test(resumeSlice) || /stream\.resume\s*\(\s*\)/.test(resumeSlice),
    'console.resumeStream() must call stream.resume().');
});

test('console: exposes isStreamConnected() (back-compat surface)', () => {
  const src = readFileSync(join(webRoot, 'console.js'), 'utf8');
  assert.ok(/isStreamConnected\s*\(\s*\)/.test(src),
    'console.js must expose isStreamConnected() — callers may still poll it ' +
    'to render UI state on the connection.');
});
