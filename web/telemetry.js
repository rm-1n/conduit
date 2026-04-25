// telemetry.js — tails /api/data?stream=1, parses framed binary records,
// labels them via /api/data_schema, persists into IndexedDB (log_store
// data_records), and forwards to the chart pane.
//
// Wire format (firmware/app/data_buffer.h):
//   offset  size  field
//   0       1     magic    = 0xFE
//   1       1     version  = 0x01
//   2       2     msg_id   LE u16
//   4       1     dtype    u8 (poe_dtype_t)
//   5       2     n        LE u16  element count, NOT bytes
//   7       1     reserved 0
//   8       8     uptime_us LE u64
//   16      ...   payload  n * elem_size bytes
//
// Reconnect / reboot semantics mirror console.js — the chart pane is
// driven by the same stream-then-buffer-then-render loop.

(function () {
  'use strict';

  const RECONNECT_OK_MS    = 100;
  const RECONNECT_ERR_MS   = 2000;
  const IP_CHECK_MS        = 1000;
  const SCHEMA_REFRESH_MIN_MS = 1000;
  const PERSIST_BATCH_MAX  = 64;
  const PERSIST_BATCH_MS   = 250;

  const DTYPE_I8 = 0, DTYPE_U8 = 1, DTYPE_I16 = 2, DTYPE_U16 = 3,
        DTYPE_I32 = 4, DTYPE_U32 = 5, DTYPE_I64 = 6, DTYPE_U64 = 7,
        DTYPE_F32 = 8, DTYPE_F64 = 9;

  function dtypeSize(d) {
    switch (d) {
      case DTYPE_I8: case DTYPE_U8:  return 1;
      case DTYPE_I16: case DTYPE_U16: return 2;
      case DTYPE_I32: case DTYPE_U32: case DTYPE_F32: return 4;
      case DTYPE_I64: case DTYPE_U64: case DTYPE_F64: return 8;
      default: return 0;
    }
  }

  // Decode a single element from a DataView at offset `o`. Returns Number
  // for everything except 64-bit ints, which we coerce via Number(BigInt)
  // since charts/HDF5 don't need bit-exact 64-bit precision.
  function readElem(dv, o, dtype) {
    switch (dtype) {
      case DTYPE_I8:  return dv.getInt8(o);
      case DTYPE_U8:  return dv.getUint8(o);
      case DTYPE_I16: return dv.getInt16(o, true);
      case DTYPE_U16: return dv.getUint16(o, true);
      case DTYPE_I32: return dv.getInt32(o, true);
      case DTYPE_U32: return dv.getUint32(o, true);
      case DTYPE_I64: return Number(dv.getBigInt64(o, true));
      case DTYPE_U64: return Number(dv.getBigUint64(o, true));
      case DTYPE_F32: return dv.getFloat32(o, true);
      case DTYPE_F64: return dv.getFloat64(o, true);
      default: return 0;
    }
  }

  let stateEl = null;
  let getIp = () => null;

  let cursor = null;
  let knownIp = null;
  let stopped = false;
  let activeAbort = null;
  let ipWatchHandle = null;

  // Schema: id → name. Refreshed on connect, on reboot, and when an
  // unknown id appears (rate-limited).
  let schema = new Map();
  let lastSchemaFetchMs = 0;

  // Run/persistence (mirrors console.js)
  let currentRun = null;
  let lastUptimeUs = null;
  let wallMsAnchor = null;
  let persistBatch = [];
  let persistTimer = null;

  // Parser state — bytes carried across chunks while we're mid-record.
  let parseBuf = new Uint8Array(0);

  function setState(text, cls) {
    if (!stateEl) return;
    stateEl.textContent = text;
    stateEl.style.color = cls === 'err' ? 'var(--red)'
                       : cls === 'ok'  ? 'var(--green)'
                       : '';
  }

  function persistFlush() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (persistBatch.length === 0) return;
    const batch = persistBatch;
    persistBatch = [];
    const store = window.PicoPoE && window.PicoPoE.logStore;
    if (!store || !store.appendData) return;
    store.appendData(batch).catch((e) => {
      if (!persistFlush._warned) {
        persistFlush._warned = true;
        console.warn('[telemetry] logStore.appendData failed:', e);
      }
    });
  }

  function enqueuePersist(rec) {
    persistBatch.push(rec);
    if (persistBatch.length >= PERSIST_BATCH_MAX) persistFlush();
    else if (!persistTimer) persistTimer = setTimeout(persistFlush, PERSIST_BATCH_MS);
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function refreshSchema(ip, force) {
    const now = Date.now();
    if (!force && now - lastSchemaFetchMs < SCHEMA_REFRESH_MIN_MS) return;
    lastSchemaFetchMs = now;
    try {
      const res = await fetch(`http://${ip}/api/data_schema`,
                              { mode: 'cors', cache: 'no-store' });
      if (!res.ok) return;
      const obj = await res.json();
      const next = new Map();
      for (const k of Object.keys(obj)) next.set(Number(k), String(obj[k]));
      schema = next;
    } catch (_) { /* non-fatal */ }
  }

  function appendBuf(extra) {
    if (parseBuf.byteLength === 0) {
      parseBuf = extra;
      return;
    }
    const merged = new Uint8Array(parseBuf.byteLength + extra.byteLength);
    merged.set(parseBuf, 0);
    merged.set(extra, parseBuf.byteLength);
    parseBuf = merged;
  }

  // Try to parse as many complete records as possible from parseBuf.
  // Records that are partially received remain in parseBuf for the next
  // chunk. On framing loss we resync to the next 0xFE,0x01 pair.
  async function drain(ip) {
    let i = 0;
    while (i < parseBuf.byteLength) {
      // Resync if needed.
      if (parseBuf[i] !== 0xFE) {
        // Skip one byte and look for magic again.
        i++;
        continue;
      }
      if (i + 16 > parseBuf.byteLength) break;       // not enough for header
      if (parseBuf[i + 1] !== 0x01) { i++; continue; } // bad version, resync

      const dv = new DataView(parseBuf.buffer, parseBuf.byteOffset + i, 16);
      const msgId   = dv.getUint16(2, true);
      const dtype   = dv.getUint8(4);
      const n       = dv.getUint16(5, true);
      // hdr[7] reserved
      const uptimeLo = dv.getUint32(8, true);
      const uptimeHi = dv.getUint32(12, true);
      const uptimeUs = uptimeHi * 0x100000000 + uptimeLo;

      const esz = dtypeSize(dtype);
      if (esz === 0) {
        // Garbage dtype — likely framing loss mid-stream. Skip a byte and resync.
        i++;
        continue;
      }
      const payloadBytes = n * esz;
      const recordBytes = 16 + payloadBytes;
      if (i + recordBytes > parseBuf.byteLength) break;  // wait for more

      const payload = parseBuf.slice(i + 16, i + recordBytes);
      i += recordBytes;

      // Reboot detection mirrors console.js.
      if (currentRun && lastUptimeUs !== null && uptimeUs + 1_000_000 < lastUptimeUs) {
        persistFlush();
        currentRun = null;
        // Schema may also have changed across reboot.
        refreshSchema(ip, true).catch(() => {});
      }
      lastUptimeUs = uptimeUs;

      if (!currentRun) {
        const anchor = (wallMsAnchor != null) ? wallMsAnchor : Date.now();
        const offset = anchor - (uptimeUs / 1000);
        const store = window.PicoPoE && window.PicoPoE.logStore;
        const streamEpoch = store
          ? await store.startRun({
              deviceIp: knownIp || '',
              wallMsAnchor: anchor,
              uptimeUsAnchor: uptimeUs,
              wallMsOffset: offset,
            }).catch(() => Date.now())
          : Date.now();
        currentRun = { streamEpoch, wallMsOffset: offset };
      }

      const wallMs = currentRun.wallMsOffset + (uptimeUs / 1000);
      let name = schema.get(msgId);
      if (!name) {
        // Unknown id — kick off a refresh (rate-limited). Until it lands
        // we display as msg_<id>.
        refreshSchema(ip, false).catch(() => {});
        name = `msg_${msgId}`;
      }

      // Decode for the chart. We pass values as a small Float64Array; for
      // 64-bit ints we already coerced through Number().
      const values = new Float64Array(n);
      const pdv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      for (let k = 0; k < n; k++) {
        values[k] = readElem(pdv, k * esz, dtype);
      }

      // Persist the raw bytes (so HDF5 export can losslessly round-trip).
      enqueuePersist({
        stream_epoch: currentRun.streamEpoch,
        msg_id: msgId,
        uptime_us: uptimeUs,
        wall_ms: wallMs,
        dtype, n,
        bytes: payload,
      });

      // Forward to the chart.
      const chart = window.PicoPoE && window.PicoPoE.chart;
      if (chart && chart.push) {
        chart.push({ name, msgId, dtype, n, uptimeUs, wallMs, values });
      }
    }

    // Compact parseBuf — drop the consumed prefix.
    if (i > 0) {
      parseBuf = parseBuf.slice(i);
    }
  }

  async function runStream(ip, signal) {
    const since = cursor === null ? 0 : cursor;
    const url = `http://${ip}/api/data?since=${since}&stream=1`;
    wallMsAnchor = Date.now();
    parseBuf = new Uint8Array(0);

    await refreshSchema(ip, true);

    const res = await fetch(url, { mode: 'cors', cache: 'no-store', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const startHdr = res.headers.get('X-Data-Cursor');
    const startCursor = startHdr === null ? 0 : Number(startHdr);
    cursor = Number.isFinite(startCursor) ? startCursor : 0;

    setState('connected', 'ok');

    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength) {
          cursor += value.byteLength;
          appendBuf(value);
          await drain(ip);
        }
      }
    } finally {
      try { reader.cancel(); } catch (_) {}
      persistFlush();
    }
  }

  async function streamLoop() {
    while (!stopped) {
      const ip = getIp();
      if (ip !== knownIp) {
        knownIp = ip;
        cursor = null;
        parseBuf = new Uint8Array(0);
        persistFlush();
        currentRun = null;
        lastUptimeUs = null;
        schema = new Map();
        const chart = window.PicoPoE && window.PicoPoE.chart;
        if (chart && chart.reset) chart.reset();
      }
      if (!ip) {
        setState('no device', '');
        await sleep(RECONNECT_ERR_MS);
        continue;
      }

      activeAbort = new AbortController();
      try {
        await runStream(ip, activeAbort.signal);
        await sleep(RECONNECT_OK_MS);
      } catch (e) {
        if (e && e.name === 'AbortError') continue;
        setState('disconnected', 'err');
        await sleep(RECONNECT_ERR_MS);
      } finally {
        activeAbort = null;
      }
    }
  }

  function watchIp() {
    if (ipWatchHandle) return;
    ipWatchHandle = setInterval(() => {
      if (stopped) return;
      const ip = getIp();
      if (ip !== knownIp && activeAbort) activeAbort.abort();
    }, IP_CHECK_MS);
  }

  function init(opts) {
    stateEl = document.getElementById('ide-telemetry-state');
    getIp = opts.getIp || (() => null);
    setState('disconnected', '');
    watchIp();
    streamLoop();

    window.PicoPoE = window.PicoPoE || {};
    window.PicoPoE.telemetry = {
      stop() {
        stopped = true;
        persistFlush();
        if (activeAbort) activeAbort.abort();
        if (ipWatchHandle) { clearInterval(ipWatchHandle); ipWatchHandle = null; }
      },
      schemaSnapshot() { return new Map(schema); },
    };
  }

  function bootstrap() {
    init({
      getIp: () => {
        try {
          const sel = document.getElementById('ide-device-select');
          if (sel && sel.value) return sel.value;
          const fallback = document.getElementById('ide-quick-ip');
          return fallback && fallback.value.trim() ? fallback.value.trim() : null;
        } catch (_) { return null; }
      },
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
