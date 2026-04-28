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
  // Stall watchdog: if the open stream goes silent for this long we
  // assume the underlying TCP is half-dead (Wi-Fi flap, ethernet
  // unplug, NAT timeout, browser idle suspend) and abort so the loop
  // reconnects cleanly. Tuned wider than any legitimate quiet period —
  // even an idle device on a paused script still emits keep-alives.
  const STALL_MS           = 6000;
  const STALL_CHECK_MS     = 1000;
  // Connect-phase timeout — between issuing fetch() and the first byte
  // landing. Without this, a device that's just rebooted (TCP accepts
  // but firmware isn't ready to serve) leaves runStream blocked
  // indefinitely on `await fetch(...)` or `await reader.read()`. The
  // stall watchdog can't help here because it skips when lastByteMs is
  // still 0. 5 s is well above the round-trip on LAN even for a slow
  // device + handshake.
  const CONNECT_TIMEOUT_MS = 5000;
  // Schema fetch timeout. Same reason — a hung /api/data_schema would
  // wedge runStream's awaited refreshSchema and prevent the data fetch
  // from ever issuing.
  const SCHEMA_TIMEOUT_MS  = 4000;

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
  // Stall watchdog state — last time the active stream produced bytes,
  // and the interval that polls it. lastByteMs updates on every chunk
  // received in runStream(); an idle browser tab won't fire the
  // interval reliably (background-throttled to ~1 Hz / fully paused),
  // but that's fine — we re-check on visibilitychange too.
  let lastByteMs = 0;
  let stallHandle = null;

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

  // Diagnostic ring buffer + structured logger. Each call goes to
  // console.log AND to a 100-entry buffer accessible via
  // window.PICOPOE_DIAG(). The buffer is what the user pastes back
  // when telemetry is misbehaving — it captures the sequence of state
  // transitions in order, with ms-since-page-load timestamps.
  const DIAG_MAX = 100;
  const diagBuf  = [];
  const tStart   = performance.now();
  function diag(event, fields) {
    const entry = { t: Math.round(performance.now() - tStart), event, ...(fields || {}) };
    diagBuf.push(entry);
    if (diagBuf.length > DIAG_MAX) diagBuf.shift();
    try { console.log('[tlm]', entry); } catch (_) {}
  }

  // Drain logging is rate-limited — drain runs many times per chunk,
  // we only want to see "first records arrived" + any parse failures.
  let drainSeenAnyRecord = false;
  let drainResyncCount   = 0;

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
    // Bound the schema fetch — without a timeout, a freshly-rebooted
    // device that accepts the TCP but doesn't reply leaves runStream's
    // `await refreshSchema(...)` blocked forever, so the data stream
    // never gets a chance to (re)open.
    const schemaAbort = new AbortController();
    const schemaTimer = setTimeout(() => schemaAbort.abort(), SCHEMA_TIMEOUT_MS);
    try {
      const res = await fetch(`http://${ip}/api/data_schema`,
                              { mode: 'cors', cache: 'no-store', signal: schemaAbort.signal });
      clearTimeout(schemaTimer);
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
    } catch (e) {
      diag('schema.error', { message: String(e && e.message || e) });
    }
    finally { clearTimeout(schemaTimer); }
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
    let recordsThisCall = 0;
    const startBufLen = parseBuf.byteLength;
    while (i < parseBuf.byteLength) {
      // Resync if needed.
      if (parseBuf[i] !== 0xFE) {
        // Skip one byte and look for magic again.
        i++;
        drainResyncCount++;
        continue;
      }
      if (i + 16 > parseBuf.byteLength) break;       // not enough for header
      if (parseBuf[i + 1] !== 0x01) { i++; drainResyncCount++; continue; } // bad version, resync

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
        // streamEpoch is just a per-run identifier — Date.now() is
        // unique enough for that and never wedges. We used to await
        // logStore.startRun() here, which writes to IndexedDB; on some
        // Firefox profiles that promise can hang indefinitely (neither
        // resolves nor rejects, so the .catch() doesn't help), parking
        // the entire telemetry pipeline on the very first record. The
        // run-metadata persistence happens in the background — failure
        // there only affects the historical-runs index in the export,
        // not live plotting.
        const anchor = (wallMsAnchor != null) ? wallMsAnchor : Date.now();
        const offset = anchor - (uptimeUs / 1000);
        const streamEpoch = Date.now();
        currentRun = { streamEpoch, wallMsOffset: offset };
        const store = window.PicoPoE && window.PicoPoE.logStore;
        if (store && store.startRun) {
          // Fire-and-forget — do NOT await. Failure is non-fatal.
          store.startRun({
            streamEpoch,
            deviceIp: knownIp || '',
            wallMsAnchor: anchor,
            uptimeUsAnchor: uptimeUs,
            wallMsOffset: offset,
          }).catch((e) => diag('startRun.error', { message: String(e && e.message || e) }));
        }
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
      recordsThisCall++;
    }

    // Compact parseBuf — drop the consumed prefix.
    if (i > 0) {
      parseBuf = parseBuf.slice(i);
    }

    // Diagnostic: log the FIRST batch of records (so we can see they
    // got through), and any drain that consumed bytes but produced
    // zero records (parse failure).
    if (recordsThisCall > 0 && !drainSeenAnyRecord) {
      drainSeenAnyRecord = true;
      diag('drain.first', { records: recordsThisCall, bufBefore: startBufLen,
                             bufAfter: parseBuf.byteLength,
                             schemaSize: schema.size });
    } else if (recordsThisCall === 0 && startBufLen >= 16) {
      // Only log the parse-failure case once per second to avoid flood.
      if (!drain._lastEmptyMs || performance.now() - drain._lastEmptyMs > 1000) {
        drain._lastEmptyMs = performance.now();
        diag('drain.empty', { bufBefore: startBufLen, bufAfter: parseBuf.byteLength,
                              first8: Array.from(parseBuf.slice(0, 8)),
                              resyncs: drainResyncCount });
      }
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
    diag('runStream.open', { url, cursor });
    // Sentinel value while we're connecting — the stall watchdog skips
    // when this is 0. Without this reset, post-OTA the stale lastByteMs
    // from the pre-pause stream is many seconds old and the watchdog
    // aborts the fresh fetch the instant it's created, preventing
    // recovery on a real device. Set to performance.now() once headers
    // land below.
    lastByteMs = 0;

    // Connect-phase timeout. The stall watchdog can't help here — it's
    // gated on lastByteMs > 0, which doesn't happen until headers
    // arrive. A device that just rebooted may accept the TCP but not
    // produce a response (Firefox + half-dead lwIP socket is the worst
    // case). Without this, runStream sits forever on the awaited fetch
    // or the first reader.read(). Cleared once the first byte lands.
    const connectTimer = setTimeout(() => {
      if (lastByteMs === 0 && activeAbort && !signal.aborted) {
        diag('runStream.connectTimeout', { CONNECT_TIMEOUT_MS });
        try { activeAbort.abort(); } catch (_) {}
      }
    }, CONNECT_TIMEOUT_MS);

    // Every reconnect (not the very first) gets a chart gap. Catches both
    // OTA reboots (where uptime regresses) AND brief network blips (where
    // it doesn't). Cheap and idempotent — gapIdx in the chart dedupes.
    if (!firstStream) {
      const chart = window.PicoPoE && window.PicoPoE.chart;
      if (chart && chart.gap) chart.gap();
    }
    firstStream = false;

    diag('runStream.refreshSchema');
    await refreshSchema(ip, true);
    diag('runStream.schemaDone', { schemaSize: schema.size,
                                    schema: [...schema.entries()] });

    diag('runStream.fetch');
    const res = await fetch(url, { mode: 'cors', cache: 'no-store', signal });
    diag('runStream.headers', { ok: res.ok, status: res.status,
                                 contentType: res.headers.get('Content-Type'),
                                 cursorHdr: res.headers.get('X-Data-Cursor') });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Trust the server-reported cursor IF it's exposed: firmware ≥
    // v1.1.3 clamps a stale `since > total` (post-reboot) and reports
    // the real cursor here. If the header is absent (e.g. CORS not
    // exposing X-Data-Cursor), we keep our existing cursor — falling
    // back to 0 would make next reconnect's `&since=` too low, the
    // server would replay already-received bytes, and the parser would
    // produce duplicates.
    const startHdr = res.headers.get('X-Data-Cursor');
    if (startHdr !== null) {
      const startCursor = Number(startHdr);
      if (Number.isFinite(startCursor)) cursor = startCursor;
    } else if (cursor == null) {
      cursor = 0;   // very first connect on a fresh page; no &since= sent
    }

    setState('connected', 'ok');
    lastByteMs = performance.now();
    clearTimeout(connectTimer);
    drainSeenAnyRecord = false; drainResyncCount = 0;
    diag('runStream.streaming', { cursor });

    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength) {
          lastByteMs = performance.now();
          cursor += value.byteLength;
          appendBuf(value);
          await drain(ip);
        }
      }
    } finally {
      clearTimeout(connectTimer);
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
        diag('runStream.endedCleanly');
        await sleep(RECONNECT_OK_MS);
      } catch (e) {
        if (e && e.name === 'AbortError') { diag('runStream.aborted'); continue; }
        diag('runStream.error', { message: String(e && e.message || e) });
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

  // Stall watchdog: poll every STALL_CHECK_MS and abort the active
  // stream if no bytes have arrived for STALL_MS. Catches the cases
  // fetch() doesn't surface as errors:
  //   - ethernet unplugged → TCP half-dead, stays open until OS RST
  //   - Wi-Fi roam / NAT box reboot → packets lost silently
  //   - browser tab backgrounded → Chrome may suspend the read loop
  //     (the interval below also wakes on visibilitychange so a tab
  //     refocus checks immediately rather than waiting up to 1 s)
  // setState('reconnecting…') gives the user feedback that we noticed.
  function watchStall() {
    if (stallHandle) return;
    stallHandle = setInterval(() => {
      if (stopped || paused || !activeAbort) return;
      if (lastByteMs === 0) return;
      if (performance.now() - lastByteMs > STALL_MS) {
        diag('stall.abort', { quietMs: Math.round(performance.now() - lastByteMs) });
        setState('reconnecting…', 'err');
        try { activeAbort.abort(); } catch (_) {}
      }
    }, STALL_CHECK_MS);
  }

  // Online / visibility hooks — kick the loop the instant the OS reports
  // network back, or when the tab refocuses after being backgrounded.
  // Both paths do the same thing: abort any in-flight (likely-dead)
  // request, which makes streamLoop() retry immediately instead of
  // waiting out STALL_MS.
  function installConnectivityHooks() {
    const onWake = () => {
      if (stopped || paused || !activeAbort) return;
      // Skip if we just got bytes — abort would only churn.
      if (lastByteMs > 0 && performance.now() - lastByteMs < 1000) return;
      try { activeAbort.abort(); } catch (_) {}
    };
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) onWake();
    });
  }

  function init(opts) {
    stateEl = document.getElementById('ide-telemetry-state');
    getIp = opts.getIp || (() => null);
    setState('disconnected', '');
    watchIp();
    watchStall();
    installConnectivityHooks();
    streamLoop();

    window.PicoPoE = window.PicoPoE || {};
    window.PicoPoE.telemetry = {
      stop() {
        stopped = true;
        persistFlush();
        if (activeAbort) activeAbort.abort();
        if (pauseWaiter) { pauseWaiter(); pauseWaiter = null; }
        if (ipWatchHandle) { clearInterval(ipWatchHandle); ipWatchHandle = null; }
        if (stallHandle)   { clearInterval(stallHandle);   stallHandle   = null; }
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

    // Single-call diagnostic dump — internal state + recent event log.
    // The user runs `window.PICOPOE_DIAG()` in the browser console and
    // pastes the result back. Captures every transition for the last
    // ~100 events with ms-since-page-load timestamps.
    window.PICOPOE_DIAG = () => ({
      assetVersion: window.PICOPOE_ASSET_VERSION,
      ip:           getIp(),
      knownIp,
      paused,
      stopped,
      cursor,
      lastByteMs:    Math.round(lastByteMs),
      msSinceLastByte: lastByteMs ? Math.round(performance.now() - lastByteMs) : null,
      schemaSize:    schema.size,
      schema:        [...schema.entries()],
      currentRun,
      drainResyncCount,
      drainSeenAnyRecord,
      parseBufLen:   parseBuf.byteLength,
      parseBufFirst8: Array.from(parseBuf.slice(0, 8)),
      ledStates: {
        tlm: { text: stateEl ? stateEl.textContent : null,
               dot:  stateEl ? stateEl.getAttribute('data-state') : null },
      },
      dataStore: window.PicoPoE && window.PicoPoE.dataStore
                 ? window.PicoPoE.dataStore.stats() : null,
      events: diagBuf.slice(),   // chronological
    });
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
