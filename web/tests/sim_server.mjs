// sim_server.mjs — Minimal headless emulator of the PICO-POE device's
// HTTP API. Stand-in for a real board so the browser IDE can be driven
// for UI screenshots, layout/density verification, and Playwright tests
// without flashing hardware.
//
// What it implements:
//   GET  /api/status       → JSON device descriptor (so app.js's scan +
//                            the topbar device picker treat it as real).
//   GET  /api/data_schema  → JSON id→name map for transmit() channels.
//   GET  /api/data?stream=1[&since=N]
//                          → long-lived binary stream of framed records
//                            in the data_buffer.h wire format. Sends an
//                            X-Data-Cursor response header so
//                            telemetry.js's resume-from-cursor logic
//                            works the same way it does against real
//                            firmware.
//   OPTIONS *              → CORS preflight (Access-Control-Allow-Origin: *
//                            + Allow-Headers: X-Auth-Token; matches what
//                            the real /api/* exposes).
//
// What it does NOT implement: /api/upload, /api/commit, /api/reboot,
// /api/cmd, /api/log. The IDE survives without these — they show as
// "n/a" or a one-off error in the UI but don't break telemetry / chart.
//
// Generators: by default emits two scalar F32 channels — SIN at 100 Hz
// and COS at 50 Hz — both with wrap-around at ±1.0 so the chart shows
// recognizable continuous waveforms. Override with env knobs or CLI
// flags (see PARSE OPTIONS below).
//
// Usage:
//   node web/tests/sim_server.mjs                # listens on :8766
//   node web/tests/sim_server.mjs --port 9000
//   node web/tests/sim_server.mjs --rate 1000    # 1 kHz combined emit rate
//
// In the IDE: type `127.0.0.1:8766` in the topbar IP field and click Add.
// The picker will accept it like any LAN device.

import { createServer } from 'node:http';

// ---- PARSE OPTIONS --------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}
const PORT       = Number(flag('--port', process.env.SIM_PORT || 8766));
const HOST       = flag('--host', process.env.SIM_HOST || '127.0.0.1');
const EMIT_HZ    = Number(flag('--rate', 200));   // combined samples-per-second
const VERSION    = flag('--version', 'sim-1.0.0');
const PARTITION  = flag('--partition', 'A');

// Three channels:
//   SIN — F32, slow sine for visual sanity
//   COS — F32, slow cosine for visual sanity
//   SEQ — U32, monotonically increasing counter — tests/data_loss_check.mjs
//         walks this post-recording to detect dropped samples.
let seqCounter = 0;
const CHANNELS = [
  { id: 0, name: 'SIN', dtype: 8 /* F32 */, n: 1,
    sample(tSec) { return Math.sin(2 * Math.PI * 0.5 * tSec); } },
  { id: 1, name: 'COS', dtype: 8 /* F32 */, n: 1,
    sample(tSec) { return Math.cos(2 * Math.PI * 1.3 * tSec); } },
  { id: 2, name: 'SEQ', dtype: 5 /* U32 */, n: 1,
    sample()     { return seqCounter++; } },
];

const SCHEMA = Object.fromEntries(CHANNELS.map((c) => [c.id, c.name]));

// ---- WIRE FORMAT ---------------------------------------------------------
//
// 16-byte header, KEEP IN SYNC with firmware/app/data_buffer.h:
//   off  size  field
//   0    1     magic    = 0xFE
//   1    1     version  = 0x01
//   2    2     msg_id   LE u16
//   4    1     dtype    u8
//   5    2     n        LE u16  element count (NOT bytes)
//   7    1     reserved 0
//   8    8     uptime_us LE u64
//  16    ...   payload
const HDR_SIZE  = 16;
const ESIZE = [1, 1, 2, 2, 4, 4, 8, 8, 4, 8];   // by dtype id

function encodeRecord(channel, uptimeUs, value) {
  const payloadSize = channel.n * ESIZE[channel.dtype];
  const buf = Buffer.alloc(HDR_SIZE + payloadSize);
  buf.writeUInt8(0xFE, 0);
  buf.writeUInt8(0x01, 1);
  buf.writeUInt16LE(channel.id, 2);
  buf.writeUInt8(channel.dtype, 4);
  buf.writeUInt16LE(channel.n, 5);
  buf.writeUInt8(0, 7);
  buf.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(uptimeUs))), 8);
  // Per-dtype payload writer. Extend if the sim grows new dtypes.
  switch (channel.dtype) {
    case 5: // U32
      for (let k = 0; k < channel.n; k++) buf.writeUInt32LE(value >>> 0, HDR_SIZE + k * 4);
      break;
    case 8: // F32
      for (let k = 0; k < channel.n; k++) buf.writeFloatLE(value, HDR_SIZE + k * 4);
      break;
    default:
      throw new Error(`sim doesn't emit dtype ${channel.dtype} yet`);
  }
  return buf;
}

// ---- STATE ---------------------------------------------------------------
//
// Sim-side ring buffer mirroring firmware's data_buffer.c: bytes go in
// at one end, evicted at the other when full, and each /api/data
// reader has its own cursor that replays anything still resident.
//
// Why a global ticker instead of per-client: the real firmware emits
// telemetry continuously regardless of network state; samples generated
// during a network blip are LOST if the ring evicts them before the
// client reconnects. The test must reproduce that behavior, otherwise
// dropping the connection produces a (misleading) "0% loss" result.

const startWallMs = Date.now();
let totalBytesGenerated = 0;     // monotonic device-side cursor (lifetime byte count)
const RING_SIZE = 256 * 1024;    // 256 KB — generous; firmware is 32 KB
const ring = Buffer.alloc(RING_SIZE);
let ringHead = 0;                // index of NEXT byte to write within `ring`
                                  // bytes from (totalBytesGenerated - RING_SIZE) to
                                  // (totalBytesGenerated - 1) are still resident;
                                  // anything older has been evicted.

function ringAppend(buf) {
  // Wrap-around append.
  for (let off = 0; off < buf.length; ) {
    const writable = Math.min(buf.length - off, RING_SIZE - ringHead);
    buf.copy(ring, ringHead, off, off + writable);
    ringHead = (ringHead + writable) % RING_SIZE;
    off += writable;
  }
  totalBytesGenerated += buf.length;
}

// Read [from, to) where `from` and `to` are absolute byte offsets in
// the lifetime stream. Clamps `from` if out-of-window. Returns null if
// nothing readable, otherwise a Buffer with the requested slice.
function ringRead(from, to) {
  const earliest = Math.max(0, totalBytesGenerated - RING_SIZE);
  if (from < earliest) from = earliest;
  if (to > totalBytesGenerated) to = totalBytesGenerated;
  if (from >= to) return null;
  const out = Buffer.alloc(to - from);
  const startPos = (ringHead - (totalBytesGenerated - from) + RING_SIZE) % RING_SIZE;
  for (let off = 0; off < out.length; ) {
    const readable = Math.min(out.length - off, RING_SIZE - ((startPos + off) % RING_SIZE));
    ring.copy(out, off, (startPos + off) % RING_SIZE,
              (startPos + off) % RING_SIZE + readable);
    off += readable;
  }
  return out;
}

// Global generator — always running, regardless of client count.
const GLOBAL_TICK_MS = 1000 / EMIT_HZ;
let nextChannelIdx = 0;
setInterval(() => {
  const channel = CHANNELS[nextChannelIdx];
  nextChannelIdx = (nextChannelIdx + 1) % CHANNELS.length;
  const uptimeUs = (Date.now() - startWallMs) * 1000;
  const tSec = uptimeUs / 1e6;
  const value = channel.sample(tSec);
  const buf = encodeRecord(channel, uptimeUs, value);
  ringAppend(buf);
}, GLOBAL_TICK_MS);

// ---- HELPERS -------------------------------------------------------------

function sendCors(res, extra = {}) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Auth-Token,Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  // Custom response headers like X-Data-Cursor / X-Log-Cursor have to
  // be explicitly exposed via CORS, otherwise res.headers.get() in the
  // browser returns null even though the header is on the wire.
  // Without this, telemetry.js's cursor handling silently falls back
  // to 0 on every reconnect → next &since= request is too low → sim
  // replays old bytes → dataStore fills with duplicates.
  res.setHeader('Access-Control-Expose-Headers', 'X-Data-Cursor,X-Log-Cursor');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

function sendJson(res, code, body) {
  const json = JSON.stringify(body);
  sendCors(res, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.statusCode = code;
  res.end(json);
}

// ---- ROUTES --------------------------------------------------------------

function handleStatus(_req, res) {
  sendJson(res, 200, {
    device:    'pico-poe',
    version:   VERSION,
    partition: PARTITION,
    mac:       '00:DE:AD:BE:EF:01',
    board_id:  'sim',
    ip:        `${HOST}:${PORT}`,
    uptime_ms: Date.now() - startWallMs,
    link:      'up',
    poe:       'unknown',
  });
}

function handleSchema(_req, res) {
  sendJson(res, 200, SCHEMA);
}

// /api/data?stream=1[&since=N] — long-lived octet-stream of records.
//
// Mirrors enough of the device's behavior that telemetry.js's "trust the
// X-Data-Cursor header" path works: we report the current totalBytesSent
// at connect time, then advance it as we write bytes. We don't actually
// honor `since` (no ring buffer to replay from in the sim) — the IDE
// resyncs to the new cursor on reconnect via the same header.
// Active streaming responses — POST /sim/drop terminates all of them
// so test drivers can inject network-blip scenarios without restarting
// the sim (keeps seqCounter monotonic across the outage).
const activeStreams = new Set();

let connSeq = 0;
function handleStreamData(req, res) {
  // Honor `since=N` like the real device — if the cursor is still
  // within the ring, the client gets a backfill of everything since
  // disconnect; if it's been evicted, we send only what's currently
  // available (matching the firmware's clamp-then-tail behavior).
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Use has() — Number(null)===0 means a missing &since= would parse
  // as cursor 0 and we'd dump the entire ring at every fresh connect.
  const sinceParam = url.searchParams.has('since')
    ? Number(url.searchParams.get('since')) : NaN;
  const earliest = Math.max(0, totalBytesGenerated - RING_SIZE);
  let cursor;
  if (!Number.isFinite(sinceParam)) {
    cursor = totalBytesGenerated;        // fresh tail — no backfill
  } else if (sinceParam > totalBytesGenerated) {
    // Stale cursor from a previous device session (or reboot). Mirror
    // firmware ≥ v1.1.3 behavior: clamp to current total instead of
    // reading garbage out of the ring.
    cursor = totalBytesGenerated;
  } else {
    cursor = Math.max(sinceParam, earliest);
  }
  const cid = ++connSeq;
  console.log(`[sim] conn#${cid} OPEN  since=${url.searchParams.get('since')||'(none)'}  ` +
              `=> cursor=${cursor}  total=${totalBytesGenerated}  ` +
              `backfill=${totalBytesGenerated - cursor}  ` +
              `activeBefore=${activeStreams.size}`);

  sendCors(res, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Data-Cursor': String(cursor),
    'Connection':    'keep-alive',
  });
  res.statusCode = 200;
  res.flushHeaders();
  activeStreams.add(res);

  // First write: any backfill the cursor is behind by.
  if (cursor < totalBytesGenerated) {
    const back = ringRead(cursor, totalBytesGenerated);
    if (back) { res.write(back); cursor = totalBytesGenerated; }
  }

  // Per-client poll loop: every tick, send anything new since the
  // client's cursor. Decoupled from the global generator so a slow
  // client doesn't block generation.
  const tick = () => {
    if (res.writableEnded) return;
    if (cursor < totalBytesGenerated) {
      const buf = ringRead(cursor, totalBytesGenerated);
      if (buf) { res.write(buf); cursor = totalBytesGenerated; }
    }
  };

  const handle = setInterval(tick, GLOBAL_TICK_MS);
  const cleanup = () => {
    if (!activeStreams.has(res)) return;
    clearInterval(handle);
    activeStreams.delete(res);
    console.log(`[sim] conn#${cid} CLOSE final-cursor=${cursor}  active=${activeStreams.size}`);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

// POST /sim/drop — terminate every open /api/data stream so the client
// has to reconnect. Used by data-loss tests; doesn't reset seqCounter.
function handleSimDrop(_req, res) {
  let n = 0;
  for (const r of activeStreams) {
    try { r.destroy(); } catch (_) {}
    n++;
  }
  activeStreams.clear();
  sendJson(res, 200, { dropped: n });
}

// ---- SERVER --------------------------------------------------------------

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') { sendCors(res); res.statusCode = 204; res.end(); return; }

  if (req.method === 'GET' && path === '/api/status')      return handleStatus(req, res);
  if (req.method === 'GET' && path === '/api/data_schema') return handleSchema(req, res);
  if (req.method === 'GET' && path === '/api/data')        return handleStreamData(req, res);
  if (req.method === 'POST' && path === '/sim/drop')       return handleSimDrop(req, res);

  // Stub: every other endpoint returns a benign 200/204 so the IDE's
  // periodic probes (status polls, log polls) don't paint as errors.
  if (req.method === 'GET' && path === '/api/log') {
    sendCors(res, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.statusCode = 200;
    res.end('');
    return;
  }
  sendCors(res); res.statusCode = 404; res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`sim_server: listening on http://${HOST}:${PORT}`);
  console.log(`sim_server: emitting ${CHANNELS.map((c) => c.name).join(', ')} at ${EMIT_HZ} Hz combined`);
  console.log(`sim_server: in the IDE, set the IP to ${HOST}:${PORT} and click Add`);
});
