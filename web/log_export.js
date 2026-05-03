// log_export.js — main-thread side of the HDF5 export.
//
// This file is the thin glue that:
//   1. Pulls each channel's slice out of the in-memory data store
//      (window.Conduit.dataStore).
//   2. Hands the typed-array buffers off to log_export_worker.js via
//      postMessage with TRANSFERABLE buffers (no structured-clone copy
//      of the payload — the worker reclaims ownership).
//   3. Awaits the worker's reply, augments the summary with main-side
//      timings and the rendered filename/size, and triggers the browser
//      download.
//
// The actual h5wasm load + create_dataset writes happen inside the
// worker so a multi-megabyte export doesn't block the main thread / the
// telemetry plotting loop. See web/log_export_worker.js.
//
// Output layout — one group per telemetry channel:
//   /telemetry/<NAME>/values     <dtype>[M] or <dtype>[M, n] (vector)
//   /telemetry/<NAME>/uptime_us  float64[M] — device microseconds since boot
//   /telemetry/<NAME>/wall_ms    float64[M] — wall-clock estimate (ms since epoch)
//   attrs on /telemetry/<NAME>: dtype, n, record_count
//   attrs on root: exported_iso, asset_version,
//                  telemetry_channel_count, telemetry_record_count
//
// Logs are intentionally not exported — analysis use-case is the
// telemetry stream.
//
// Python:
//   import h5py
//   with h5py.File('run.h5') as f:
//       sin_t = f['telemetry/SIN/wall_ms'][:]
//       sin_v = f['telemetry/SIN/values'][:]

(function () {
  'use strict';

  // The Worker URL gets the same ?v= cache-bust as the rest of the
  // assets — cribbed off any <script src="...?v=N"> tag so we don't have
  // to bump it independently.
  function workerUrl() {
    if (typeof document === 'undefined') return 'log_export_worker.js';
    const tags = document.querySelectorAll('script[src*="log_export.js"]');
    for (const t of tags) {
      const m = t.getAttribute('src').match(/\?v=([^&]+)/);
      if (m) return `log_export_worker.js?v=${m[1]}`;
    }
    return 'log_export_worker.js';
  }

  let workerInst = null;
  let nextReqId = 1;
  const pending = new Map();   // reqId → { resolve, reject, onProgress }

  function ensureWorker() {
    if (workerInst) return workerInst;
    workerInst = new Worker(workerUrl(), { type: 'module' });
    workerInst.onmessage = (ev) => {
      const msg = ev.data || {};
      const p = pending.get(msg.reqId);
      if (!p) return;
      if (msg.type === 'progress') {
        try { p.onProgress(msg); } catch (_) {}
      } else if (msg.type === 'done') {
        pending.delete(msg.reqId);
        p.resolve({ bytes: msg.bytes, summary: msg.summary });
      } else if (msg.type === 'error') {
        pending.delete(msg.reqId);
        p.reject(new Error(msg.message));
      }
    };
    workerInst.onerror = (e) => {
      // A worker-level error (e.g. failed to load h5wasm) tears down the
      // worker. Fail every pending request and let the next call respawn.
      const err = new Error(e.message || 'log_export worker crashed');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      try { workerInst.terminate(); } catch (_) {}
      workerInst = null;
    };
    return workerInst;
  }

  async function buildHdf5Bytes(opts = {}) {
    const cutoffWallMs = opts.cutoffWallMs;
    const fromWallMs   = opts.fromWallMs;   // optional lower bound; default = session start
    const onProgress   = opts.onProgress || (() => {});
    const tStart = performance.now();

    onProgress({ stage: 'telemetry', pct: 0, label: 'slicing channels…' });
    const tTlm0 = performance.now();
    const ds = window.Conduit && window.Conduit.dataStore;
    if (!ds) throw new Error('data store not loaded');
    const channelsMeta = ds.listChannels();
    const sliceFrom = (fromWallMs != null)
      ? fromWallMs
      : (ds.sessionStartWallMs != null ? ds.sessionStartWallMs : -Infinity);
    const sliceTo = (cutoffWallMs != null) ? cutoffWallMs : Infinity;

    // Build the wire payload — one entry per non-empty channel. We send
    // the underlying ArrayBuffers as TRANSFERABLES so the worker takes
    // ownership; the main thread loses access after postMessage. That's
    // fine: the data store is unaffected (slice copy:true gave us our
    // own arrays), and we never re-read them.
    const payload = [];
    const transfers = [];
    for (let ci = 0; ci < channelsMeta.length; ci++) {
      const meta = channelsMeta[ci];
      onProgress({ stage: 'telemetry',
                   pct: 5 + (ci / Math.max(channelsMeta.length, 1)) * 50,
                   label: `slicing ${meta.name} (${ci + 1}/${channelsMeta.length})…` });
      const slice = ds.slice(meta.name,
                             { fromWallMs: sliceFrom, toWallMs: sliceTo, copy: true });
      if (slice.count === 0) continue;
      payload.push({
        name: meta.name, dtype: meta.dtype, n: meta.n, M: slice.count,
        valuesType:  slice.values.constructor.name,
        valuesBuf:   slice.values.buffer,
        uptimeUsBuf: slice.uptimeUs.buffer,
        wallMsBuf:   slice.wallMs.buffer,
      });
      transfers.push(slice.values.buffer, slice.uptimeUs.buffer, slice.wallMs.buffer);
    }
    const tTlm = performance.now() - tTlm0;

    onProgress({ stage: 'build', pct: 60, label: 'handing to worker…' });
    const w = ensureWorker();
    const reqId = nextReqId++;
    const result = await new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject, onProgress });
      w.postMessage({
        type: 'build', reqId,
        channels: payload,
        assetVersion: String(window.CONDUIT_ASSET_VERSION || ''),
        h5wasmUrl: window.CONDUIT_H5WASM_URL || null,
      }, transfers);
    });

    // Augment the worker's summary with the main-thread slice timing
    // and the overall wall time.
    const summary = result.summary;
    summary.timings = summary.timings || {};
    summary.timings.telemetryMs = Math.round(tTlm);
    summary.timings.totalMs     = Math.round(performance.now() - tStart);
    return { bytes: result.bytes, summary };
  }

  async function downloadHdf5(opts = {}) {
    const { bytes, summary } = await buildHdf5Bytes(opts);
    if (!bytes || bytes.byteLength < 1024) {
      throw new Error('Nothing to export yet — let some data accumulate first.');
    }
    const blob = new Blob([bytes], { type: 'application/x-hdf5' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}` +
                  `${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}` +
                  `${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`;
    const filename = `conduit-${stamp}.h5`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ...summary, filename, sizeBytes: bytes.byteLength };
  }

  // Spin the worker up eagerly on a hint from the UI (typically when the
  // Download button first appears). Lets the h5wasm fetch happen during
  // idle time instead of after the click.
  function warmup() { ensureWorker(); }

  window.Conduit = window.Conduit || {};
  window.Conduit.logExport = {
    downloadHdf5,
    buildHdf5Bytes,
    warmup,
  };
})();
