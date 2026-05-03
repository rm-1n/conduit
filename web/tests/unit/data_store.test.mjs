// Unit tests for web/data_store.js — the in-memory time-series store
// that telemetry feeds into and HDF5 export reads from. Pure data
// structure: no DOM, no network. Covered:
//   - empty session state
//   - basic append / single channel
//   - slice windowing (half-open [from, to))
//   - capacity doubling past initial 1024
//   - shape-drift rejection
//   - resetSession
//   - multi-element samples (n > 1)
//   - copy vs subarray semantics

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadModule } from './_load.mjs';

function fresh() {
  // Each test gets a new dataStore so state is isolated.
  return loadModule('data_store.js').Conduit.dataStore;
}

test('empty session: listChannels empty, stats zeroed, session bounds null', () => {
  const ds = fresh();
  assert.deepEqual(ds.listChannels(), []);
  const s = ds.stats();
  assert.equal(s.channels, 0);
  assert.equal(s.samples, 0);
  assert.equal(s.sessionStartWallMs, null);
  assert.equal(s.sessionEndWallMs,   null);
});

test('append registers a channel with correct dtype + n', () => {
  const ds = fresh();
  ds.append({ name: 'SIN', dtype: 8, n: 1, uptimeUs: 1000, wallMs: 100, values: new Float32Array([0.5]) });
  const list = ds.listChannels();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'SIN');
  assert.equal(list[0].dtype, 8);
  assert.equal(list[0].dtypeLabel, 'F32');
  assert.equal(list[0].n, 1);
  assert.equal(list[0].sampleCount, 1);
});

test('slice on unknown channel returns count:0', () => {
  const ds = fresh();
  assert.equal(ds.slice('nope').count, 0);
});

test('slice with default opts returns all samples', () => {
  const ds = fresh();
  for (let i = 0; i < 10; i++) {
    ds.append({ name: 'X', dtype: 4, n: 1, uptimeUs: i * 100, wallMs: i * 10, values: new Int32Array([i]) });
  }
  const s = ds.slice('X');
  assert.equal(s.count, 10);
  assert.deepEqual(Array.from(s.values), [0,1,2,3,4,5,6,7,8,9]);
});

test('slice is half-open [from, to)', () => {
  const ds = fresh();
  for (let i = 0; i < 5; i++) {
    ds.append({ name: 'T', dtype: 4, n: 1, uptimeUs: 0, wallMs: i, values: new Int32Array([i]) });
  }
  // wallMs values: 0,1,2,3,4
  const s = ds.slice('T', { fromWallMs: 1, toWallMs: 4 });
  assert.equal(s.count, 3);
  assert.deepEqual(Array.from(s.values), [1, 2, 3]);
  // toWallMs exclusive — exact match on toWallMs is excluded
  const s2 = ds.slice('T', { fromWallMs: 0, toWallMs: 0 });
  assert.equal(s2.count, 0);
});

test('slice copy:true detaches from live buffer', () => {
  const ds = fresh();
  ds.append({ name: 'C', dtype: 8, n: 1, uptimeUs: 0, wallMs: 100, values: new Float32Array([1.5]) });
  const view = ds.slice('C');                       // subarray view
  const copy = ds.slice('C', { copy: true });       // independent
  // Force capacity growth, which reallocates the underlying typed array
  // and would invalidate any subarray views.
  for (let i = 0; i < 2000; i++) {
    ds.append({ name: 'C', dtype: 8, n: 1, uptimeUs: 0, wallMs: 200 + i, values: new Float32Array([2]) });
  }
  // copy is unaffected (its own buffer)
  assert.equal(copy.values[0], 1.5);
  assert.equal(copy.count, 1);
  // view may be detached now — accept either same value (no realloc yet)
  // or detached (length 0). The contract is just that copy is stable.
  assert.ok(view.values instanceof Float32Array);
});

test('capacity doubles past initial 1024 without dropping samples', () => {
  const ds = fresh();
  const N = 3000;
  for (let i = 0; i < N; i++) {
    ds.append({ name: 'B', dtype: 4, n: 1, uptimeUs: i, wallMs: i, values: new Int32Array([i]) });
  }
  const s = ds.slice('B', { copy: true });
  assert.equal(s.count, N);
  // spot-check first/middle/last
  assert.equal(s.values[0], 0);
  assert.equal(s.values[1500], 1500);
  assert.equal(s.values[N - 1], N - 1);
});

test('shape drift on second append is silently rejected', () => {
  const ds = fresh();
  ds.append({ name: 'S', dtype: 8, n: 1, uptimeUs: 0, wallMs: 1, values: new Float32Array([0]) });
  // Second record claims dtype=4 (I32). Should be ignored.
  ds.append({ name: 'S', dtype: 4, n: 1, uptimeUs: 0, wallMs: 2, values: new Int32Array([7]) });
  // Different n.
  ds.append({ name: 'S', dtype: 8, n: 3, uptimeUs: 0, wallMs: 3, values: new Float32Array([1,2,3]) });
  const list = ds.listChannels()[0];
  assert.equal(list.sampleCount, 1);
  assert.equal(list.dtype, 8);
  assert.equal(list.n, 1);
});

test('resetSession wipes channels and bounds', () => {
  const ds = fresh();
  ds.append({ name: 'R', dtype: 8, n: 1, uptimeUs: 0, wallMs: 10, values: new Float32Array([1]) });
  assert.equal(ds.sessionStartWallMs, 10);
  ds.resetSession();
  assert.equal(ds.listChannels().length, 0);
  assert.equal(ds.sessionStartWallMs, null);
  assert.equal(ds.sessionEndWallMs, null);
  // Stats reflect the wipe
  assert.equal(ds.stats().channels, 0);
});

test('multi-element samples (n=3) interleave correctly', () => {
  const ds = fresh();
  ds.append({ name: 'V', dtype: 8, n: 3, uptimeUs: 0, wallMs: 1, values: new Float32Array([1,2,3]) });
  ds.append({ name: 'V', dtype: 8, n: 3, uptimeUs: 0, wallMs: 2, values: new Float32Array([4,5,6]) });
  const s = ds.slice('V');
  assert.equal(s.count, 2);
  // values is a flat buffer of 6 elements (2 samples × 3)
  assert.deepEqual(Array.from(s.values), [1,2,3,4,5,6]);
});

test('append ignores records with empty name or null values', () => {
  const ds = fresh();
  ds.append({ name: '',     dtype: 8, n: 1, uptimeUs: 0, wallMs: 1, values: new Float32Array([1]) });
  ds.append({ name: 'A',    dtype: 8, n: 1, uptimeUs: 0, wallMs: 1, values: null });
  assert.equal(ds.listChannels().length, 0);
});

test('session bounds track the wall-clock window', () => {
  const ds = fresh();
  ds.append({ name: 'A', dtype: 4, n: 1, uptimeUs: 0, wallMs: 100, values: new Int32Array([1]) });
  ds.append({ name: 'A', dtype: 4, n: 1, uptimeUs: 0, wallMs: 250, values: new Int32Array([2]) });
  ds.append({ name: 'B', dtype: 4, n: 1, uptimeUs: 0, wallMs: 300, values: new Int32Array([3]) });
  // sessionStartWallMs is the FIRST wallMs ever seen; sessionEndWallMs
  // is the most recent. Both move with appends across channels.
  assert.equal(ds.sessionStartWallMs, 100);
  assert.equal(ds.sessionEndWallMs,   300);
});

test('stats aggregates across channels', () => {
  const ds = fresh();
  ds.append({ name: 'A', dtype: 4, n: 1, uptimeUs: 0, wallMs: 1, values: new Int32Array([0]) });
  ds.append({ name: 'A', dtype: 4, n: 1, uptimeUs: 0, wallMs: 2, values: new Int32Array([0]) });
  ds.append({ name: 'B', dtype: 8, n: 2, uptimeUs: 0, wallMs: 3, values: new Float32Array([0, 0]) });
  const s = ds.stats();
  assert.equal(s.channels, 2);
  assert.equal(s.samples,  3);
  // approxBytes: A has 2 × (8+8+4) = 40, B has 1 × (8+8+2*4) = 24 → 64
  assert.equal(s.approxBytes, 64);
});
