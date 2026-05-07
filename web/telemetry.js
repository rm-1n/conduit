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

  const RECONNECT_OK_MS    = 100;
  // Sleep between failed reconnect attempts. Browser cost of polling
  // more often is a few extra failed fetches while the cable is
  // genuinely out — not a bottleneck. 150 ms means we land within
  // ~150 ms of the upstream port re-opening.
  const RECONNECT_ERR_MS   = 150;
  const IP_CHECK_MS        = 1000;
  const SCHEMA_REFRESH_MIN_MS = 1000;
  const PERSIST_BATCH_MAX  = 64;
  const PERSIST_BATCH_MS   = 250;
  // Stall watchdog: if the open stream goes silent for this long we
  // assume the underlying TCP is half-dead (Wi-Fi flap, ethernet
  // unplug, NAT timeout, browser idle suspend) and abort so the loop
  // reconnects cleanly. The firmware emits a 16-byte keepalive record
  // every ~500 ms when the data ring is otherwise idle (see
  // CONDUIT_DATA_KEEPALIVE_MSG_ID), so 1 s is one missed keepalive plus
  // jitter — anything longer is genuinely broken.
  const STALL_MS           = 1000;
  const STALL_CHECK_MS     = 150;
  // Connect-phase timeout — between issuing fetch() and the first byte
  // landing. Without this, a device that's just rebooted (TCP accepts
  // but firmware isn't ready to serve) leaves runStream blocked
  // indefinitely on `await fetch(...)` or `await reader.read()`. The
  // stall watchdog can't help here because it skips when lastByteMs is
  // still 0. Firmware emits a 16-byte keepalive every ~500 ms, so
  // 750 ms covers one keepalive + jitter.
  const CONNECT_TIMEOUT_MS = 750;
  // Schema fetch timeout. Sized to match CONNECT_TIMEOUT_MS so an
  // unreachable device doesn't hold runStream's awaited refreshSchema
  // for several seconds while the data path retries every 750 ms.
  // /api/data_schema is ~200 bytes; a healthy LAN delivers it in <10 ms.
  const SCHEMA_TIMEOUT_MS  = 750;

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
  // window.CONDUIT_DIAG(). The buffer is what the user pastes back
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

  // Discriminated state machine for the indicator label.
  //   'connected'    (green) — bytes flowing within STALL_MS
  //   'no data'      (amber) — TCP open + headers received but stale
  //   'reconnecting' (red)   — between runStream invocations
  //   'paused'       (off)   — external pause (OTA)
  //   'no device'    (off)   — getIp returned null
  //   'disconnected' (off)   — initial / stop()
  let currentStage = 'disconnected';
  let stageEnteredAt = 0;
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
      case 'no data':      text = 'no data';      cls = 'err'; break;
      case 'reconnecting': text = 'reconnecting…'; cls = 'err'; break;
      case 'paused':       text = 'paused';       cls = '';    break;
      case 'no device':    text = 'no device';    cls = '';    break;
      case 'disconnected': text = 'disconnected'; cls = '';    break;
      default:             text = currentStage;   cls = '';    break;
    }
    stateEl.textContent = text;
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

  async function refreshSchema(ip, force, parentSignal) {
    const now = Date.now();
    if (!force && now - lastSchemaFetchMs < SCHEMA_REFRESH_MIN_MS) return;
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
        const store = window.Conduit && window.Conduit.logStore;
        if (store && store.setRunSchema) {
          store.setRunSchema(currentRun.streamEpoch, obj).catch(() => {});
        }
      }
    } catch (e) {
      diag('schema.error', { message: String(e && e.message || e) });
    }
    finally {
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
      // lastByteMs (and the runStream chunk-level timer) already
      // ticked when these bytes arrived.
      if (msgId === KEEPALIVE_MSG_ID) {
        i += recordBytes;
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
    // Always live-tail (no `since=`). After a long outage, replaying the
    // backlog would have the device dump tens of KB before getting to
    // current data, adding seconds to perceived recovery time. The user
    // accepts losing samples that occurred while the cable was out —
    // the chart just shows a gap (chart.gap() below) and resumes live.
    const url = `http://${ip}/api/data?stream=1`;
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
      const chart = window.Conduit && window.Conduit.chart;
      if (chart && chart.gap) chart.gap();
    }
    firstStream = false;

    // Schema is refreshed lazily — fired async when an unknown msg_id
    // arrives in drain() (line ~380), or when uptime regresses (reboot
    // path). Doing it synchronously here doubled every recovery's
    // network round-trip count vs the runtime console, which under
    // device PCB pressure (TIME_WAIT pool exhaustion after rapid
    // cable cycles) added ~10 s to telemetry's recover-after-replug
    // time. The cached schema from the prior session stays valid as
    // long as the firmware hasn't changed. Empty-schema first connect
    // resolves itself within one record via the unknown-id path.
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
        const chart = window.Conduit && window.Conduit.chart;
        if (chart && chart.reset) chart.reset();
        // New device session — wipe the in-memory time-series store
        // so the next export only contains data from this device.
        const ds = window.Conduit && window.Conduit.dataStore;
        if (ds && ds.resetSession) ds.resetSession();
      }
      if (!ip) {
        setState('no device', '');
        await sleep(RECONNECT_ERR_MS);
        continue;
      }

      activeAbort = new AbortController();
      // Stage transitions to "reconnecting" the moment we leave the
      // previous stream's "connected" / "no data" state — this is
      // what the user sees as "actively retrying" instead of stuck.
      // setStage rolls the elapsed counter back to 0 so the user
      // sees fresh progress per attempt.
      if (currentStage !== 'connected' && currentStage !== 'paused' &&
          currentStage !== 'no device') {
        setStage('reconnecting');
      }
      try {
        await runStream(ip, activeAbort.signal);
        diag('runStream.endedCleanly');
        await sleep(RECONNECT_OK_MS);
      } catch (e) {
        if (e && e.name === 'AbortError') { diag('runStream.aborted'); continue; }
        diag('runStream.error', { message: String(e && e.message || e) });
        setStage('reconnecting');
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
        // Stall on a connected stream → enter the "no data" stage,
        // abort to force reconnect. The streamLoop catch will then
        // transition us into "reconnecting".
        setStage('no data');
        try { activeAbort.abort(); } catch (_) {}
        // Telemetry and the runtime console share the same TCP fate:
        // if the device's link went down, both streams are dead. The
        // console can't detect this on its own (it has no stall
        // watchdog because logs may legitimately be silent for
        // minutes), so wake it explicitly. Without this the link
        // indicator flips to "Disconnected" the moment telemetry
        // notices but the console stays green for minutes.
        const con = window.Conduit && window.Conduit.console;
        if (con && con.kick) { try { con.kick(); } catch (_) {} }
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

    window.Conduit = window.Conduit || {};
    window.Conduit.telemetry = {
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
        const chart = window.Conduit && window.Conduit.chart;
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
        const chart = window.Conduit && window.Conduit.chart;
        if (chart && chart.reset) chart.reset();
        // firstStream stays false so a future network blip (not OTA)
        // still inserts a chart.gap() — only the OTA path nukes the ring.
        // Force the indicator into "reconnecting" so it doesn't inherit
        // the pre-pause "connected" — without this, the post-OTA gap
        // before bytes arrive looks like a healthy stream that's
        // mysteriously not updating the chart.
        setStage('reconnecting');
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
