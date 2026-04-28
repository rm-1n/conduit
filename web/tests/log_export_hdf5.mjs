// log_export_hdf5.mjs — Headless test for the HDF5 build path.
//
// log_export.js is a thin glue layer that ferries channel buffers to
// log_export_worker.js — testing it end-to-end requires a real Web
// Worker and DOM, both of which are awkward in Node. So this test
// imports log_export_worker.js directly as an ESM module (its
// message-handler block is guarded by a WorkerGlobalScope check, so it
// stays dormant) and calls writeHdf5() in-process. This exercises the
// only code path that's gone wrong historically: h5wasm group/dataset
// creation. The thin postMessage glue in log_export.js is small enough
// to read by eye.
//
// Reproduces (and prevents recurrence of) the bug where create_dataset
// silently no-ops on missing intermediate groups → 6.7 KB empty-shell
// file no matter how many "samples" the summary claimed to write. See
// memory project_h5wasm_intermediate_groups.md.
//
// Run from repo root:  node web/tests/log_export_hdf5.mjs

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot   = join(__dirname, '..');
const h5wasmPath = join(__dirname, 'node_modules/h5wasm/dist/esm/hdf5_hl.js');
const h5wasmUrl  = pathToFileURL(h5wasmPath).href;

// Two channels — the one we ship most often (scalar F32, ~thousands of
// samples) and a vector channel that locks down the [M, n] shape path
// we'd otherwise only catch when an IMU lands in the registry.
const T0_WALL_MS = 1_700_000_000_000;

const N1 = 5000, DT1 = 300;
const sinValues = new Float32Array(N1);
const sinUptime = new Float64Array(N1);
const sinWallMs = new Float64Array(N1);
for (let i = 0; i < N1; i++) {
  sinValues[i] = Math.sin(i * 0.01);
  sinUptime[i] = i * DT1;
  sinWallMs[i] = T0_WALL_MS + (i * DT1) / 1000;
}

const N2 = 1200, DT2 = 1000, NN2 = 3;
const imuValues = new Int16Array(N2 * NN2);
const imuUptime = new Float64Array(N2);
const imuWallMs = new Float64Array(N2);
for (let i = 0; i < N2; i++) {
  imuValues[i * 3 + 0] = (i * 7) & 0x7fff;
  imuValues[i * 3 + 1] = -((i * 11) & 0x7fff);
  imuValues[i * 3 + 2] = (i * 13) & 0x7fff;
  imuUptime[i] = i * DT2;
  imuWallMs[i] = T0_WALL_MS + (i * DT2) / 1000;
}

const channels = [
  { name: 'SIN', dtype: 8, n: 1,   M: N1, values: sinValues, uptimeUs: sinUptime, wallMs: sinWallMs },
  { name: 'IMU', dtype: 2, n: NN2, M: N2, values: imuValues, uptimeUs: imuUptime, wallMs: imuWallMs },
];

// ---------------------------------------------------------------------------
// Drive the build
// ---------------------------------------------------------------------------

const { writeHdf5 } = await import(pathToFileURL(join(webRoot, 'log_export_worker.js')).href);

const progress = [];
const { bytes, summary } = await writeHdf5(channels, {
  assetVersion: 'test',
  h5wasmUrl,
  onProgress: (p) => progress.push(p),
});

console.log(`exported  : ${bytes.byteLength} bytes`);
console.log(`summary   : ${summary.telemetryRecords} samples / ${summary.telemetryChannels} channels`);
console.log(`timings   : h5wasm ${summary.timings.h5wasmMs} / build ${summary.timings.buildMs} / total ${summary.timings.totalMs}`);
console.log(`progress  : ${progress.length} updates (${progress.map(p => p.stage).join(' → ')})`);

const FLOOR = 16 * 1024;   // file should be > raw payload + small framing
if (bytes.byteLength < FLOOR) {
  console.error(`FAIL: output is ${bytes.byteLength} B, expected > ${FLOOR} B`);
  console.error('  → this is the historical bug: create_dataset is silently no-op\'ing');
}

// ---------------------------------------------------------------------------
// Reopen the bytes via h5wasm and assert contents
// ---------------------------------------------------------------------------

const tmp = await mkdtemp(join(tmpdir(), 'pico-poe-h5-'));
const outPath = join(tmp, 'out.h5');
await writeFile(outPath, bytes);
console.log(`wrote     : ${outPath}  (also re-opening via h5wasm in-memory)`);

const h5 = await import(h5wasmUrl);
if (h5.ready) await h5.ready;
const vname = 'roundtrip.h5';
try { h5.FS.unlink(vname); } catch (_) {}
h5.FS.writeFile(vname, bytes);
const f = new h5.File(vname, 'r');

let pass = true;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} : ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) pass = false;
}

check('group /telemetry exists',     !!f.get('telemetry'));
check('group /telemetry/SIN exists', !!f.get('telemetry/SIN'));
check('group /telemetry/IMU exists', !!f.get('telemetry/IMU'));

// Scalar SIN
{
  const ds = f.get('telemetry/SIN/values');
  check('dataset /telemetry/SIN/values exists', !!ds);
  if (ds) {
    const arr = ds.value;
    check(`SIN.values length == ${N1}`, arr.length === N1, `actual ${arr.length}`);
    check('SIN.values[0]',        Math.abs(arr[0]      - sinValues[0])      < 1e-5);
    check(`SIN.values[${N1-1}]`,  Math.abs(arr[N1-1]   - sinValues[N1-1])   < 1e-5);
  }
  const wall = f.get('telemetry/SIN/wall_ms');
  check(`SIN.wall_ms length == ${N1}`, wall && wall.value.length === N1);
}

// Vector IMU — values flat I16 of length M*n with shape [M, n]
{
  const ds = f.get('telemetry/IMU/values');
  check('dataset /telemetry/IMU/values exists', !!ds);
  if (ds) {
    const arr = ds.value;
    const expected = N2 * NN2;
    check(`IMU.values length == ${expected}`, arr.length === expected, `actual ${arr.length}`);
    check('IMU.values[0]',                  Number(arr[0])             === imuValues[0]);
    check('IMU.values[3] (start of row 1)', Number(arr[3])             === imuValues[3]);
    check(`IMU.values[${expected - 1}]`,    Number(arr[expected - 1])  === imuValues[expected - 1]);
    if (ds.shape) check(`IMU.values shape == [${N2}, ${NN2}]`,
      ds.shape.length === 2 && Number(ds.shape[0]) === N2 && Number(ds.shape[1]) === NN2,
      `got [${ds.shape.join(', ')}]`);
  }
}

f.close();
await rm(tmp, { recursive: true, force: true });

console.log('---');
if (pass) {
  console.log('OK: HDF5 export round-trip succeeded');
  process.exit(0);
} else {
  console.error('FAIL: HDF5 export round-trip failed — see diagnostics above');
  process.exit(1);
}
