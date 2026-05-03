// Unit tests for the telemetry wire-format parser exposed at
// window.Conduit.telemetryWire.parseRecord. The parser is the function
// that decodes /api/data?stream=1 frames into per-record events for
// the data store + chart, so any subtle drift here causes silent
// telemetry loss in production.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadModule } from './_load.mjs';

const win = loadModule('telemetry.js');
const wire = win.Conduit.telemetryWire;

// ---- Helpers --------------------------------------------------------

function encodeRecord({ msgId, dtype, n, uptimeUs, payload }) {
  const ESIZE = [1,1,2,2,4,4,8,8,4,8];
  const payloadBytes = n * ESIZE[dtype];
  if (payload.byteLength !== payloadBytes) {
    throw new Error(`payload size mismatch: expected ${payloadBytes}, got ${payload.byteLength}`);
  }
  const buf = new Uint8Array(16 + payloadBytes);
  const dv = new DataView(buf.buffer);
  buf[0] = 0xFE; buf[1] = 0x01;
  dv.setUint16(2, msgId, true);
  dv.setUint8(4, dtype);
  dv.setUint16(5, n, true);
  buf[7] = 0;
  // Split uptimeUs into hi/lo 32-bit halves
  const lo = uptimeUs >>> 0;
  const hi = Math.floor(uptimeUs / 0x100000000);
  dv.setUint32(8, lo, true);
  dv.setUint32(12, hi, true);
  buf.set(payload, 16);
  return buf;
}

function f32Payload(values) {
  const buf = new Uint8Array(values.length * 4);
  const dv = new DataView(buf.buffer);
  values.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  return buf;
}
function u32Payload(values) {
  const buf = new Uint8Array(values.length * 4);
  const dv = new DataView(buf.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v, true));
  return buf;
}
function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.byteLength; }
  return out;
}

// ---- Tests ----------------------------------------------------------

test('parseRecord on empty buffer asks for 1 byte', () => {
  const r = wire.parseRecord(new Uint8Array(0), 0);
  assert.equal(r.kind, 'need');
  assert.equal(r.needBytes, 1);
});

test('parseRecord on partial header asks for 16 bytes', () => {
  const buf = new Uint8Array([0xFE, 0x01, 0, 0]);
  const r = wire.parseRecord(buf, 0);
  assert.equal(r.kind, 'need');
  assert.equal(r.needBytes, 16);
});

test('parseRecord on bad magic returns resync', () => {
  const buf = new Uint8Array(20).fill(0xAA);
  const r = wire.parseRecord(buf, 0);
  assert.equal(r.kind, 'resync');
});

test('parseRecord on bad version returns resync', () => {
  const buf = new Uint8Array(20);
  buf[0] = 0xFE; buf[1] = 0x02;   // version != 1
  const r = wire.parseRecord(buf, 0);
  assert.equal(r.kind, 'resync');
});

test('parseRecord on garbage dtype returns resync', () => {
  const buf = new Uint8Array(20);
  buf[0] = 0xFE; buf[1] = 0x01;
  buf[4] = 99;   // dtype out of range
  const r = wire.parseRecord(buf, 0);
  assert.equal(r.kind, 'resync');
});

test('parseRecord on partial payload asks for full record', () => {
  // Header says n=4 F32s → 16 + 16 = 32 bytes; we provide only 20.
  const buf = new Uint8Array(20);
  buf[0] = 0xFE; buf[1] = 0x01;
  const dv = new DataView(buf.buffer);
  dv.setUint16(2, 7, true);
  dv.setUint8(4, 8);             // F32
  dv.setUint16(5, 4, true);      // n=4
  const r = wire.parseRecord(buf, 0);
  assert.equal(r.kind, 'need');
  assert.equal(r.needBytes, 32);
});

test('parseRecord on F32 scalar decodes header correctly', () => {
  const buf = encodeRecord({
    msgId: 42, dtype: 8, n: 1, uptimeUs: 1234567890,
    payload: f32Payload([3.14]),
  });
  const r = wire.parseRecord(buf, 0);
  assert.equal(r.kind, 'record');
  assert.equal(r.msgId, 42);
  assert.equal(r.dtype, 8);
  assert.equal(r.n, 1);
  assert.equal(r.uptimeUs, 1234567890);
  assert.equal(r.recordBytes, 16 + 4);
  assert.equal(r.payload.byteLength, 4);
  // Decode the payload via wire.readElem to round-trip
  const pdv = new DataView(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength);
  assert.ok(Math.abs(wire.readElem(pdv, 0, 8) - 3.14) < 1e-5);
});

test('parseRecord uptimeUs reaches past 32-bit boundary', () => {
  // 5_000_000_000 µs ≈ 1.4 hours — within the float64 mantissa, beyond u32.
  const big = 5_000_000_000;
  const buf = encodeRecord({
    msgId: 1, dtype: 5, n: 1, uptimeUs: big,
    payload: u32Payload([1234]),
  });
  const r = wire.parseRecord(buf, 0);
  assert.equal(r.uptimeUs, big);
});

test('parseRecord at non-zero offset works', () => {
  const a = encodeRecord({ msgId: 1, dtype: 8, n: 1, uptimeUs: 100, payload: f32Payload([1]) });
  const b = encodeRecord({ msgId: 2, dtype: 8, n: 2, uptimeUs: 200, payload: f32Payload([2,3]) });
  const buf = concat(a, b);
  const r = wire.parseRecord(buf, a.byteLength);
  assert.equal(r.kind, 'record');
  assert.equal(r.msgId, 2);
  assert.equal(r.n, 2);
  assert.equal(r.recordBytes, 16 + 8);
});

test('parseRecord on multi-record buffer drains in sequence', () => {
  const a = encodeRecord({ msgId: 10, dtype: 8, n: 1, uptimeUs: 100, payload: f32Payload([1.5]) });
  const b = encodeRecord({ msgId: 11, dtype: 5, n: 1, uptimeUs: 200, payload: u32Payload([42]) });
  const c = encodeRecord({ msgId: 12, dtype: 8, n: 3, uptimeUs: 300, payload: f32Payload([9, 8, 7]) });
  const buf = concat(a, b, c);
  const records = [];
  let i = 0;
  while (i < buf.byteLength) {
    const r = wire.parseRecord(buf, i);
    if (r.kind === 'need') break;
    if (r.kind === 'resync') { i++; continue; }
    records.push({ id: r.msgId, n: r.n, uptimeUs: r.uptimeUs });
    i += r.recordBytes;
  }
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], { id: 10, n: 1, uptimeUs: 100 });
  assert.deepEqual(records[1], { id: 11, n: 1, uptimeUs: 200 });
  assert.deepEqual(records[2], { id: 12, n: 3, uptimeUs: 300 });
  assert.equal(i, buf.byteLength);
});

test('parseRecord recovers from corruption mid-stream via resync', () => {
  const a = encodeRecord({ msgId: 1, dtype: 8, n: 1, uptimeUs: 100, payload: f32Payload([1]) });
  const noise = new Uint8Array([0x00, 0xAA, 0xBB, 0xCC]);
  const b = encodeRecord({ msgId: 2, dtype: 8, n: 1, uptimeUs: 200, payload: f32Payload([2]) });
  const buf = concat(a, noise, b);
  const records = [];
  let resyncs = 0;
  let i = 0;
  while (i < buf.byteLength) {
    const r = wire.parseRecord(buf, i);
    if (r.kind === 'need') break;
    if (r.kind === 'resync') { i++; resyncs++; continue; }
    records.push(r.msgId);
    i += r.recordBytes;
  }
  assert.deepEqual(records, [1, 2]);
  assert.ok(resyncs >= 4, `expected ≥4 resyncs (skipping noise), got ${resyncs}`);
});

test('dtypeSize matches the wire-format table', () => {
  // KEEP IN SYNC with firmware/app/data_buffer.h (conduit_dtype_t)
  assert.equal(wire.dtypeSize(0), 1);  // I8
  assert.equal(wire.dtypeSize(1), 1);  // U8
  assert.equal(wire.dtypeSize(2), 2);
  assert.equal(wire.dtypeSize(3), 2);
  assert.equal(wire.dtypeSize(4), 4);
  assert.equal(wire.dtypeSize(5), 4);
  assert.equal(wire.dtypeSize(6), 8);
  assert.equal(wire.dtypeSize(7), 8);
  assert.equal(wire.dtypeSize(8), 4);  // F32
  assert.equal(wire.dtypeSize(9), 8);  // F64
  assert.equal(wire.dtypeSize(99), 0); // unknown
});

test('readElem decodes each dtype correctly (LE)', () => {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  // I32 = -7
  dv.setInt32(0, -7, true);
  assert.equal(wire.readElem(dv, 0, 4), -7);
  // U32 = 0xCAFEBABE
  dv.setUint32(0, 0xCAFEBABE, true);
  assert.equal(wire.readElem(dv, 0, 5), 0xCAFEBABE);
  // F32 ≈ π
  dv.setFloat32(0, 3.14, true);
  assert.ok(Math.abs(wire.readElem(dv, 0, 8) - 3.14) < 1e-5);
  // F64 = 2.7182818284
  dv.setFloat64(0, 2.7182818284, true);
  assert.ok(Math.abs(wire.readElem(dv, 0, 9) - 2.7182818284) < 1e-12);
});
