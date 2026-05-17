// telemetry.js — tails /api/data?stream=1, parses framed binary records,
// labels them via /api/data_schema, persists into IndexedDB (log_store
// data_records), and forwards to the chart pane.
//
// Wire format (firmware/app/data_buffer.h):
//   offset  size  field
//   0       1     magic    = 0xFE
//   1       1     version  = 0x01
//   2       2     msg_id   LE u16
//   4       1     dtype    u8 (conduit_dtype_t)
//   5       2     n        LE u16  element count, NOT bytes
//   7       1     reserved 0
//   8       8     uptime_us LE u64
//   16      ...   payload  n * elem_size bytes
//
// Reconnect / reboot semantics mirror console.js — the chart pane is
// driven by the same stream-then-buffer-then-render loop.

(function () {
  'use strict';

  // RECONNECT_OK_MS / RECONNECT_ERR_MS — back-off between stream
  // reconnect attempts. The original wedge that motivated 2 s / 5 s
  // was the http_conn_t libc-calloc OOM panic — now fixed by the
  // static pool. Tightened to 500 ms / 1500 ms: a real TLS handshake
  // on Cortex-M33 software ChaCha20 takes ~1.5–2 s, so retrying every
  // 1.5 s after a failure keeps the device handing handshakes one at
  // a time without piling them up.
  const RECONNECT_OK_MS    = 500;
  const RECONNECT_ERR_MS   = 1500;
  const IP_CHECK_MS        = 1000;
  const SCHEMA_REFRESH_MIN_MS = 1000;
  const PERSIST_BATCH_MAX  = 64;
  const PERSIST_BATCH_MS   = 250;
  // Stall watchdog: if the open stream goes silent for this long we
  // assume the underlying TCP is half-dead (Wi-Fi flap, ethernet
  // unplug, NAT timeout, browser idle suspend) and abort so the loop
  // reconnects cleanly. The firmware emits a 16-byte keepalive record
  // every ~500 ms when the data ring is otherwise idle (see
  // CONDUIT_DATA_KEEPALIVE_MSG_ID), so 1 s is one missed keepalive
  // plus jitter — anything longer is genuinely broken. Tried a
  // separate HTTPS threshold of 4 s coupled to a 3000 ms firmware-
  // side keepalive cadence — combo wedged the device on the IDE's
  // multi-conn startup. Revert and rely on the v10.29 cadence.
  // STALL_MS — see RECONNECT_*_MS rationale. Conservative 10 s so a
  // false-trip stall doesn't add a handshake to the reconnect-churn
  // pile that triggers the firmware-side Core 1 deadlock. TCP +
  // mbedtls + browser-layer batching can produce 2-5 s on-wire gaps
  // even when the firmware emits a keepalive every 500 ms.
  const STALL_MS           = 10000;
  const STALL_CHECK_MS     = 500;
  // Connect-phase timeout — between issuing fetch() and the first byte
  // landing. Without this, a device that's just rebooted (TCP accepts
  // but firmware isn't ready to serve) leaves runStream blocked
  // indefinitely on `await fetch(...)` or `await reader.read()`. The
  // stall watchdog can't help here because it skips when lastByteMs is
  // still 0. Firmware emits a 16-byte keepalive every ~500 ms.
  //
  // 4 s — was 8 s, sized for the pre-ChaCha20 era when the ECDHE-ECDSA
  // handshake took ~3 s on Cortex-M33. With ChaCha20-Poly1305 negotiated
  // (firmware v10.41+) the handshake completes in ~1.5-2 s, so 4 s leaves
  // ~2 s of comfortable margin. The shorter timeout cuts the worst-case
  // red→green LED latency in half after a device reboot. If a stress run
  // ever exceeds 4 s the stream auto-retries on a 150 ms cadence, so a
  // single timed-out connect costs at most one extra round-trip.
  // CONNECT_TIMEOUT_MS — 15 s covers cold-handshake worst case (PNA
  // preflight + full TLS, ~5–8 s on Cortex-M33). Tightening this
  // adds handshake churn under any transient delay, which is what
  // wedges Core 1 in the firmware.
  const CONNECT_TIMEOUT_MS = 15000;
  // Schema fetch timeout. Matches CONNECT_TIMEOUT_MS so an unreachable
  // device doesn't hold runStream's awaited refreshSchema for several
  // seconds while the data path retries every RECONNECT_ERR_MS.
  const SCHEMA_TIMEOUT_MS  = 15000;

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

  // Pure wire-format decoder. Given a byte buffer + offset, classify
  // the next record as one of:
  //   { kind: 'record',  recordBytes, msgId, dtype, n, uptimeUs, payload }
  //   { kind: 'need',    needBytes }     // wait until buf has this many at offset
  //   { kind: 'resync' }                 // skip 1 byte and try again
  // Exposed via window.Conduit.telemetryWire so unit tests can drive it
  // without booting the streaming loop.
  const FRAME_MAGIC   = 0xFE;
  const FRAME_VERSION = 0x01;
  const FRAME_HEADER_BYTES = 16;
  // Reserved msg_id used by firmware http_poll's idle keepalive
  // (see firmware/app/data_buffer.h CONDUIT_DATA_KEEPALIVE_MSG_ID). Records
  // with this id arrive at most every ~500 ms when the device's data
  // ring is empty; we count them as "stream is alive" but skip the
  // chart/store push in drain().
  const KEEPALIVE_MSG_ID = 0xFFFF;
  function parseRecord(buf, offset) {
    offset = offset | 0;
    const len = buf.byteLength;
    if (offset >= len)              return { kind: 'need', needBytes: 1 };
    if (buf[offset] !== FRAME_MAGIC) return { kind: 'resync' };
    if (offset + FRAME_HEADER_BYTES > len) return { kind: 'need', needBytes: FRAME_HEADER_BYTES };
    if (buf[offset + 1] !== FRAME_VERSION) return { kind: 'resync' };
    const dv = new DataView(buf.buffer, buf.byteOffset + offset, FRAME_HEADER_BYTES);
    const msgId = dv.getUint16(2, true);
    const dtype = dv.getUint8(4);
    const n     = dv.getUint16(5, true);
    const uptimeLo = dv.getUint32(8,  true);
    const uptimeHi = dv.getUint32(12, true);
    const uptimeUs = uptimeHi * 0x100000000 + uptimeLo;
    const esz = dtypeSize(dtype);
    if (esz === 0) return { kind: 'resync' };           // garbage dtype → framing loss
    const recordBytes = FRAME_HEADER_BYTES + n * esz;
    if (offset + recordBytes > len) return { kind: 'need', needBytes: recordBytes };
    return {
      kind: 'record', recordBytes, msgId, dtype, n, uptimeUs,
      payload: buf.subarray(offset + FRAME_HEADER_BYTES, offset + recordBytes),
    };
  }
  // Expose on window.Conduit.telemetryWire BEFORE init() runs, so unit
  // tests can `loadModule('telemetry.js')` and grab the parser without
  // also kicking off the network/timer machinery.
  window.Conduit = window.Conduit || {};
  window.Conduit.telemetryWire = {
    parseRecord, dtypeSize, readElem,
    MAGIC: FRAME_MAGIC, VERSION: FRAME_VERSION, HEADER_BYTES: FRAME_HEADER_BYTES,
    KEEPALIVE_MSG_ID,
  };

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
  // Set to true at init() and on resume() so the streamLoop blocks the
  // next runStream() open until console reports a connected stream (or
  // the timeout fires). Console is the lighter pane; landing it first
  // gives the user fast feedback (log lines) and avoids two parallel
  // TLS handshakes during the post-reboot mbedtls-warmup window.
  let awaitingConsoleHandoff = true;
  const CONSOLE_HANDOFF_MAX_MS = 5000;
  // Stall watchdog state — last time the active stream produced bytes,
  // and the interval that polls it. lastByteMs updates on every chunk
  // received in runStream(); an idle browser tab won't fire the
  // interval reliably (background-throttled to ~1 Hz / fully paused),
  // but that's fine — we re-check on visibilitychange too.
  let lastByteMs = 0;
  let stallHandle = null;

  // One-shot "next successful runStream open" listeners. Used by
  // ide.js's onBuildUpload to detect "device is back" the instant the
  // stream's auto-reconnect lands a fresh response post-reboot — no
  // /api/status polling required. Each listener fires AT MOST ONCE
  // and is removed; this is intentionally not a sticky event since
  // every consumer we have just wants the next post-trigger connect.
  let connectListeners = [];
  function fireConnect() {
    if (!connectListeners.length) return;
    const pending = connectListeners;
    connectListeners = [];
    for (const cb of pending) { try { cb(); } catch (_) {} }
  }

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
  // window.CONDUIT_DIAG(). The buffer is what the user pastes back
  // when telemetry is misbehaving — it captures the sequence of state
  // transitions in order, with ms-since-page-load timestamps.
  const DIAG_MAX = 100;
  const diagBuf  = [];
  const tStart   = performance.now();
  // Console output is opt-in via Conduit.telemetryDebug = true. The
  // in-memory buffer is always populated and dumpable via
  // window.CONDUIT_DIAG().
  function diag(event, fields) {
    const entry = { t: Math.round(performance.now() - tStart), event, ...(fields || {}) };
    diagBuf.push(entry);
    if (diagBuf.length > DIAG_MAX) diagBuf.shift();
    if (window.Conduit && window.Conduit.telemetryDebug) {
      try { console.log('[tlm]', entry); } catch (_) {}
    }
  }

  // Drain logging is rate-limited — drain runs many times per chunk,
  // we only want to see "first records arrived" + any parse failures.
  let drainSeenAnyRecord = false;
  let drainResyncCount   = 0;

  // Discriminated state machine for the indicator label.
  //   'connected'    (green) — bytes flowing within STALL_MS
  //   'no data'      (amber) — TCP open + headers received but stale
  //   'reconnecting' (red)   — between runStream invocations
  //   'paused'       (off)   — external pause (OTA)
  //   'no device'    (off)   — getIp returned null
  //   'disconnected' (off)   — initial / stop()
  let currentStage = 'disconnected';
  let stageEnteredAt = 0;
  // Braille spinner — mirror of console.js. Drives the animated
  // 'connecting' indicator. Frames cycle through the standard 10
  // braille loading glyphs. The --font-mono fallback chain (Menlo,
  // Consolas, monospace) supplies the U+28xx coverage.
  const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const SPINNER_INTERVAL_MS = 80;
  let spinnerHandle = null;
  let spinnerIdx = 0;
  function startSpinner() {
    if (spinnerHandle) return;
    spinnerIdx = 0;
    if (stateEl) stateEl.textContent = `connecting ${SPINNER_FRAMES[0]}`;
    spinnerHandle = setInterval(() => {
      if (!stateEl || currentStage !== 'connecting' || paused) return;
      spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
      stateEl.textContent = `connecting ${SPINNER_FRAMES[spinnerIdx]}`;
    }, SPINNER_INTERVAL_MS);
  }
  function stopSpinner() {
    if (spinnerHandle) { clearInterval(spinnerHandle); spinnerHandle = null; }
  }
  function setStage(stage) {
    currentStage = stage;
    stageEnteredAt = performance.now();
    renderStage();
  }
  function renderStage() {
    if (!stateEl) return;
    let text, cls;
    switch (currentStage) {
      case 'connected':    text = 'connected';    cls = 'ok';  break;
      case 'connecting':   text = 'connecting';   cls = '';    break;
      case 'no data':      text = 'no data';      cls = 'err'; break;
      case 'reconnecting': text = 'reconnecting…'; cls = 'err'; break;
      case 'paused':       text = 'paused';       cls = '';    break;
      case 'no device':    text = 'no device';    cls = '';    break;
      case 'disconnected': text = 'disconnected'; cls = '';    break;
      default:             text = currentStage;   cls = '';    break;
    }
    if (currentStage === 'connecting') {
      startSpinner();             // spinner owns textContent
    } else {
      stopSpinner();
      stateEl.textContent = text;
    }
    stateEl.setAttribute('data-state',
      cls === 'ok' ? 'ok' : cls === 'err' ? 'err' : 'off');
  }
  // Back-compat alias for older internal call sites; map the small set
  // we actually used to the new stage names.
  function setState(text, cls) {
    if (text === 'connected')      setStage('connected');
    else if (text === 'paused')    setStage('paused');
    else if (text === 'no device') setStage('no device');
    else if (text === 'reconnecting…' || text === 'reconnecting') setStage('reconnecting');
    else setStage('disconnected');
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

  let schemaFetchInFlight = false;
  async function refreshSchema(ip, force, parentSignal) {
    // In-flight guard: drain() fires refreshSchema once per unknown-msgId
    // record. On a post-reboot reconnect the schema cache is empty AND
    // many records arrive in a burst (the device's pre-handshake backlog).
    // Without this guard, the time-based rate limit isn't sufficient
    // because each `lastSchemaFetchMs = now` write happens BEFORE the
    // fetch starts — so a slow handshake on the schema request itself
    // lets the rate-limit clock advance, and the next burst fires more
    // requests. One in-flight fetch at a time is the right invariant.
    if (schemaFetchInFlight) return;
    const now = Date.now();
    if (!force && now - lastSchemaFetchMs < SCHEMA_REFRESH_MIN_MS) return;
    schemaFetchInFlight = true;
    lastSchemaFetchMs = now;
    // Bound the schema fetch — without a timeout, a freshly-rebooted
    // device that accepts the TCP but doesn't reply leaves runStream's
    // `await refreshSchema(...)` blocked forever, so the data stream
    // never gets a chance to (re)open. Also chain to the runStream's
    // signal: a connect-timeout abort there must propagate here so we
    // don't burn the rest of SCHEMA_TIMEOUT_MS waiting on a fetch the
    // outer loop has already decided to retry.
    const schemaAbort = new AbortController();
    const schemaTimer = setTimeout(() => schemaAbort.abort(), SCHEMA_TIMEOUT_MS);
    let onParentAbort = null;
    if (parentSignal) {
      if (parentSignal.aborted) schemaAbort.abort();
      else {
        onParentAbort = () => schemaAbort.abort();
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
      }
    }
    try {
      const res = await fetch(window.Conduit.deviceUrlForIp(ip, '/api/data_schema'),
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
        const store = window.Conduit && window.Conduit.logStore;
        if (store && store.setRunSchema) {
          store.setRunSchema(currentRun.streamEpoch, obj).catch(() => {});
        }
      }
    } catch (e) {
      diag('schema.error', { message: String(e && e.message || e) });
    }
    finally {
      schemaFetchInFlight = false;
      clearTimeout(schemaTimer);
      if (parentSignal && onParentAbort) {
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    }
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
    let keepalivesThisCall = 0;
    const startBufLen = parseBuf.byteLength;
    while (i < parseBuf.byteLength) {
      const r = parseRecord(parseBuf, i);
      if (r.kind === 'need') break;                      // wait for more bytes
      if (r.kind === 'resync') { i++; drainResyncCount++; continue; }
      // r.kind === 'record'
      const { msgId, dtype, n, uptimeUs, recordBytes } = r;
      // Firmware-side keepalive: 16-byte zero-payload record emitted
      // when the data ring is otherwise idle, so our stall watchdog
      // sees bytes from a quiet-but-healthy device. Skip everything
      // past the bookkeeping below — chart, store, schema cache,
      // reboot-detection — none of it should react to keepalives.
      if (msgId === KEEPALIVE_MSG_ID) {
        i += recordBytes;
        keepalivesThisCall++;
        continue;
      }
      const esz = dtypeSize(dtype);
      // Copy out the payload before advancing — drain() may slice the
      // parseBuf below, which would invalidate a subarray view.
      const payload = parseBuf.slice(i + 16, i + recordBytes);
      i += recordBytes;

      // Reboot detection mirrors console.js.
      if (currentRun && lastUptimeUs !== null && uptimeUs + 1_000_000 < lastUptimeUs) {
        persistFlush();
        currentRun = null;
        // Tell the chart to break the trace — the next sample will land
        // at a wallMs that may differ noticeably from the buffer's last
        // pre-reboot value, and we don't want a diagonal across the seam.
        const chart = window.Conduit && window.Conduit.chart;
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
        const store = window.Conduit && window.Conduit.logStore;
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
      const name = schema.get(msgId);
      if (!name) {
        // Unknown msg_id — schema isn't loaded yet (we just (re)connected,
        // or this id was registered post-schema-fetch). Kick a refresh
        // and DROP this record. Earlier we used to push a placeholder
        // "msg_<id>" channel into the chart and rename it later; that
        // left ghost legend rows after a device reboot remapped the
        // msg_id (old id 0 = CONST_1 → new id 0 = SIN, but the cached
        // schema still said CONST_1, so the first post-OTA records got
        // attributed to the wrong name and registered a phantom
        // channel). Dropping a few records during the brief schema-
        // fetch window is cleaner than carrying that mis-attribution.
        refreshSchema(ip, false).catch(() => {});
        continue;
      }

      // Decode for the chart. We pass values as a small Float64Array; for
      // 64-bit ints we already coerced through Number().
      const values = new Float64Array(n);
      const pdv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      for (let k = 0; k < n; k++) {
        values[k] = readElem(pdv, k * esz, dtype);
      }

      // In-memory time-series store (HDF5 export reads from here).
      const ds = window.Conduit && window.Conduit.dataStore;
      if (ds && ds.append) {
        ds.append({ name, dtype, n, uptimeUs, wallMs, values });
      }

      // Forward to the chart.
      const chart = window.Conduit && window.Conduit.chart;
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
    // zero usable records AND zero keepalives — that's a real parse
    // failure worth investigating. Keepalive-only batches are normal
    // and silent (firmware emits one every ~500 ms when the data
    // ring is idle).
    if (recordsThisCall > 0 && !drainSeenAnyRecord) {
      drainSeenAnyRecord = true;
      diag('drain.first', { records: recordsThisCall, bufBefore: startBufLen,
                             bufAfter: parseBuf.byteLength,
                             schemaSize: schema.size });
    } else if (recordsThisCall === 0 && keepalivesThisCall === 0 && startBufLen >= 16) {
      // Only log the parse-failure case once per second to avoid flood.
      if (!drain._lastEmptyMs || performance.now() - drain._lastEmptyMs > 1000) {
        drain._lastEmptyMs = performance.now();
        diag('drain.empty', { bufBefore: startBufLen, bufAfter: parseBuf.byteLength,
                              first8: Array.from(parseBuf.slice(0, 8)),
                              resyncs: drainResyncCount });
      }
    }
  }

  // The HTTP /api/data fetch path has been retired. stream.js (the
  // unified WebSocket transport) is now the SOLE data source — see
  // attachToStream() below. Reconnect, stall detection, IP-change
  // handling, and connectivity hooks all live in stream.js; this
  // module is a thin parser + chart adapter.

  function attachToStream() {
    const s = window.Conduit && window.Conduit.stream;
    if (!s) {
      diag('attachToStream.missing');
      return;
    }
    // Refresh the schema once on the first stream connect — telemetry
    // records carry msg_id, not names, and the data_schema endpoint
    // (a one-shot GET) provides the id→name map.
    s.onNextConnect(() => {
      fireConnect();
      const ip = getIp();
      if (ip) refreshSchema(ip, true).catch(() => {});
    });
    // Stream went down — drop cached schema since msg_ids may
    // remap after firmware update / OTA / device change.
    s.onDisconnect(() => {
      schema = new Map();
      lastSchemaFetchMs = 0;
      parseBuf = new Uint8Array(0);
    });
    s.onData((bytes) => {
      if (stopped || paused) return;
      // Mirror of console.js's preliminary-log gate: drop incoming
      // records while the WS session hasn't passed the stability
      // gate yet. Pairs with the spinner-only 'connecting'
      // indicator so the chart stays empty during the page-load
      // WS-cycling window — no brief data glimpse before the steady
      // stream lands. Any records emitted during the first ≤5 s of
      // the eventually-stable session are dropped; the chart picks
      // up cleanly once the green LED flips.
      if (!s.isStable()) return;
      // stream.js strips the 1-byte channel tag before delivering; the
      // remaining bytes are exactly what /api/data?stream=1 produces
      // — a stream of 16-byte-header records (see data_buffer.h).
      appendBuf(bytes);
      const ip = getIp();
      if (ip) drain(ip).catch(() => {});
    });
    // Indicator state machine driven entirely by stream state.
    // Three live stages map to the LED:
    //   'connected'    — stream.isStreaming() — WS open AND data flowing
    //   'no data'      — stream.isConnected() but no recent frames
    //   'reconnecting' — WS closed or never opened yet
    // Green ('connected') requires actively-flowing data, not just an
    // open socket — so brief open/close cycles never deceive the user.
    setInterval(() => {
      if (stopped) return;
      if (paused) { setState('paused', ''); return; }
      if (!getIp()) { setState('no device', ''); return; }
      // Binary indicator: green-'connected' only when the current
      // session is stable AND data is flowing; otherwise spinner-
      // 'connecting'. Collapses the old 'no data' / 'reconnecting'
      // amber/red flicker through the WS-cycling window into a
      // single calm spinner. (See stream.isStable() — non-sticky,
      // so cable yank → spinner → green again on recovery.)
      if (s.isStable() && s.isStreaming()) {
        if (currentStage !== 'connected') setStage('connected');
      } else if (currentStage !== 'connecting') {
        setStage('connecting');
      }
    }, 500);
  }

  function init(opts) {
    stateEl = document.getElementById('ide-telemetry-state');
    getIp = opts.getIp || (() => null);
    setState('disconnected', '');
    attachToStream();

    window.Conduit = window.Conduit || {};
    window.Conduit.telemetry = {
      stop() {
        stopped = true;
        persistFlush();
      },
      // Used by ide.js around Build & Upload: tell stream.js to close
      // the WS so the OTA's TLS session has the device's mbedtls slab
      // and lwIP heap to itself. Also force a chart gap so the resume
      // after OTA reads as a clean break.
      pause() {
        if (paused) return;
        paused = true;
        const chart = window.Conduit && window.Conduit.chart;
        if (chart && chart.gap) chart.gap();
        persistFlush();
        const s = window.Conduit && window.Conduit.stream;
        if (s) s.pause();
      },
      resume() {
        if (!paused) return;
        paused = false;
        currentRun = null;
        lastUptimeUs = null;
        parseBuf = new Uint8Array(0);
        // Drop the cached msg_id → name map. New firmware registers
        // names in `transmit()` order, which can re-assign msg_ids
        // (e.g. old 0 = CONST_1 disappears, new 0 = SIN). Holding the
        // pre-OTA schema would mis-attribute the first post-reboot
        // records to whatever name the old map listed for that id.
        // The drain loop's "drop unknown msgId" guard then safely
        // discards records until the next /api/data_schema fetch
        // lands the new mapping.
        schema = new Map();
        lastSchemaFetchMs = 0;
        const ds = window.Conduit && window.Conduit.dataStore;
        if (ds && ds.resetSession) ds.resetSession();
        const chart = window.Conduit && window.Conduit.chart;
        if (chart && chart.reset) chart.reset();
        setStage('reconnecting');
        const s = window.Conduit && window.Conduit.stream;
        if (s) s.resume();
      },
      isPaused() { return paused; },
      // Register a one-shot listener that fires the next time runStream
      // successfully opens — i.e. the next "device is reachable" signal
      // from this transport. Returns an unsubscribe function. Used by
      // the OTA flow to detect post-reboot reachability without a
      // separate /api/status poll. Fires once and is removed.
      onNextConnect(cb) {
        if (typeof cb !== 'function') return () => {};
        connectListeners.push(cb);
        return () => {
          connectListeners = connectListeners.filter((x) => x !== cb);
        };
      },
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
    // The user runs `window.CONDUIT_DIAG()` in the browser console and
    // pastes the result back. Captures every transition for the last
    // ~100 events with ms-since-page-load timestamps.
    window.CONDUIT_DIAG = () => ({
      assetVersion: window.CONDUIT_ASSET_VERSION,
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
      dataStore: window.Conduit && window.Conduit.dataStore
                 ? window.Conduit.dataStore.stats() : null,
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
