// log_store.js — IndexedDB-backed persistence for the runtime console.
//
// console.js parses the streaming /api/log into records of shape
//   { stream_epoch, uptime_us, wall_ms, msg }
// and hands them to this module. Records survive tab close and can later
// be exported as HDF5 by web/log_export.js.
//
// Schema (DB: "picopoe-logs", version 1):
//   records: key = auto-increment, indexes:
//              by_run      → [stream_epoch]            (fast per-run scan)
//              by_run_time → [stream_epoch, uptime_us] (in-order iterate)
//   runs:    key = stream_epoch, value = run metadata
//              { stream_epoch, device_ip, wall_ms_anchor, uptime_us_anchor,
//                wall_ms_offset, started_wall_ms }
//
// stream_epoch is the wall-clock ms (Date.now()) at the moment the run
// began. It doubles as a sortable run identifier and a display label.
//
// Retention: capped at ~50 MB of payload bytes (messages only; the index
// overhead is a small multiple on top). Oldest run evicted first.

(function () {
  'use strict';

  const DB_NAME = 'picopoe-logs';
  const DB_VERSION = 2;
  const STORE_RECORDS = 'records';
  const STORE_RUNS = 'runs';
  const STORE_DATA = 'data_records';  // added in v2
  const DEFAULT_QUOTA_BYTES = 50 * 1024 * 1024;

  let dbPromise = null;

  // Rough in-memory sum of msg bytes persisted per run. Authoritative size
  // is recomputed on eviction by iterating the store — this is just a fast
  // path so we don't iterate the whole DB on every append.
  let approxBytesByRun = new Map();
  let approxTotalBytes = 0;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_RECORDS)) {
          const s = db.createObjectStore(STORE_RECORDS, {
            keyPath: 'id', autoIncrement: true,
          });
          s.createIndex('by_run', 'stream_epoch', { unique: false });
          s.createIndex('by_run_time', ['stream_epoch', 'uptime_us'],
                        { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_RUNS)) {
          db.createObjectStore(STORE_RUNS, { keyPath: 'stream_epoch' });
        }
        if (!db.objectStoreNames.contains(STORE_DATA)) {
          // Binary poe_data records. Each row:
          //   { stream_epoch, msg_id, uptime_us, wall_ms, dtype, n,
          //     bytes: Uint8Array of length n*sizeof(dtype) }
          // Indexed by run (for scan) and by (run, msg_id, uptime_us) so
          // the exporter can iterate a single message series in order.
          const s = db.createObjectStore(STORE_DATA, {
            keyPath: 'id', autoIncrement: true,
          });
          s.createIndex('by_run', 'stream_epoch', { unique: false });
          s.createIndex('by_run_msg_time',
                        ['stream_epoch', 'msg_id', 'uptime_us'],
                        { unique: false });
        }
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    return dbPromise;
  }

  // Record a new run's metadata. Returns the streamEpoch which callers use
  // as the partition key for append().
  async function startRun({ deviceIp, wallMsAnchor, uptimeUsAnchor, wallMsOffset }) {
    const db = await open();
    const streamEpoch = wallMsAnchor; // unique enough; ties are impossibly rare
    await new Promise((resolve, reject) => {
      const t = db.transaction([STORE_RUNS], 'readwrite');
      t.onerror = () => reject(t.error);
      t.oncomplete = () => resolve();
      t.objectStore(STORE_RUNS).put({
        stream_epoch: streamEpoch,
        device_ip: deviceIp || '',
        wall_ms_anchor: wallMsAnchor,
        uptime_us_anchor: uptimeUsAnchor,
        wall_ms_offset: wallMsOffset,
        started_wall_ms: Date.now(),
        schema: {},  // populated by setRunSchema as channels register
      });
    });
    return streamEpoch;
  }

  // Update the schema map for an existing run. Called by telemetry.js
  // every time /api/data_schema yields new entries; the latest snapshot
  // wins. Used by log_export.js to label the per-channel HDF5 groups.
  async function setRunSchema(streamEpoch, schema) {
    if (streamEpoch == null || !schema) return;
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction([STORE_RUNS], 'readwrite');
      t.onerror = () => reject(t.error);
      t.oncomplete = () => resolve();
      const s = t.objectStore(STORE_RUNS);
      const req = s.get(streamEpoch);
      req.onsuccess = () => {
        const run = req.result;
        if (!run) return;
        // Merge — never drop ids that registered earlier in the run.
        run.schema = Object.assign({}, run.schema || {}, schema);
        s.put(run);
      };
    });
  }

  // Bulk append. records is an array of
  //   { stream_epoch, uptime_us, wall_ms, msg }.
  // Counts bytes against the approx totals so eviction can fire without a
  // full-DB scan on the hot path.
  async function append(records) {
    if (!records || records.length === 0) return;
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction([STORE_RECORDS], 'readwrite');
      t.onerror = () => reject(t.error);
      t.oncomplete = () => resolve();
      const s = t.objectStore(STORE_RECORDS);
      for (const r of records) s.add(r);
    });
    let added = 0;
    for (const r of records) added += (r.msg ? r.msg.length : 0);
    approxTotalBytes += added;
    const streamEpoch = records[0].stream_epoch;
    approxBytesByRun.set(streamEpoch,
      (approxBytesByRun.get(streamEpoch) || 0) + added);
    if (approxTotalBytes > DEFAULT_QUOTA_BYTES) {
      // Fire-and-forget; the next append doesn't need to wait for eviction.
      evictUntilUnder(DEFAULT_QUOTA_BYTES * 0.9).catch(() => {});
    }
  }

  // Async iterator over records; yields in insertion order within a run.
  // Same getAll-then-yield pattern as allDataRecords (see comment there)
  // — cursor-across-await deadlocks on busy stores.
  async function *allRecords({ streamEpoch } = {}) {
    const db = await open();
    const records = await new Promise((resolve, reject) => {
      const t = db.transaction([STORE_RECORDS], 'readonly');
      const s = t.objectStore(STORE_RECORDS);
      const req = (streamEpoch != null)
        ? s.index('by_run_time').getAll(IDBKeyRange.bound(
            [streamEpoch, 0], [streamEpoch, Number.MAX_SAFE_INTEGER]))
        : s.getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result || []);
    });
    for (const rec of records) yield rec;
  }

  async function allRuns() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction([STORE_RUNS], 'readonly');
      const s = t.objectStore(STORE_RUNS);
      const req = s.getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const rows = (req.result || []).slice();
        rows.sort((a, b) => a.stream_epoch - b.stream_epoch);
        resolve(rows);
      };
    });
  }

  // Drop oldest run(s) until total bytes drop below targetBytes. Coarse
  // (whole-run granularity) — good enough for a log capture capped at
  // tens of MB. Returns bytes evicted.
  async function evictUntilUnder(targetBytes) {
    const runs = await allRuns();
    if (runs.length <= 1) return 0;  // don't touch the only run (current)
    let freed = 0;
    for (const run of runs) {
      if (approxTotalBytes <= targetBytes) break;
      const bytes = approxBytesByRun.get(run.stream_epoch) || 0;
      await deleteRun(run.stream_epoch);
      approxTotalBytes -= bytes;
      approxBytesByRun.delete(run.stream_epoch);
      freed += bytes;
      // Leave the newest run intact even if we blow past the target.
      if (runs.indexOf(run) >= runs.length - 1) break;
    }
    return freed;
  }

  async function deleteRun(streamEpoch) {
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction([STORE_RECORDS, STORE_RUNS, STORE_DATA], 'readwrite');
      t.onerror = () => reject(t.error);
      t.oncomplete = () => resolve();

      const purgeByRun = (storeName) => {
        const idx = t.objectStore(storeName).index('by_run');
        const req = idx.openCursor(IDBKeyRange.only(streamEpoch));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return;
          cur.delete();
          cur.continue();
        };
      };
      purgeByRun(STORE_RECORDS);
      purgeByRun(STORE_DATA);
      t.objectStore(STORE_RUNS).delete(streamEpoch);
    });
  }

  async function clear() {
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction([STORE_RECORDS, STORE_RUNS, STORE_DATA], 'readwrite');
      t.onerror = () => reject(t.error);
      t.oncomplete = () => resolve();
      t.objectStore(STORE_RECORDS).clear();
      t.objectStore(STORE_RUNS).clear();
      t.objectStore(STORE_DATA).clear();
    });
    approxBytesByRun.clear();
    approxTotalBytes = 0;
  }

  // -- Binary telemetry records ------------------------------------------

  // Bulk append. records is an array of
  //   { stream_epoch, msg_id, uptime_us, wall_ms, dtype, n,
  //     bytes: Uint8Array }
  // The bytes count goes into the same approxTotal so eviction stays
  // unified across log + data.
  async function appendData(records) {
    if (!records || records.length === 0) return;
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction([STORE_DATA], 'readwrite');
      t.onerror = () => reject(t.error);
      t.oncomplete = () => resolve();
      const s = t.objectStore(STORE_DATA);
      for (const r of records) s.add(r);
    });
    let added = 0;
    for (const r of records) added += (r.bytes ? r.bytes.byteLength : 0);
    approxTotalBytes += added;
    const streamEpoch = records[0].stream_epoch;
    approxBytesByRun.set(streamEpoch,
      (approxBytesByRun.get(streamEpoch) || 0) + added);
    if (approxTotalBytes > DEFAULT_QUOTA_BYTES) {
      evictUntilUnder(DEFAULT_QUOTA_BYTES * 0.9).catch(() => {});
    }
  }

  // Iterate all data records for a run, optionally filtered to one msg_id.
  //
  // Implementation: chunked getAll() driven by the (msg_id, uptime_us)
  // index. Each chunk opens its own short-lived readonly transaction
  // that fetches at most CHUNK records, then advances the lower bound
  // to one past the last seen uptime. Reasons for the chunking:
  //   - One-shot getAll() for a long run (e.g. 35s × 1 kHz = 35k+
  //     records per channel) sometimes trips Chrome's IDB UnknownError
  //     ("operation failed for reasons unrelated to the database
  //     itself") because the result set materialises a giant array of
  //     structured-cloned objects (each holding a Uint8Array payload).
  //   - The previous cursor-across-await pattern was racy and could
  //     deadlock when the transaction auto-committed mid-iteration.
  // Chunked getAll keeps each transaction short and bounds peak memory.
  // Caller MUST pass msgId for the chunked path (the [stream_epoch,
  // msg_id, uptime_us] composite key only paginates correctly within a
  // single msg_id — uptime_us repeats across channels). When msgId is
  // omitted we fall back to a single getAll for the whole run.
  async function *allDataRecords({ streamEpoch, msgId } = {}) {
    if (streamEpoch == null) return;
    const db = await open();
    const CHUNK = 5000;
    if (msgId == null) {
      // Whole-run scan — kept for diagnostics. Use cautiously on big
      // stores; the export path always passes msgId so it never lands
      // here.
      const records = await new Promise((resolve, reject) => {
        const t = db.transaction([STORE_DATA], 'readonly');
        const s = t.objectStore(STORE_DATA);
        const idx = s.index('by_run');
        const req = idx.getAll(streamEpoch);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result || []);
      });
      for (const rec of records) yield rec;
      return;
    }
    let lowerUptime = 0;
    for (;;) {
      const records = await new Promise((resolve, reject) => {
        const t = db.transaction([STORE_DATA], 'readonly');
        const s = t.objectStore(STORE_DATA);
        const idx = s.index('by_run_msg_time');
        const lo = [streamEpoch, msgId, lowerUptime];
        const hi = [streamEpoch, msgId, Number.MAX_SAFE_INTEGER];
        const req = idx.getAll(IDBKeyRange.bound(lo, hi), CHUNK);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result || []);
      });
      if (records.length === 0) break;
      for (const rec of records) yield rec;
      if (records.length < CHUNK) break;
      // Advance past the last uptime — uptime_us is unique within a
      // single (stream_epoch, msg_id), so +1 doesn't skip valid rows.
      lowerUptime = records[records.length - 1].uptime_us + 1;
      // Yield to the event loop so the page stays responsive during
      // a long iteration (lots of chunks).
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // Sum msg bytes across all records. Slower than the approx counter — use
  // for the UI footer ("N records · M KB") or diagnostic sanity checks.
  async function stats() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction([STORE_RECORDS], 'readonly');
      const s = t.objectStore(STORE_RECORDS);
      const req = s.openCursor();
      let count = 0, bytes = 0;
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) {
          approxTotalBytes = bytes; // reconcile drift
          resolve({ count, bytes });
          return;
        }
        count++;
        bytes += (cur.value.msg ? cur.value.msg.length : 0);
        cur.continue();
      };
    });
  }

  window.PicoPoE = window.PicoPoE || {};
  window.PicoPoE.logStore = {
    open, startRun, setRunSchema, append, allRecords, allRuns,
    deleteRun, clear, stats, evictUntilUnder, appendData, allDataRecords,
  };
})();
