// log_export_worker.js — Module Worker that owns the h5wasm runtime and
// the HDF5 build path.
//
// Runs as `new Worker('log_export_worker.js?v=N', { type: 'module' })`
// from the main thread. The h5wasm WASM glue (~5 MB) is loaded inside the
// worker so the main thread never pays the parse/instantiate cost — and
// the actual create_dataset writes happen off-thread, so multi-megabyte
// exports don't freeze plotting.
//
// Dual-mode: also importable as a plain ESM module from Node so
// web/tests/log_export_hdf5.mjs can call `writeHdf5(...)` directly without
// spinning up a real Worker. The message-handler block at the bottom is
// guarded so it only attaches when this file is actually running as a
// Worker.
//
// Message protocol (main → worker):
//   { type: 'build', reqId, channels:[{ name, dtype, n, M,
//                                       valuesType, valuesBuf,
//                                       uptimeUsBuf, wallMsBuf }],
//                    assetVersion, h5wasmUrl }
// Worker → main:
//   { type: 'progress', reqId, stage, pct, label }
//   { type: 'done',     reqId, bytes, summary }
//   { type: 'error',    reqId, message }
//
// Buffers are TRANSFERABLE — the main thread loses ownership of the
// channel buffers when it posts the message, and reclaims `bytes.buffer`
// when the worker posts done. This avoids a structured-clone memcpy for
// what can easily be 100 MB of telemetry.

const H5WASM_VERSION = '0.8.1';
const DEFAULT_H5WASM_URL =
  `https://cdn.jsdelivr.net/npm/h5wasm@${H5WASM_VERSION}/dist/esm/hdf5_hl.js`;

const TYPED_ARRAY_CTORS = {
  Int8Array, Uint8Array,
  Int16Array, Uint16Array,
  Int32Array, Uint32Array,
  BigInt64Array, BigUint64Array,
  Float32Array, Float64Array,
};

function dtypeLabel(d) {
  return ['I8','U8','I16','U16','I32','U32','I64','U64','F32','F64'][d] || `?${d}`;
}

let h5wasmPromise = null;
async function loadH5wasm(url) {
  if (h5wasmPromise) return h5wasmPromise;
  const target = url || DEFAULT_H5WASM_URL;
  h5wasmPromise = (async () => {
    const ns = await import(target);
    if (ns.ready && typeof ns.ready.then === 'function') await ns.ready;
    return ns;
  })().catch((e) => {
    h5wasmPromise = null;
    throw new Error(
      `Failed to load h5wasm from ${target}. ` +
      `Underlying error: ${e && e.message || e}`);
  });
  return h5wasmPromise;
}

// writeHdf5(channels, opts) — pure function. Builds an HDF5 file from
// the supplied channel array and returns { bytes: Uint8Array, summary }.
//
// `channels` items are { name, dtype, n, M, values, uptimeUs, wallMs }
// where the three array fields are real TypedArrays — NOT the wire
// representation { ...Buf, ...Type }. The worker message handler
// reconstructs typed arrays before calling.
//
// Exported so the Node test (web/tests/log_export_hdf5.mjs) can drive
// the build path directly without a Worker.
export async function writeHdf5(channels, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const assetVersion = opts.assetVersion || '';
  const tStart = performance.now();

  onProgress({ stage: 'h5wasm', pct: 0, label: 'loading h5wasm…' });
  const tH5Wasm0 = performance.now();
  const h5 = await loadH5wasm(opts.h5wasmUrl);
  const tH5Wasm = performance.now() - tH5Wasm0;

  onProgress({ stage: 'build', pct: 75, label: 'building HDF5…' });
  const tBuild0 = performance.now();

  let firstWallMs = Infinity, lastWallMs = -Infinity;
  let totalTlmRecords = 0;

  const fname = `conduit-${Date.now()}.h5`;
  const FS = h5.FS;
  try { FS.unlink(fname); } catch (_) {}
  const f = new h5.File(fname, 'w');
  try {
    // h5wasm's create_dataset doesn't auto-create intermediate groups
    // (no LCPL flag exposed) — write at group level after creating each
    // group explicitly. See memory project_h5wasm_intermediate_groups.md
    // and web/tests/log_export_hdf5.mjs.
    // h5wasm dtype strings: NOT the numpy convention. The library
    // matches `^([<>|]?)([bhiqefdsBHIQS])([0-9]*)$` and looks up size
    // from the LETTER (b/B=1, h/H=2, i/I=4, q/Q=8, e=2, f=4, d=8).
    // Trailing digits are ignored. Using `<u4` (numpy U32) throws
    // "is not a recognized dtype"; using `<i2` for I16 silently
    // packs the data as I32 (4 bytes/sample, dataset is 2x too big
    // and reads as int32 in Python). Always use the single-letter
    // size-implied form.
    //                       I8   U8   I16  U16  I32  U32  I64  U64  F32  F64
    const DTYPE_H5     = ['<b','<B','<h','<H','<i','<I','<q','<Q','<f','<d'];
    let tlmRoot = null;
    if (channels.length > 0) {
      f.create_group('telemetry');
      tlmRoot = f.get('telemetry');
    }
    for (const t of channels) {
      if (!t || t.M === 0) continue;
      tlmRoot.create_group(t.name);
      const grp = f.get(`telemetry/${t.name}`);
      const valsDtype = DTYPE_H5[t.dtype] || '<f8';
      const shape = (t.n === 1) ? [t.M] : [t.M, t.n];
      grp.create_dataset({ name: 'values',    data: t.values,   shape, dtype: valsDtype });
      grp.create_dataset({ name: 'uptime_us', data: t.uptimeUs, shape: [t.M], dtype: '<f8' });
      grp.create_dataset({ name: 'wall_ms',   data: t.wallMs,   shape: [t.M], dtype: '<f8' });
      try {
        grp.create_attribute('dtype',        dtypeLabel(t.dtype));
        grp.create_attribute('n',            t.n);
        grp.create_attribute('record_count', t.M);
      } catch (_) { /* non-fatal */ }
      if (t.wallMs[0]       < firstWallMs) firstWallMs = t.wallMs[0];
      if (t.wallMs[t.M - 1] > lastWallMs)  lastWallMs  = t.wallMs[t.M - 1];
      totalTlmRecords += t.M;
    }

    f.create_attribute('exported_iso',            new Date().toISOString());
    f.create_attribute('asset_version',           String(assetVersion));
    f.create_attribute('telemetry_channel_count', channels.length);
    f.create_attribute('telemetry_record_count',  totalTlmRecords);
    f.flush();
  } finally {
    f.close();
  }

  const bytes = FS.readFile(fname);  // Uint8Array (own buffer)
  try { FS.unlink(fname); } catch (_) {}
  const tBuild = performance.now() - tBuild0;
  onProgress({ stage: 'build', pct: 100, label: 'done' });

  if (!Number.isFinite(firstWallMs)) firstWallMs = null;
  if (!Number.isFinite(lastWallMs))  lastWallMs  = null;

  const summary = {
    logRecords: 0,
    runs: 0,
    telemetryChannels: channels.length,
    telemetryRecords: totalTlmRecords,
    firstWallMs, lastWallMs,
    durationMs: (firstWallMs != null && lastWallMs != null)
      ? Math.round(lastWallMs - firstWallMs) : 0,
    timings: {
      h5wasmMs: Math.round(tH5Wasm),
      logMs:    0,
      buildMs:  Math.round(tBuild),
      totalMs:  Math.round(performance.now() - tStart),
      // telemetryMs is contributed by the main thread (it owns the slice
      // step). Filled in by the caller in log_export.js before surfacing
      // the summary to the UI.
    },
  };
  return { bytes, summary };
}

// ---- Worker message handler -----------------------------------------------
//
// Only attached when this file is actually running inside a Worker.
// Guard: WorkerGlobalScope is undefined in Node and in the browser main
// thread, so the listener is a no-op there. Importing this file as a
// plain ESM module (e.g. from the test) just gets `writeHdf5` and skips
// the handler entirely.
const isWorker = typeof self !== 'undefined'
              && typeof WorkerGlobalScope !== 'undefined'
              && self instanceof WorkerGlobalScope;

if (isWorker) {
  self.addEventListener('message', async (ev) => {
    const msg = ev.data || {};
    if (msg.type !== 'build') return;
    const { reqId, channels: wire, assetVersion, h5wasmUrl } = msg;
    try {
      const channels = wire.map((c) => {
        const Ctor = TYPED_ARRAY_CTORS[c.valuesType];
        if (!Ctor) throw new Error(`unknown valuesType ${c.valuesType}`);
        return {
          name: c.name, dtype: c.dtype, n: c.n, M: c.M,
          values:   new Ctor(c.valuesBuf),
          uptimeUs: new Float64Array(c.uptimeUsBuf),
          wallMs:   new Float64Array(c.wallMsBuf),
        };
      });
      const onProgress = (p) =>
        self.postMessage({ type: 'progress', reqId, ...p });
      const result = await writeHdf5(channels, { assetVersion, h5wasmUrl, onProgress });
      // Transfer the bytes' backing buffer back to the main thread so we
      // don't structured-clone the file payload.
      self.postMessage(
        { type: 'done', reqId, bytes: result.bytes, summary: result.summary },
        [result.bytes.buffer],
      );
    } catch (e) {
      self.postMessage({ type: 'error', reqId, message: String(e && e.message || e) });
    }
  });
}
