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
  let firstStream = true;       // distinguish initial connect from reconnects
  let paused = false;           // external pause (e.g. during OTA upload)
  let pauseWaiter = null;       // promise resolver to wake streamLoop on resume()

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
    // CSS .status-dot[data-state] paints the colored dot; cls is 'ok' /
    // 'err' / null. We keep null → 'off' (gray) for the disconnected state.
    stateEl.setAttribute('data-state',
      cls === 'ok' ? 'ok' : cls === 'err' ? 'err' : 'off');
  }

  // Telemetry now writes straight into the in-memory data_store
  // (per-channel TypedArrays). No more per-record IDB transactions —
  // structured-clone of millions of small Uint8Arrays was the
  // dominant cost behind both the export hangs and the live-plot
  // dropouts. The chart still gets every record via chart.push;
  // log_export reads directly from data_store at click time.
  // persistFlush is kept as a no-op so callers (download flow) don't
  // need a feature check.
  function persistFlush() { /* in-memory append is synchronous; nothing to flush */ }

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
      // Persist into the run metadata so the HDF5 export can label
      // datasets by msg_id → name. We attach to the CURRENT run only —
      // older runs keep whatever schema was captured at their time.
      if (currentRun && currentRun.streamEpoch != null) {
        const store = window.PicoPoE && window.PicoPoE.logStore;
        if (store && store.setRunSchema) {
          store.setRunSchema(currentRun.streamEpoch, obj).catch(() => {});
        }
      }
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
        // Tell the chart to break the trace — the next sample will land
        // at a wallMs that may differ noticeably from the buffer's last
        // pre-reboot value, and we don't want a diagonal across the seam.
        const chart = window.PicoPoE && window.PicoPoE.chart;
        if (chart && chart.gap) chart.gap();
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

      // In-memory time-series store (HDF5 export reads from here).
      const ds = window.PicoPoE && window.PicoPoE.dataStore;
      if (ds && ds.append) {
        ds.append({ name, dtype, n, uptimeUs, wallMs, values });
      }

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
    // Cursor-resume across (re)connects so brief network blips don't
    // lose telemetry — the device replays from `since` if the ring still
    // holds the bytes. Requires firmware ≥ v1.1.3 which clamps a stale
    // `since > total` (post-reboot) at the entry point and writes back
    // `conn->log_since` on zero-byte reads; without those fixes, a stale
    // cursor would wedge the stream for ~10 minutes until total caught
    // up. On a fresh page, cursor is null → omit `since` (live-tail).
    const sinceParam = (cursor != null) ? `&since=${cursor}` : '';
    const url = `http://${ip}/api/data?stream=1${sinceParam}`;
    wallMsAnchor = Date.now();
    parseBuf = new Uint8Array(0);

    // Every reconnect (not the very first) gets a chart gap. Catches both
    // OTA reboots (where uptime regresses) AND brief network blips (where
    // it doesn't). Cheap and idempotent — gapIdx in the chart dedupes.
    if (!firstStream) {
      const chart = window.PicoPoE && window.PicoPoE.chart;
      if (chart && chart.gap) chart.gap();
    }
    firstStream = false;

    await refreshSchema(ip, true);

    const res = await fetch(url, { mode: 'cors', cache: 'no-store', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Trust the server-reported cursor: if our requested `since` was past
    // total (post-reboot), v1.1.3+ clamps it and reports the real cursor
    // here, which we then advance from with each received chunk.
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
      if (paused) {
        // Block here until resume(). The pauseWaiter promise wakes us
        // immediately rather than waiting out a sleep, so the chart
        // catches up the moment the IDE finishes its OTA.
        setState('paused', '');
        await new Promise((r) => { pauseWaiter = r; });
        pauseWaiter = null;
        if (stopped) break;
        continue;
      }
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
        // New device session — wipe the in-memory time-series store
        // so the next export only contains data from this device.
        const ds = window.PicoPoE && window.PicoPoE.dataStore;
        if (ds && ds.resetSession) ds.resetSession();
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
        if (pauseWaiter) { pauseWaiter(); pauseWaiter = null; }
        if (ipWatchHandle) { clearInterval(ipWatchHandle); ipWatchHandle = null; }
      },
      // Used by ide.js around Build & Upload: stop tailing the device
      // before the OTA so we don't fight upload.js for the device's lwIP
      // resources, and so reboot-time half-dead TCP doesn't show up as
      // chart artifacts. Resume after the new firmware is committed.
      pause() {
        if (paused) return;
        paused = true;
        // Drop the live stream + force a chart gap so the resume after
        // OTA reads as a clean break instead of a diagonal across the
        // upload duration.
        if (activeAbort) activeAbort.abort();
        const chart = window.PicoPoE && window.PicoPoE.chart;
        if (chart && chart.gap) chart.gap();
        persistFlush();
      },
      resume() {
        if (!paused) return;
        paused = false;
        // Reset cursor + run state so the post-reboot stream starts
        // cleanly at the device's new total. Also reset the in-memory
        // data store — OTA implies a fresh device session and the
        // export semantics are "session start → now".
        cursor = null;
        currentRun = null;
        lastUptimeUs = null;
        parseBuf = new Uint8Array(0);
        const ds = window.PicoPoE && window.PicoPoE.dataStore;
        if (ds && ds.resetSession) ds.resetSession();
        // Drop the chart entirely — series Map AND uPlot instance — and
        // let the next push() re-register and reconstruct uPlot fresh.
        // chart.clear() (which only empties the value arrays and keeps
        // the uPlot instance alive) leaves residual cursor / scale /
        // draw-cache state inside uPlot that visibly composites against
        // the first few new datapoints as a V-shape artifact at the
        // leftmost edge of the new run. chart.reset() destroys the
        // instance instead — the placeholder text reappears for the
        // ~100 ms it takes for the first sample to arrive, then a fresh
        // uPlot is built with no carryover. The full record stream is
        // still preserved in IndexedDB for the HDF5 export — this only
        // drops the live chart's display history.
        const chart = window.PicoPoE && window.PicoPoE.chart;
        if (chart && chart.reset) chart.reset();
        // firstStream stays false so a future network blip (not OTA)
        // still inserts a chart.gap() — only the OTA path nukes the ring.
        if (pauseWaiter) { pauseWaiter(); pauseWaiter = null; }
      },
      isPaused() { return paused; },
      schemaSnapshot() { return new Map(schema); },
      // Force any pending persist batch to IndexedDB. Used by the
      // download flow so the on-disk file includes the most recent
      // samples, not just whatever last hit the timed flush.
      flushPersist() { persistFlush(); },
      // The streamEpoch the current run is persisting under. Used by
      // the export to include the active run even if its row in the
      // runs table is missing or out of sync with the records (e.g.,
      // when startRun fell back to Date.now() after an IDB hiccup).
      currentStreamEpoch() { return currentRun ? currentRun.streamEpoch : null; },
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
