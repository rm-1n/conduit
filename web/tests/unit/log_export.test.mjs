// Unit tests for the HDF5 export pipeline. The "unit" boundary here is
// `writeHdf5(channels, opts)` from log_export_worker.js — same function
// the production worker calls. h5wasm itself is treated as a fixed
// dependency (loaded from the local node_modules), since dtype-string
// compatibility is the part that has historically broken.
//
// These tests are deliberately kept small (< 1 KB samples) so they run
// in tens of ms; the larger end-to-end test stays in
// web/tests/log_export_hdf5.mjs.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testsRoot = join(here, '..');
const webRoot   = join(testsRoot, '..');
const h5wasmPath = join(testsRoot, 'node_modules/h5wasm/dist/esm/hdf5_hl.js');
const h5wasmUrl  = pathToFileURL(h5wasmPath).href;

const { writeHdf5 } = await import(pathToFileURL(join(webRoot, 'log_export_worker.js')).href);

// Reusable helper: build a single-channel export and reopen it.
async function buildAndRead(channels) {
  const { bytes, summary } = await writeHdf5(channels, { assetVersion: 'unit', h5wasmUrl });
  const h5 = await import(h5wasmUrl);
  if (h5.ready) await h5.ready;
  const vname = `unit-${Date.now()}-${Math.random().toString(16).slice(2)}.h5`;
  try { h5.FS.unlink(vname); } catch (_) {}
  h5.FS.writeFile(vname, bytes);
  const f = new h5.File(vname, 'r');
  return { bytes, summary, f, h5, vname };
}
function cleanup(h5, vname, f) {
  try { f.close(); } catch (_) {}
  try { h5.FS.unlink(vname); } catch (_) {}
}

const T0 = 1_700_000_000_000;

test('writeHdf5: scalar F32 channel round-trips', async () => {
  const N = 32;
  const values   = new Float32Array(N);
  const uptimeUs = new Float64Array(N);
  const wallMs   = new Float64Array(N);
  for (let i = 0; i < N; i++) { values[i] = i * 0.5; uptimeUs[i] = i * 1000; wallMs[i] = T0 + i; }
  const { f, h5, vname } = await buildAndRead([{
    name: 'X', dtype: 8, n: 1, M: N, values, uptimeUs, wallMs,
  }]);
  try {
    assert.ok(f.get('telemetry'),         '/telemetry group exists');
    assert.ok(f.get('telemetry/X'),       '/telemetry/X group exists');
    const ds = f.get('telemetry/X/values');
    assert.ok(ds);
    assert.equal(ds.value.length, N);
    assert.equal(ds.value.constructor.name, 'Float32Array');
    assert.ok(Math.abs(ds.value[0] - 0)    < 1e-6);
    assert.ok(Math.abs(ds.value[N-1] - (N-1)*0.5) < 1e-5);
    const uptime = f.get('telemetry/X/uptime_us');
    const wall   = f.get('telemetry/X/wall_ms');
    assert.equal(uptime.value.length, N);
    assert.equal(wall.value.length,   N);
    // Storage dtype MUST be F64. The previous version of this assertion
    // tolerated F32, with a comment claiming "bytes themselves are still
    // F64 in the file; only the JS view type changes." That assumption
    // was wrong — h5wasm parses dtype strings via
    //   /^([<>|]?)([bhiqefdsBHIQS])([0-9]*)$/
    // and for floats only the LETTER drives the size lookup (f=4, d=8).
    // The trailing digits are silently dropped, so '<f8' has always
    // been F32 (4 bytes), not F64. On overnight runs this collapsed
    // wall_ms (epoch-ms magnitude) to ~131-second ULP — useless for
    // gap analysis. Correct dtype is '<d'. Assert directly so a future
    // regression to '<f8' / '<f4' fails loudly.
    assert.equal(uptime.metadata.size, 8,
      'uptime_us must be stored as 8-byte float (F64). h5wasm dtype string is <d, not <f8.');
    assert.equal(wall.metadata.size, 8,
      'wall_ms must be stored as 8-byte float (F64). h5wasm dtype string is <d, not <f8.');
    // Round-trip a representative epoch-ms value through wall_ms; if
    // storage silently fell back to F32 this would lose ms granularity
    // (a single 1 ms increment near 1.7e12 lands inside one F32 ULP).
    assert.equal(Number(wall.value[1]) - Number(wall.value[0]), 1,
      'consecutive wall_ms values 1 ms apart must round-trip exactly (F32 would collapse them).');
  } finally { cleanup(h5, vname, f); }
});

test('writeHdf5: wall_ms ULP at epoch scale (regression: F32 lost ~131 s of precision)', async () => {
  // Without the '<d' fix, a single 1-ms increment in wall_ms near
  // 1.7e12 disappeared inside the F32 ULP, so a 12-hour run had
  // every timestamp collapsed to its nearest F32 representable value
  // — about 131 s of granularity. Cover the failure mode explicitly
  // with epoch-scale timestamps so the dtype fix can't silently regress.
  const N = 8;
  const values   = new Float32Array(N);
  const uptimeUs = new Float64Array(N);
  const wallMs   = new Float64Array(N);
  const TBASE = 1_779_564_412_928;          // matches the bad overnight export
  for (let i = 0; i < N; i++) {
    values[i] = 0;
    uptimeUs[i] = TBASE + i;
    wallMs[i] = TBASE + i;                  // 1 ms apart, F32-indistinguishable
  }
  const { f, h5, vname } = await buildAndRead([{
    name: 'EPOCH', dtype: 8, n: 1, M: N, values, uptimeUs, wallMs,
  }]);
  try {
    const wall   = f.get('telemetry/EPOCH/wall_ms');
    const uptime = f.get('telemetry/EPOCH/uptime_us');
    assert.equal(wall.metadata.size,   8);
    assert.equal(uptime.metadata.size, 8);
    for (let i = 1; i < N; i++) {
      assert.equal(Number(wall.value[i]) - Number(wall.value[i-1]), 1,
        `wall_ms[${i}] − wall_ms[${i-1}] must be 1 (F32 would round both to the same value at this magnitude).`);
      assert.equal(Number(uptime.value[i]) - Number(uptime.value[i-1]), 1,
        `uptime_us[${i}] − uptime_us[${i-1}] must be 1.`);
    }
  } finally { cleanup(h5, vname, f); }
});

test('writeHdf5: U32 channel uses correct dtype string (regression: <u4 rejected)', async () => {
  const N = 16;
  const values   = new Uint32Array(N);
  const uptimeUs = new Float64Array(N);
  const wallMs   = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    values[i] = 1_000_000 + i;             // > 2^16 catches I16-as-I32 narrowing
    uptimeUs[i] = i * 1000;
    wallMs[i] = T0 + i;
  }
  const { f, h5, vname } = await buildAndRead([{
    name: 'SEQ', dtype: 5, n: 1, M: N, values, uptimeUs, wallMs,
  }]);
  try {
    const ds = f.get('telemetry/SEQ/values');
    assert.equal(ds.value.constructor.name, 'Uint32Array',
      'must round-trip as Uint32Array (using <u4 would have thrown at write)');
    assert.equal(Number(ds.value[0]),     1_000_000);
    assert.equal(Number(ds.value[N - 1]), 1_000_000 + N - 1);
  } finally { cleanup(h5, vname, f); }
});

test('writeHdf5: vector channel preserves [M, n] shape', async () => {
  const M = 12, n = 3;
  const values   = new Int16Array(M * n);
  const uptimeUs = new Float64Array(M);
  const wallMs   = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    values[i * n + 0] = i;
    values[i * n + 1] = -i;
    values[i * n + 2] = i * 2;
    uptimeUs[i] = i * 1000;
    wallMs[i] = T0 + i;
  }
  const { f, h5, vname } = await buildAndRead([{
    name: 'IMU', dtype: 2, n, M, values, uptimeUs, wallMs,
  }]);
  try {
    const ds = f.get('telemetry/IMU/values');
    assert.equal(ds.value.length, M * n);
    assert.equal(ds.value.constructor.name, 'Int16Array');
    if (ds.shape) {
      assert.equal(ds.shape.length, 2);
      assert.equal(Number(ds.shape[0]), M);
      assert.equal(Number(ds.shape[1]), n);
    }
    // Spot-check interleaving: row 4 should be [4, -4, 8]
    assert.equal(Number(ds.value[4 * n + 0]),  4);
    assert.equal(Number(ds.value[4 * n + 1]), -4);
    assert.equal(Number(ds.value[4 * n + 2]),  8);
  } finally { cleanup(h5, vname, f); }
});

test('writeHdf5: multiple channels coexist under /telemetry', async () => {
  const N1 = 10, N2 = 5;
  const v1 = new Float32Array(N1);
  const v2 = new Uint8Array(N2);
  for (let i = 0; i < N1; i++) v1[i] = i;
  for (let i = 0; i < N2; i++) v2[i] = i;
  const u1 = new Float64Array(N1), w1 = new Float64Array(N1);
  const u2 = new Float64Array(N2), w2 = new Float64Array(N2);
  for (let i = 0; i < N1; i++) { u1[i] = i; w1[i] = T0 + i; }
  for (let i = 0; i < N2; i++) { u2[i] = i; w2[i] = T0 + i; }
  const { f, h5, vname, summary } = await buildAndRead([
    { name: 'A', dtype: 8, n: 1, M: N1, values: v1, uptimeUs: u1, wallMs: w1 },
    { name: 'B', dtype: 1, n: 1, M: N2, values: v2, uptimeUs: u2, wallMs: w2 },
  ]);
  try {
    assert.ok(f.get('telemetry/A/values'));
    assert.ok(f.get('telemetry/B/values'));
    assert.equal(f.get('telemetry/A/values').value.length, N1);
    assert.equal(f.get('telemetry/B/values').value.length, N2);
    assert.equal(f.get('telemetry/B/values').value.constructor.name, 'Uint8Array');
    assert.equal(summary.telemetryChannels, 2);
    assert.equal(summary.telemetryRecords, N1 + N2);
  } finally { cleanup(h5, vname, f); }
});

test('writeHdf5: empty channel set yields a parseable but empty file', async () => {
  // Defensive — current code wraps create_dataset in a per-channel loop,
  // so 0 channels is a no-op. This test pins that behavior.
  const { bytes, summary, f, h5, vname } = await buildAndRead([]);
  try {
    assert.ok(bytes.byteLength > 0, 'still produces a valid HDF5 superblock');
    assert.equal(summary.telemetryChannels, 0);
    assert.equal(summary.telemetryRecords, 0);
  } finally { cleanup(h5, vname, f); }
});
