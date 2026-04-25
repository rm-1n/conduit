// log_export.js — HDF5 export for the IndexedDB log store.
//
// Lazy-loads h5wasm on the first call to downloadHdf5(). h5wasm ships as
// an ES module + inlined WASM, fetched on demand from jsdelivr (see
// H5WASM_VERSION below); the 4 MB glue is never fetched unless the user
// actually clicks "Download". Override via window.PICOPOE_H5WASM_URL for
// air-gapped or self-hosted deployments.
//
// Output layout (flat, pandas-friendly):
//   /stream_epoch  int64[N]      — which run each row belongs to
//   /uptime_us     int64[N]      — device microseconds since boot
//   /wall_ms       float64[N]    — wall-clock estimate (ms since epoch)
//   /msg           vlen utf8[N]  — the log message, trimmed of trailing "\n"
//   attrs on root:
//     runs_json    utf-8 string  — JSON-serialized run metadata array
//     exported_iso                — when the file was generated
//     asset_version               — PICOPOE_ASSET_VERSION at export time
//
// Python:
//   import h5py, json, pandas as pd
//   with h5py.File('run.h5') as f:
//       df = pd.DataFrame({
//         'stream_epoch': f['stream_epoch'][:],
//         'uptime_us':    f['uptime_us'][:],
//         'wall_ms':      f['wall_ms'][:],
//         'msg':          [b.decode() for b in f['msg'][:]],
//       })
//       runs = json.loads(f.attrs['runs_json'])

(function () {
  'use strict';

  // Load h5wasm from a CDN — keeps the 4 MB glue out of the repo and out
  // of GitHub Pages deploys (web/assets/ is fully gitignored). jsdelivr
  // serves npm packages with correct CORS headers and preserves the
  // module's relative `import './hdf5_util.js'` so a single import here
  // pulls in both files.
  //
  // To pin a different version, change H5WASM_VERSION below (or set
  // window.PICOPOE_H5WASM_URL before this script loads to override the
  // whole URL — useful for local mirroring or air-gapped deploys).
  // Bumping: confirm the new release still exports { File, ready, FS,
  // Module } from dist/esm/hdf5_hl.js. The file size of hdf5_util.js
  // jumped from ~4 MB to ~5 MB across 0.7.x → 0.8.x; not a concern, just
  // expect cold-load to take longer.
  const H5WASM_VERSION = '0.8.1';
  const H5WASM_MODULE =
    (typeof window !== 'undefined' && window.PICOPOE_H5WASM_URL) ||
    `https://cdn.jsdelivr.net/npm/h5wasm@${H5WASM_VERSION}/dist/esm/hdf5_hl.js`;

  let h5wasmPromise = null;

  async function loadH5wasm() {
    if (h5wasmPromise) return h5wasmPromise;
    h5wasmPromise = (async () => {
      // Dynamic import so the multi-MB glue isn't fetched on page load.
      // `FS` and `Module` are NOT in the default export — they're live
      // bindings on the namespace object and go from null to the actual
      // Emscripten values once `ready` resolves.
      const ns = await import(H5WASM_MODULE);
      if (ns.ready && typeof ns.ready.then === 'function') await ns.ready;
      return {
        File: ns.File,
        Group: ns.Group,
        Dataset: ns.Dataset,
        ready: ns.ready,
        FS: ns.FS,         // live binding: populated after `ready`
        Module: ns.Module, // live binding: populated after `ready`
        ns,                // keep the namespace so callers can re-read FS later
      };
    })().catch((e) => {
      h5wasmPromise = null;
      throw new Error(
        `Failed to load h5wasm from ${H5WASM_MODULE}. ` +
        `If you're offline or behind a firewall, set window.PICOPOE_H5WASM_URL ` +
        `to a self-hosted hdf5_hl.js (its sibling hdf5_util.js must be at the ` +
        `same path — the loader does a relative import). ` +
        `Underlying error: ${e && e.message || e}`);
    });
    return h5wasmPromise;
  }

  // Gather everything in the store into parallel typed arrays. We iterate
  // once to count rows, then allocate; keeping it as one pass would be
  // possible with array growth, but two passes keeps memory use predictable
  // for a multi-MB export.
  async function collectRecords() {
    const store = window.PicoPoE && window.PicoPoE.logStore;
    if (!store) throw new Error('log store not initialised');

    // First pass: count.
    let n = 0;
    for await (const _ of store.allRecords()) n++;
    if (n === 0) throw new Error('No records to export — the log store is empty.');

    // Second pass: fill arrays.
    const streamEpoch = new BigInt64Array(n);
    const uptimeUs    = new BigInt64Array(n);
    const wallMs      = new Float64Array(n);
    const msgs        = new Array(n);
    let i = 0;
    for await (const rec of store.allRecords()) {
      streamEpoch[i] = BigInt(rec.stream_epoch);
      uptimeUs[i]    = BigInt(rec.uptime_us);
      wallMs[i]      = Number(rec.wall_ms);
      msgs[i]        = rec.msg || '';
      i++;
    }

    const runs = await store.allRuns();
    return { n, streamEpoch, uptimeUs, wallMs, msgs, runs };
  }

  async function buildHdf5Bytes() {
    const h5 = await loadH5wasm();
    const { n, streamEpoch, uptimeUs, wallMs, msgs, runs } =
      await collectRecords();

    const fname = `pico-poe-${Date.now()}.h5`;
    const FS = h5.FS;
    // Ensure any stale copy from a previous export is gone.
    try { FS.unlink(fname); } catch (_) {}
    const f = new h5.File(fname, 'w');
    try {
      // Numeric columns — h5wasm picks '<i8' / '<f8' from the typed arrays.
      f.create_dataset({ name: 'stream_epoch', data: streamEpoch });
      f.create_dataset({ name: 'uptime_us',    data: uptimeUs });
      f.create_dataset({ name: 'wall_ms',      data: wallMs });
      // Variable-length utf-8 strings. h5wasm's 'S' dtype with a plain
      // string[] payload creates HDF5_VLEN_STRINGS; h5py reads as bytes.
      f.create_dataset({
        name: 'msg',
        data: msgs,
        dtype: 'S',
      });

      f.create_attribute('runs_json', JSON.stringify(runs));
      f.create_attribute('exported_iso', new Date().toISOString());
      f.create_attribute('asset_version',
                         String(window.PICOPOE_ASSET_VERSION || ''));
      // guess_metadata doesn't know how to handle BigInt scalars — use a
       // plain Number (safe up to 2^53 rows, i.e. ~9 PB of log bytes).
       f.create_attribute('record_count', n);

      f.flush();
    } finally {
      f.close();
    }

    const bytes = FS.readFile(fname);  // Uint8Array
    try { FS.unlink(fname); } catch (_) {}
    return bytes;
  }

  async function downloadHdf5() {
    const bytes = await buildHdf5Bytes();
    const blob = new Blob([bytes], { type: 'application/x-hdf5' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}` +
                  `${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}` +
                  `${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`;
    a.href = url;
    a.download = `pico-poe-${stamp}.h5`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after the next tick so the download is flushed to disk first.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.PicoPoE = window.PicoPoE || {};
  window.PicoPoE.logExport = {
    downloadHdf5,
    loadH5wasm,   // expose for warm-up if the UI wants to prefetch
    collectRecords,
  };
})();
