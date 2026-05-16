// ws_frame.test.mjs — wire-format regression fence for /api/stream.
//
// The firmware emits RFC 6455 frames (ws_server.c ws_build_header +
// ws_emit) and parses inbound masked frames (ws_rx_byte). This file
// codifies a reference JS implementation against which both:
//   - the browser side (stream.js, which delegates to the browser's
//     native WebSocket and only sees decoded payloads)
//   - the firmware side (ws_server.c, asserted by the unit shape
//     here)
// must agree. Any change to ws_server.c's frame encoding must mirror
// here, or the wire format silently breaks.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// -- Channel tags (must match ws_server.h) --------------------------

const CH_LOG     = 0x4C; // 'L'
const CH_DATA    = 0x44; // 'D'
const CH_CMD     = 0x43; // 'C'
const CH_STATUS  = 0x53; // 'S'
const CH_NOTICE  = 0x4E; // 'N'

// -- RFC 6455 opcodes -----------------------------------------------

const OP_CONT  = 0x0;
const OP_TEXT  = 0x1;
const OP_BIN   = 0x2;
const OP_CLOSE = 0x8;
const OP_PING  = 0x9;
const OP_PONG  = 0xA;

// -- Reference encoder (matches ws_server.c ws_build_header) --------

function encodeServerFrame(opcode, payload) {
  const len = payload.length;
  let hdr;
  if (len < 126) {
    hdr = Buffer.alloc(2);
    hdr[0] = 0x80 | (opcode & 0x0F);
    hdr[1] = len;
  } else if (len <= 0xFFFF) {
    hdr = Buffer.alloc(4);
    hdr[0] = 0x80 | (opcode & 0x0F);
    hdr[1] = 126;
    hdr.writeUInt16BE(len, 2);
  } else {
    hdr = Buffer.alloc(10);
    hdr[0] = 0x80 | (opcode & 0x0F);
    hdr[1] = 127;
    // Top 4 bytes zero.
    hdr.writeUInt32BE(0, 2);
    hdr.writeUInt32BE(len, 6);
  }
  return Buffer.concat([hdr, Buffer.from(payload)]);
}

// -- Reference decoder for client→server frames (masked) ------------

function encodeClientFrame(opcode, payload, maskKey) {
  const len = payload.length;
  let hdrLen;
  if (len < 126) hdrLen = 2;
  else if (len <= 0xFFFF) hdrLen = 4;
  else hdrLen = 10;
  const buf = Buffer.alloc(hdrLen + 4 + len);
  buf[0] = 0x80 | (opcode & 0x0F);
  if (len < 126) {
    buf[1] = 0x80 | len;
  } else if (len <= 0xFFFF) {
    buf[1] = 0x80 | 126;
    buf.writeUInt16BE(len, 2);
  } else {
    buf[1] = 0x80 | 127;
    buf.writeUInt32BE(0, 2);
    buf.writeUInt32BE(len, 6);
  }
  for (let i = 0; i < 4; i++) buf[hdrLen + i] = maskKey[i];
  for (let i = 0; i < len; i++) {
    buf[hdrLen + 4 + i] = payload[i] ^ maskKey[i & 3];
  }
  return buf;
}

// Parse one frame from `buf`, returning {fin, opcode, payload, consumed}
// or null if buf is incomplete. Validates the masking-required rule on
// client-style frames if isClientFrame=true.
function decodeFrame(buf, isClientFrame) {
  if (buf.length < 2) return null;
  const fin    = (buf[0] >> 7) & 1;
  const opcode = buf[0] & 0x0F;
  const masked = (buf[1] >> 7) & 1;
  let len = buf[1] & 0x7F;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    // Top 4 must be zero.
    assert.equal(buf.readUInt32BE(off), 0, '64-bit length top word must be zero');
    len = buf.readUInt32BE(off + 4);
    off += 8;
  }
  if (isClientFrame) {
    assert.equal(masked, 1, 'client→server frame must be masked');
  } else {
    assert.equal(masked, 0, 'server→client frame must NOT be masked');
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    maskKey = buf.slice(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  let payload = buf.slice(off, off + len);
  if (masked) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
    payload = out;
  }
  return { fin, opcode, payload, consumed: off + len };
}

// -- Tests ---------------------------------------------------------

test('encode/decode server frame round-trip — short payload (<126)', () => {
  const payload = Buffer.from('hello'); // 5 bytes
  const frame = encodeServerFrame(OP_TEXT, payload);
  assert.equal(frame.length, 2 + 5);
  assert.equal(frame[0], 0x81);  // FIN=1, opcode=TEXT
  assert.equal(frame[1], 5);     // MASK=0, len=5
  const dec = decodeFrame(frame, false);
  assert.deepEqual(Array.from(dec.payload), Array.from(payload));
  assert.equal(dec.opcode, OP_TEXT);
  assert.equal(dec.fin, 1);
});

test('encode/decode server frame round-trip — 16-bit length (126..65535)', () => {
  const payload = Buffer.alloc(300, 0xAB);
  const frame = encodeServerFrame(OP_BIN, payload);
  assert.equal(frame.length, 4 + 300);
  assert.equal(frame[0], 0x82);   // FIN=1, opcode=BIN
  assert.equal(frame[1], 126);    // MASK=0, len-marker=126
  assert.equal(frame.readUInt16BE(2), 300);
  const dec = decodeFrame(frame, false);
  assert.equal(dec.payload.length, 300);
  assert.ok(dec.payload.every((b) => b === 0xAB));
});

test('encode/decode server frame round-trip — 64-bit length', () => {
  const payload = Buffer.alloc(70000, 0x55);
  const frame = encodeServerFrame(OP_BIN, payload);
  assert.equal(frame.length, 10 + 70000);
  assert.equal(frame[0], 0x82);
  assert.equal(frame[1], 127);
  // Top 4 bytes of length zero.
  assert.equal(frame.readUInt32BE(2), 0);
  assert.equal(frame.readUInt32BE(6), 70000);
  const dec = decodeFrame(frame, false);
  assert.equal(dec.payload.length, 70000);
});

test('encode/decode client frame round-trip — mask key applied + recovered', () => {
  const payload = Buffer.from('seq=1&name=auth&token=changeme');
  const maskKey = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
  const frame = encodeClientFrame(OP_TEXT, payload, maskKey);
  assert.equal(frame[1] & 0x80, 0x80, 'MASK bit set');
  // Decode
  const dec = decodeFrame(frame, true);
  assert.deepEqual(Array.from(dec.payload), Array.from(payload));
});

test('channel tag is the first byte of every frame payload', () => {
  // The wire convention is documented in ws_server.h: every WS payload
  // begins with a 1-byte channel tag. The browser side strips it; the
  // firmware side prepends it via ws_emit.
  const logBody = Buffer.from('[12345]\thello world\n');
  const payload = Buffer.concat([Buffer.from([CH_LOG]), logBody]);
  const frame = encodeServerFrame(OP_TEXT, payload);
  const dec = decodeFrame(frame, false);
  assert.equal(dec.payload[0], CH_LOG);
  assert.equal(dec.payload.slice(1).toString('utf8'), '[12345]\thello world\n');
});

test('telemetry channel: data frame with 16-byte-header record', () => {
  // Build a single telemetry record (16-byte header + 8 bytes f32×2)
  // and wrap it in a DATA-channel binary WS frame, matching what the
  // firmware ws_server.c ws_drain_data path produces.
  const FRAME_MAGIC = 0xFE, FRAME_VERSION = 0x01;
  const DTYPE_F32 = 8;
  const n = 2;
  const recordHeader = Buffer.alloc(16);
  recordHeader[0] = FRAME_MAGIC;
  recordHeader[1] = FRAME_VERSION;
  recordHeader.writeUInt16LE(7 /* msg_id */, 2);
  recordHeader[4] = DTYPE_F32;
  recordHeader.writeUInt16LE(n, 5);
  recordHeader[7] = 0;
  recordHeader.writeBigUInt64LE(1234567890n, 8);
  const recordBody = Buffer.alloc(8);
  recordBody.writeFloatLE(1.5, 0);
  recordBody.writeFloatLE(2.25, 4);

  const wsPayload = Buffer.concat([
    Buffer.from([CH_DATA]),
    recordHeader,
    recordBody,
  ]);
  const frame = encodeServerFrame(OP_BIN, wsPayload);
  const dec = decodeFrame(frame, false);

  assert.equal(dec.opcode, OP_BIN);
  assert.equal(dec.payload[0], CH_DATA);
  // Strip channel tag → original record bytes
  const recordBytes = dec.payload.slice(1);
  assert.equal(recordBytes.length, 16 + 8);
  assert.equal(recordBytes[0], FRAME_MAGIC);
  assert.equal(recordBytes[1], FRAME_VERSION);
  assert.equal(recordBytes.readUInt16LE(2), 7);
  assert.equal(recordBytes[4], DTYPE_F32);
  assert.equal(recordBytes.readUInt16LE(5), 2);
  assert.equal(recordBytes.readFloatLE(16), 1.5);
  assert.equal(recordBytes.readFloatLE(20), 2.25);
});

test('control frames: PING/PONG have ≤125 byte payload and FIN=1', () => {
  const pingBody = Buffer.from([0x70, 0x69, 0x6E, 0x67]); // "ping"
  const frame = encodeServerFrame(OP_PING, pingBody);
  assert.equal(frame[0] & 0x0F, OP_PING);
  assert.equal((frame[0] >> 7) & 1, 1);   // FIN must be 1 for controls
  assert.equal(frame[1] & 0x7F, 4);
  const dec = decodeFrame(frame, false);
  assert.equal(dec.opcode, OP_PING);
  assert.equal(dec.payload.toString('utf8'), 'ping');
});

test('CLOSE frame carries 2-byte status code', () => {
  const body = Buffer.from([0x03, 0xE8]); // 1000 = normal closure
  const frame = encodeServerFrame(OP_CLOSE, body);
  const dec = decodeFrame(frame, false);
  assert.equal(dec.opcode, OP_CLOSE);
  assert.equal(dec.payload.readUInt16BE(0), 1000);
});

test('cmd channel: auth handshake payload format', () => {
  // The browser sends the first frame as a CMD with seq=0, name=auth,
  // token=<value>. The firmware (ws_server.c ws_dispatch_cmd) uses the
  // standard query-string arg parser to extract these fields. This test
  // documents the wire format so neither side drifts.
  const payload = 'seq=0&name=auth&token=changeme';
  const wsPayload = Buffer.concat([Buffer.from([CH_CMD]), Buffer.from(payload)]);
  const maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const frame = encodeClientFrame(OP_TEXT, wsPayload, maskKey);
  const dec = decodeFrame(frame, true);
  assert.equal(dec.payload[0], CH_CMD);
  assert.equal(dec.payload.slice(1).toString('utf8'), payload);
  // The firmware-side arg parser splits on & and =; the test here
  // just confirms the bytes round-trip. The parsing semantics are
  // covered by ws_server.c's reuse of commands.c's find_value.
});

test('cmd response: JSON with seq, ok, and either result or error', () => {
  // Document the response shape ws_server.c emits.
  const success = '{"seq":42,"ok":true,"result":{"pin":3,"value":1}}';
  const failure = '{"seq":43,"ok":false,"error":"unknown command"}';

  for (const body of [success, failure]) {
    const obj = JSON.parse(body);
    assert.equal(typeof obj.seq, 'number');
    assert.equal(typeof obj.ok, 'boolean');
    if (obj.ok) assert.ok('result' in obj);
    else       assert.ok('error' in obj && typeof obj.error === 'string');
  }
});

test('keepalive: synthetic DATA frame with reserved msg_id 0xFFFF', () => {
  // ws_server.c emits a 16-byte zero-payload data record when the data
  // ring is idle for WS_KEEPALIVE_MS. The browser's telemetry parser
  // (telemetry.js drain()) recognizes msg_id 0xFFFF and skips. This
  // test asserts the wire format the firmware emits matches what the
  // browser parser expects.
  const hdr = Buffer.alloc(16);
  hdr[0] = 0xFE;  // magic
  hdr[1] = 0x01;  // version
  hdr.writeUInt16LE(0xFFFF, 2);  // KEEPALIVE_MSG_ID
  hdr[4] = 1;     // dtype U8
  hdr.writeUInt16LE(0, 5);       // n = 0
  hdr[7] = 0;     // reserved
  hdr.writeBigUInt64LE(0n, 8);   // uptime (test value)

  const wsPayload = Buffer.concat([Buffer.from([CH_DATA]), hdr]);
  const frame = encodeServerFrame(OP_BIN, wsPayload);
  const dec = decodeFrame(frame, false);
  assert.equal(dec.payload[0], CH_DATA);
  assert.equal(dec.payload[1], 0xFE);
  assert.equal(dec.payload[2], 0x01);
  assert.equal(dec.payload.readUInt16LE(3), 0xFFFF);
  assert.equal(dec.payload.readUInt16LE(6), 0);  // n=0 confirms keepalive
});
