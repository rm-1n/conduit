// sim_server.mjs — Minimal headless emulator of the CONDUIT device's
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
import { createHash, randomBytes } from 'node:crypto';

// ---- PARSE OPTIONS --------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}
function hasFlag(name) {
  return argv.indexOf(name) >= 0;
}
const PORT       = Number(flag('--port', process.env.SIM_PORT || 8766));
const HOST       = flag('--host', process.env.SIM_HOST || '127.0.0.1');
const EMIT_HZ    = Number(flag('--rate', 200));   // combined samples-per-second
const VERSION    = flag('--version', 'sim-1.0.0');
const PARTITION  = flag('--partition', 'A');
// Synthetic binary_version revision — counts up each time the sim
// boots so a test that probes /api/status across restarts can tell
// recordings apart. The real firmware burns this into the picobin
// header via pico_set_binary_version().
const BINARY_REVISION = Number(flag('--binary-rev', Math.floor(Date.now() / 1000) % 1000));

// ---- WS test-mode knobs ---------------------------------------------------
//
// Built to drive IDE reconnect tests deterministically against the
// emulator so a real Chromium can pound on /api/stream the same way
// ws-probe does — but without the LAN-private-IP-from-localhost PNA
// blocker that kills wss:// driving through Playwright.
//
// --ws-close-after-ms N : every WS that completes auth is force-closed
//                         N ms after auth. Cycles the connection so
//                         the IDE's reconnect path is exercised.
// --ws-cycle-count N    : with --ws-close-after-ms, stop closing after
//                         N forced disconnects (0 = forever, default).
// --auth-delay-ms N     : delay the CMD-auth reply by N ms — simulates
//                         a slow handshake for stress-testing the
//                         reconnect indicator.
// --ws-quiet            : suppress per-frame DEV logs from the WS path
//                         when this would otherwise flood the console.
const WS_CLOSE_AFTER_MS = Number(flag('--ws-close-after-ms', 0));     // 0 = never
const WS_CYCLE_COUNT    = Number(flag('--ws-cycle-count', 0));         // 0 = forever
const AUTH_DELAY_MS     = Number(flag('--auth-delay-ms', 0));          // 0 = immediate
const WS_QUIET          = hasFlag('--ws-quiet');

// Mutable simulation state — modified by /api/cmd handlers below so the
// IDE's command UI has something visibly observable to drive.
const simState = {
  amp: 1.0,   // amplitude scaling for the SIN/COS waveforms
};

// Three channels:
//   SIN — F32, slow sine for visual sanity (scaled by simState.amp)
//   COS — F32, slow cosine for visual sanity (scaled by simState.amp)
//   SEQ — U32, monotonically increasing counter — tests/data_loss_check.mjs
//         walks this post-recording to detect dropped samples.
let seqCounter = 0;
const CHANNELS = [
  { id: 0, name: 'SIN', dtype: 8 /* F32 */, n: 1,
    sample(tSec) { return simState.amp * Math.sin(2 * Math.PI * 0.5 * tSec); } },
  { id: 1, name: 'COS', dtype: 8 /* F32 */, n: 1,
    sample(tSec) { return simState.amp * Math.cos(2 * Math.PI * 1.3 * tSec); } },
  { id: 2, name: 'SEQ', dtype: 5 /* U32 */, n: 1,
    sample()     { return seqCounter++; } },
];

// Command registry — analog of firmware's on_command()/conduit_command_register().
// Handlers receive the parsed query args object and return either
//   { ok: true,  result: <anything> }  — surfaced in the netcon as the
//                                        success payload; mirrors the
//                                        IDE's `body.result || body` read
//                                        path in commands.js
//   { ok: false, error: '...' }        — sent with HTTP 400 so the IDE
//                                        shows it as a command error
const COMMANDS = {
  // POST /api/cmd?name=set_amp&value=<float>
  // Mirrors ide.js's documented set_amp example. Clamps to [0, 5] to
  // match the typical user-code pattern; out-of-range returns an
  // error the IDE renders in the telemetry console.
  set_amp(args) {
    const v = Number(args.value);
    if (!Number.isFinite(v)) {
      return { ok: false, error: 'value must be a finite number' };
    }
    if (v < 0 || v > 5) {
      return { ok: false, error: 'value must be in [0.0, 5.0]' };
    }
    const prev = simState.amp;
    simState.amp = v;
    return { ok: true, result: { amp: v, prev } };
  },
};

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
    device:    'conduit',
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

// POST /api/cmd?name=<cmd>&<arg>=<val>... — invoke a registered command
// handler. Args are query params (mirrors firmware behavior); body is
// ignored. The IDE's commands.js sends only via query string.
function handleCmd(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const name = url.searchParams.get('name') || '';
  const args = {};
  for (const [k, v] of url.searchParams) {
    if (k !== 'name') args[k] = v;
  }
  const handler = COMMANDS[name];
  if (!handler) {
    sendJson(res, 404, { ok: false, error: `unknown command "${name}"` });
    return;
  }
  let result;
  try { result = handler(args); }
  catch (e) {
    sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
    return;
  }
  sendJson(res, result.ok ? 200 : 400, result);
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
  if (req.method === 'POST' && path === '/sim/ws_drop')    return handleSimWsDrop(req, res);
  if (req.method === 'POST' && path === '/api/cmd')        return handleCmd(req, res);

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

// ---- /api/stream WebSocket endpoint --------------------------------------
//
// Mirrors firmware/app/ws_server.c's channel-tagged frame contract:
//   'N' notice  — first frame after Upgrade is {"kind":"need_auth"}
//   'C' cmd     — client sends seq=0&name=auth&token=…, we reply
//                 {"seq":0,"ok":true,"result":{"authed":true}} then push
//                 a 'S' STATUS frame; any later named CMD gets a benign
//                 ok:true reply so commands.js's pendingCmds resolves.
//   'S' status  — JSON device snapshot, same shape as /api/status.
//   'D' data    — binary frames of 16-byte-header records reusing the
//                 ringRead() machinery so the WS stream is byte-for-byte
//                 the same as /api/data?stream=1.
//   'L' log     — text frames, one or more newline-terminated lines.
//
// All frames go through ws_emit_frame() so the wire format matches
// firmware's ws_emit() and the encoder in web/tests/unit/ws_frame.test.mjs.

// RFC 6455 GUID for Sec-WebSocket-Accept derivation. Same constant in
// firmware/app/http_server.c.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Channel tags (must match ws_server.h on the firmware side).
const WS_CH_LOG    = 0x4C;  // 'L'
const WS_CH_DATA   = 0x44;  // 'D'
const WS_CH_CMD    = 0x43;  // 'C'
const WS_CH_STATUS = 0x53;  // 'S'
const WS_CH_NOTICE = 0x4E;  // 'N'

// Opcodes.
const WS_OP_CONT  = 0x0;
const WS_OP_TEXT  = 0x1;
const WS_OP_BIN   = 0x2;
const WS_OP_CLOSE = 0x8;
const WS_OP_PING  = 0x9;
const WS_OP_PONG  = 0xA;

// Build an RFC 6455 server frame. Server→client frames are never masked.
// Reference impl matches `encodeServerFrame` in web/tests/unit/ws_frame.test.mjs
// (which is the wire-format regression fence).
function wsBuildFrame(opcode, payload) {
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
    hdr.writeUInt32BE(0, 2);
    hdr.writeUInt32BE(len, 6);
  }
  return Buffer.concat([hdr, payload]);
}

// Channel-tagged emit: prepend a 1-byte tag and send as TEXT or BIN.
// `payload` may be a string (auto-Buffer'd as utf-8) or a Buffer.
function wsEmitChannel(sock, opcode, channel, payload) {
  if (sock.destroyed || !sock.writable) return false;
  if (typeof payload === 'string') payload = Buffer.from(payload, 'utf-8');
  const tagged = Buffer.alloc(payload.length + 1);
  tagged[0] = channel;
  payload.copy(tagged, 1);
  const frame = wsBuildFrame(opcode, tagged);
  try { sock.write(frame); return true; } catch (_) { return false; }
}

function wsEmitText(sock, channel, text)  { return wsEmitChannel(sock, WS_OP_TEXT, channel, text); }
function wsEmitBin(sock,  channel, bytes) { return wsEmitChannel(sock, WS_OP_BIN,  channel, bytes); }

function wsEmitControl(sock, opcode, payload) {
  if (sock.destroyed || !sock.writable) return false;
  if (payload == null) payload = Buffer.alloc(0);
  if (typeof payload === 'string') payload = Buffer.from(payload, 'utf-8');
  if (payload.length > 125) return false;
  try { sock.write(wsBuildFrame(opcode, payload)); return true; } catch (_) { return false; }
}

function wsSendClose(sock, code = 1000) {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(code, 0);
  wsEmitControl(sock, WS_OP_CLOSE, body);
}

// Streaming frame parser for client→server frames. Holds incomplete
// bytes between data events; each call attempts to extract zero or
// more frames from the accumulated buffer and hand them to `onFrame`.
function makeFrameParser(onFrame, onError) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin    = (buf[0] >> 7) & 1;
      if (buf[0] & 0x70) { onError('rsv-set'); return; }
      const opcode = buf[0] & 0x0F;
      const masked = (buf[1] >> 7) & 1;
      if (!masked) { onError('client-not-masked'); return; }
      let len = buf[1] & 0x7F;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        if (buf.readUInt32BE(off) !== 0) { onError('64-bit-overflow'); return; }
        len = buf.readUInt32BE(off + 4);
        off += 8;
      }
      if (buf.length < off + 4 + len) return;
      const mask = buf.slice(off, off + 4);
      off += 4;
      const masked_payload = buf.slice(off, off + len);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = masked_payload[i] ^ mask[i & 3];
      buf = buf.slice(off + len);
      onFrame({ fin, opcode, payload });
    }
  };
}

// Per-connection state. Tracks auth status, the data ring cursor, and
// the periodic emit handles so `ws.close()` cleans them up exactly once.
let wsConnSeq = 0;
let wsCyclesFired = 0;
const activeWsConns = new Set();
function wsLog(msg) { if (!WS_QUIET) console.log('[sim/ws]', msg); }

function handleWsUpgrade(req, sock /*, head */) {
  // RFC 6455 §4.1 — compute Sec-WebSocket-Accept from the client's nonce.
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    sock.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    sock.destroy();
    return;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  const upgradeResponse =
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n';
  sock.write(upgradeResponse);

  const cid = ++wsConnSeq;
  wsLog(`conn#${cid} OPEN  (active=${activeWsConns.size + 1})`);

  // Per-conn state.
  const state = {
    cid,
    sock,
    authed: false,
    dataCursor: totalBytesGenerated,    // tail-of-ring fresh start, same as /api/data?stream=1
    logSince: 0,                        // index into emitted log lines
    drainHandle: null,
    closeAfterHandle: null,
    pingHandle: null,
    closed: false,
  };
  activeWsConns.add(state);

  // The actual emit-only drain loop runs at the same cadence as
  // /api/data?stream=1 (GLOBAL_TICK_MS); on each tick we ship any
  // ring bytes accumulated since the last cursor + a periodic log
  // line so the IDE's runtime-console has something to display.
  const drain = () => {
    if (state.closed) return;
    if (state.dataCursor < totalBytesGenerated) {
      const buf = ringRead(state.dataCursor, totalBytesGenerated);
      if (buf) {
        wsEmitBin(sock, WS_CH_DATA, buf);
        state.dataCursor = totalBytesGenerated;
      }
    }
    // 4 Hz log line — small enough to not flood, frequent enough that
    // the IDE's console pane shows fresh content every ~250 ms after a
    // reconnect (the visualization-latency budget is 2 s; we want lots
    // of headroom).
    //
    // Format MATCHES firmware/app/log_buffer.c's emit shape:
    //   "[<uptime_us>]\t<msg>\n"
    // console.js::processLine's PREFIX_RE silently drops anything that
    // doesn't fit this prefix (because the IDE needs the uptime_us to
    // anchor each line to the device's monotonic clock for the run-log
    // store + reboot-detection logic). Without the prefix the sim
    // looks broken to the IDE.
    const SIM_LOG_HZ = 4;
    const wantLogIdx = Math.floor((Date.now() - startWallMs) / (1000 / SIM_LOG_HZ));
    if (wantLogIdx > state.logSince) {
      const lines = [];
      for (let i = state.logSince + 1; i <= wantLogIdx; i++) {
        const uptimeUs = Math.round(i * (1_000_000 / SIM_LOG_HZ));
        lines.push(`[${uptimeUs}]\tsim tick=${i}, amp=${simState.amp.toFixed(3)}`);
      }
      state.logSince = wantLogIdx;
      wsEmitText(sock, WS_CH_LOG, lines.join('\n') + '\n');
    }
  };

  // ----- inbound frame handler ----------------------------------------
  const parser = makeFrameParser(
    (frame) => {
      const { fin, opcode, payload } = frame;
      if (opcode === WS_OP_PING) {
        wsEmitControl(sock, WS_OP_PONG, payload);
        return;
      }
      if (opcode === WS_OP_PONG) return;
      if (opcode === WS_OP_CLOSE) { wsSendClose(sock, 1000); cleanup('peer-close'); return; }
      if (opcode !== WS_OP_TEXT && opcode !== WS_OP_BIN) return;
      if (payload.length < 1) return;
      const ch = payload[0];
      const body = payload.slice(1).toString('utf-8');
      if (ch === WS_CH_CMD) handleCmdFrame(body);
      // Other channels from client are unexpected; firmware sends a
      // 'bad_channel' NOTICE — emulate that for parity.
      else wsEmitText(sock, WS_CH_NOTICE, JSON.stringify({ kind: 'bad_channel', detail: '' }));
    },
    (err) => {
      wsLog(`conn#${cid} parse error: ${err}`);
      cleanup('parse-error');
    }
  );

  // Auth + dispatch. CMD payload is `seq=N&name=NAME&...`.
  function handleCmdFrame(qs) {
    const params = new URLSearchParams(qs);
    const seq = Number(params.get('seq'));
    const name = params.get('name') || '';
    const reply = (ok, result_or_error) => {
      const body = ok
        ? JSON.stringify({ seq, ok: true, result: result_or_error })
        : JSON.stringify({ seq, ok: false, error: result_or_error });
      wsEmitText(sock, WS_CH_CMD, body);
    };
    if (!state.authed) {
      if (name !== 'auth') { reply(false, 'auth required'); return; }
      const finish = () => {
        if (state.closed) return;
        state.authed = true;
        reply(true, { authed: true });
        // Push the initial STATUS snapshot — same shape as /api/status.
        // Inline `data_schema` so the IDE doesn't have to do a separate
        // /api/data_schema fetch (which on a real device over wss is a
        // full TLS handshake on top of the existing WebSocket — the
        // dominant contributor to the "LED green, wait several seconds,
        // then chart fills" symptom).
        wsEmitText(sock, WS_CH_STATUS, JSON.stringify({
          device:         'conduit',
          version:        VERSION,
          // Mirror the real firmware's pico_set_binary_version field
          // — used by the IDE's build-log [device] line + by OTA
          // workflows to confirm which partition's image is live.
          binary_version: `0.${BINARY_REVISION}`,
          partition:      PARTITION,
          mac:            '00:DE:AD:BE:EF:01',
          board_id:       'sim',
          ip:             `${HOST}:${PORT}`,
          uptime_ms:      Date.now() - startWallMs,
          link:           'up',
          poe:            'unknown',
          data_schema:    SCHEMA,
        }));
        // Reset cursors to live-tail and start the drain ticker.
        state.dataCursor = totalBytesGenerated;
        // Anchor logSince to the same 4 Hz bucket math the drain
        // tick uses below — without this the very first reconnect
        // emits a backlog of every log line since boot.
        state.logSince = Math.floor((Date.now() - startWallMs) / (1000 / 4));
        state.drainHandle = setInterval(drain, GLOBAL_TICK_MS);
        // Arm the forced-close knob if requested.
        if (WS_CLOSE_AFTER_MS > 0 &&
            (WS_CYCLE_COUNT === 0 || wsCyclesFired < WS_CYCLE_COUNT)) {
          state.closeAfterHandle = setTimeout(() => {
            wsCyclesFired++;
            wsLog(`conn#${cid} forced close (cycle ${wsCyclesFired}` +
                  (WS_CYCLE_COUNT ? `/${WS_CYCLE_COUNT}` : '') + `)`);
            wsSendClose(sock, 1000);
            cleanup('forced-close');
          }, WS_CLOSE_AFTER_MS);
        }
      };
      if (AUTH_DELAY_MS > 0) setTimeout(finish, AUTH_DELAY_MS);
      else finish();
      return;
    }
    // Authed CMD — anything goes; mirror the IDE's set_amp / generic
    // commands so commands.js's pendingCmds.resolve fires.
    const handler = COMMANDS[name];
    if (!handler) { reply(true, {}); return; }   // unknown but harmless
    try {
      const out = handler(Object.fromEntries(params));
      if (out.ok) reply(true, out.result);
      else        reply(false, out.error);
    } catch (e) { reply(false, String(e && e.message || e)); }
  }

  // ----- lifecycle ----------------------------------------------------
  function cleanup(reason) {
    if (state.closed) return;
    state.closed = true;
    activeWsConns.delete(state);
    if (state.drainHandle)      { clearInterval(state.drainHandle);      state.drainHandle = null; }
    if (state.closeAfterHandle) { clearTimeout(state.closeAfterHandle); state.closeAfterHandle = null; }
    if (state.pingHandle)       { clearInterval(state.pingHandle);      state.pingHandle = null; }
    try { sock.end(); } catch (_) {}
    try { sock.destroy(); } catch (_) {}
    wsLog(`conn#${cid} CLOSE reason=${reason}  (active=${activeWsConns.size})`);
  }
  sock.on('data',  parser);
  sock.on('error', () => cleanup('sock-error'));
  sock.on('close', () => cleanup('sock-close'));
  sock.setNoDelay(true);

  // First frame after Upgrade: need_auth notice. Matches firmware
  // ws_server_on_open() → ws_push_notice("need_auth", "").
  wsEmitText(sock, WS_CH_NOTICE, JSON.stringify({ kind: 'need_auth' }));
}

server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (url.pathname === '/api/stream') return handleWsUpgrade(req, sock, head);
  sock.write('HTTP/1.1 404 Not Found\r\n\r\n');
  sock.destroy();
});

// POST /sim/ws_drop — terminate every open WS so a test driver can
// trigger a manual disconnect without arranging --ws-close-after-ms.
// Routing wired into the main createServer handler below (search for
// handleSimWsDrop) — kept here next to the other WS plumbing so the
// surface is colocated.
function handleSimWsDrop(_req, res) {
  let n = 0;
  for (const s of [...activeWsConns]) {
    try { wsSendClose(s.sock, 1000); s.sock.destroy(); n++; } catch (_) {}
  }
  activeWsConns.clear();
  sendJson(res, 200, { dropped: n });
}

server.listen(PORT, HOST, () => {
  console.log(`sim_server: listening on http://${HOST}:${PORT}`);
  console.log(`sim_server: emitting ${CHANNELS.map((c) => c.name).join(', ')} at ${EMIT_HZ} Hz combined`);
  console.log(`sim_server: in the IDE, set the IP to ${HOST}:${PORT} and click Add`);
  if (WS_CLOSE_AFTER_MS > 0) {
    console.log(`sim_server: WS test mode — forced close ${WS_CLOSE_AFTER_MS} ms after auth` +
                (WS_CYCLE_COUNT ? ` (max ${WS_CYCLE_COUNT} cycles)` : ' (unlimited)'));
  }
  if (AUTH_DELAY_MS > 0) console.log(`sim_server: WS auth reply delayed ${AUTH_DELAY_MS} ms`);
});
