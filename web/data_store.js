// data_store.js — In-memory time-series store for telemetry.
//
// Per-channel CHUNKED typed arrays (uptime_us + wall_ms + values).
// Each channel keeps a list of fixed-size chunks (CHUNK_SAMPLES =
// 1 << 20 = ~1 M samples each, ~24 MB total of typed arrays per
// chunk). Append writes into the current chunk; when full, a new
// chunk is allocated — bounded ~24 MB allocation, no memcpy of
// existing history.
//
// Earlier the channel was a single typed-array tuple grown by
// doubling. That worked great up to ~1–2 M samples but at long
// recordings (the 9-hour 29 M-sample case) every doubling near
// the top end allocated 100 s of MB and memcpy'd the entire array,
// stalling the main thread multi-seconds. The firmware's 64 KB
// data ring then overflowed → silent eviction → user-visible gaps.
// Switching to chunked storage caps each growth at one ~24 MB
// allocation regardless of total session length.
//
// Append is O(1). Slice by time range walks chunks (each chunk's
// wallMs is internally sorted, and chunks are time-ordered) — fast
// path for ranges fitting in one chunk returns subarray views
// (zero-copy); cross-chunk ranges concat into a single typed array.
// Export does that concat once at download time, which is a
// one-shot pause rather than 30+ stalls during the recording.
//
// Lifetime = current browser session. Page reload starts fresh; an
// OTA / device switch fires resetSession() to start a new window.
// IDB persistence was intentionally removed: it was the dominant cost
// of the previous design and the user explicitly wants
// session-start → now semantics with no across-reload retention.
//
// Public surface (window.Conduit.dataStore):
//   append({ name, dtype, n, uptimeUs, wallMs, values })  – ingest
//   resetSession()                                          – wipe all
//   listChannels()                                          – channel meta
//   slice(name, { fromWallMs, toWallMs })                   – range read
//   sessionStartWallMs / sessionEndWallMs                   – getters
//   stats()                                                  – { channels, samples, approxBytes }

(function () {
  'use strict';

  // KEEP IN SYNC with conduit_dtype_t in firmware/app/data_buffer.h.
  const DTYPE_SIZE = [1, 1, 2, 2, 4, 4, 8, 8, 4, 8];
  const DTYPE_LABEL = ['I8','U8','I16','U16','I32','U32','I64','U64','F32','F64'];

  function typedArrayForDtype(d, length) {
    switch (d) {
      case 0: return new Int8Array(length);
      case 1: return new Uint8Array(length);
      case 2: return new Int16Array(length);
      case 3: return new Uint16Array(length);
      case 4: return new Int32Array(length);
      case 5: return new Uint32Array(length);
      case 6: return new BigInt64Array(length);
      case 7: return new BigUint64Array(length);
      case 8: return new Float32Array(length);
      case 9: return new Float64Array(length);
      default: return null;
    }
  }
  // Binary search: first index where arr[i] >= target. Operates on
  // a Float64Array of length `len` (the chunk's filled prefix).
  function bisectLeftWallMs(arr, len, target) {
    let lo = 0, hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // 1 M samples per chunk. Each chunk allocates ~24 MB (uptime + wall
  // + values × 8 B). At 1 kHz × 2 channels combined rate, one chunk
  // fills in ~8 minutes — a chunk-per-8-min cadence of 24 MB
  // allocations is invisible to the user, whereas the old doubling
  // strategy was hitting 256+ MB allocations multiple times per long
  // session. Power-of-two-aligned so the indexing math is cheap.
  const CHUNK_SAMPLES = 1 << 20;

  class Channel {
    constructor(name, dtype, n) {
      this.name = name;
      this.dtype = dtype;
      this.n = n;          // elements per sample (1 for scalar, 3 for I16x3, etc)
      this.size = 0;       // total samples filled across all chunks
      // uptime_us / wall_ms stored as Float64 (not BigInt64) — h5wasm's
      // WASM heap can't hold BigInt64 elements, and Float64's 53-bit
      // mantissa gives ~285 years of microsecond resolution.
      this.chunks = [];
      this._pushChunk();
    }

    _pushChunk() {
      this.chunks.push({
        uptimeUs: new Float64Array(CHUNK_SAMPLES),
        wallMs:   new Float64Array(CHUNK_SAMPLES),
        values:   typedArrayForDtype(this.dtype, CHUNK_SAMPLES * this.n),
        size: 0,
      });
    }

    append(uptimeUs, wallMs, values) {
      let chunk = this.chunks[this.chunks.length - 1];
      if (chunk.size >= CHUNK_SAMPLES) {
        this._pushChunk();
        chunk = this.chunks[this.chunks.length - 1];
      }
      // uptimeUs may arrive as Number (typical: telemetry.js builds it
      // as `hi * 0x100000000 + lo`) or BigInt — coerce to Number.
      chunk.uptimeUs[chunk.size] = (typeof uptimeUs === 'bigint') ? Number(uptimeUs) : uptimeUs;
      chunk.wallMs[chunk.size]   = wallMs;
      const off = chunk.size * this.n;
      // values is typically a Float64Array (telemetry.js decodes into
      // one regardless of source dtype). Copy element-wise so dtype
      // narrowing from f64 → e.g. i16 actually narrows.
      for (let k = 0; k < this.n; k++) chunk.values[off + k] = values[k];
      chunk.size++;
      this.size++;
    }

    // Locate (chunkIdx, sampleIdx) where wallMs >= target. Returns
    // [this.chunks.length, 0] if target is past the end. Performs a
    // binary search over chunks first (cheap — each chunk's last
    // wallMs is the cmp key), then a binary search inside the picked
    // chunk's filled prefix.
    _locateWall(target) {
      // Find first chunk whose LAST wallMs is >= target.
      let lo = 0, hi = this.chunks.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const c = this.chunks[mid];
        const lastWall = c.size > 0 ? c.wallMs[c.size - 1] : -Infinity;
        if (lastWall < target) lo = mid + 1;
        else hi = mid;
      }
      if (lo === this.chunks.length) return [lo, 0];
      const within = bisectLeftWallMs(this.chunks[lo].wallMs, this.chunks[lo].size, target);
      return [lo, within];
    }

    // Slice by wall-clock range [fromWallMs, toWallMs).
    //
    // Fast path (range fits in one chunk): returns SUBARRAY VIEWS
    // over the live buffer; the caller must consume them before the
    // next append into that chunk (which is the same chunk-tail-
    // overwrite caveat the old design had). Pass `copy: true` to
    // force independent typed-array copies.
    //
    // Slow path (range spans multiple chunks): always allocates +
    // memcpy's into one combined output. The cost is O(slice size),
    // not O(history); for a 9-hour full export that's ~24 MB total
    // copy budget, one-shot at download time.
    slice({ fromWallMs = -Infinity, toWallMs = Infinity, copy = false } = {}) {
      const [fc, fi] = this._locateWall(fromWallMs);
      const [tc, ti] = this._locateWall(toWallMs);
      // Compute total samples in [fc:fi, tc:ti).
      let M = 0;
      for (let ci = fc; ci <= tc && ci < this.chunks.length; ci++) {
        const c = this.chunks[ci];
        const start = (ci === fc) ? fi : 0;
        const end   = (ci === tc) ? ti : c.size;
        if (end > start) M += (end - start);
      }
      if (M === 0) return { count: 0, uptimeUs: null, wallMs: null, values: null };

      // Single-chunk slice — zero-copy fast path.
      if (fc === tc) {
        const c = this.chunks[fc];
        let uptimeUs = c.uptimeUs.subarray(fi, ti);
        let wallMs   = c.wallMs.subarray(fi, ti);
        let values   = c.values.subarray(fi * this.n, ti * this.n);
        if (copy) {
          uptimeUs = new Float64Array(uptimeUs);
          wallMs   = new Float64Array(wallMs);
          values   = new (c.values.constructor)(values);
        }
        return { count: M, uptimeUs, wallMs, values };
      }

      // Multi-chunk slice — allocate combined output, memcpy each
      // span. This path always copies; `copy: false` is treated as
      // a hint we can ignore because there's no view that spans
      // multiple typed arrays.
      const valuesCtor = this.chunks[0].values.constructor;
      const uptimeUs = new Float64Array(M);
      const wallMs   = new Float64Array(M);
      const values   = new valuesCtor(M * this.n);
      let off = 0;
      for (let ci = fc; ci <= tc && ci < this.chunks.length; ci++) {
        const c = this.chunks[ci];
        const start = (ci === fc) ? fi : 0;
        const end   = (ci === tc) ? ti : c.size;
        const span  = end - start;
        if (span <= 0) continue;
        uptimeUs.set(c.uptimeUs.subarray(start, end), off);
        wallMs.set(  c.wallMs.subarray(  start, end), off);
        values.set(  c.values.subarray(start * this.n, end * this.n), off * this.n);
        off += span;
      }
      return { count: M, uptimeUs, wallMs, values };
    }

    // Min/max-per-bucket fast path for chart pan/zoom. Walks chunks
    // in the requested wall-clock range and emits at most
    // 2 × bucketCount points (min then max per bucket) WITHOUT
    // allocating a full-resolution slice. For a 30-min recording at
    // 1 kHz × 2 chans (~3.6 M samples in the window) the old chart
    // path concat'd ~22 MB of Float64 + then min/max'd over it;
    // this version visits each sample exactly once with two compares
    // and writes ~1200 output points (~20 KB). The reduction in
    // per-frame memory traffic + allocator pressure is what stops
    // heavy pan/zoom from stalling the main thread long enough for
    // the WS stall watchdog to fire and kill the connection.
    //
    // Scalar channels only (this.n === 1). Vector channels fall back
    // to slice() in the chart code — vectors are rare and typically
    // come from short-duration sources (IMU bursts, etc.) where the
    // full-range concat isn't large enough to matter.
    //
    // Output points are in time order. Each bucket emits one point
    // (min == max) or two (min then max if min came first, max then
    // min otherwise) — matching decimateSeries' shape so uPlot's
    // path generator sees the same polyline topology.
    sliceMinMax({ fromWallMs = -Infinity, toWallMs = Infinity, bucketCount }) {
      if (this.n !== 1) {
        // Not supported for vector channels; caller falls back.
        return null;
      }
      if (!Number.isInteger(bucketCount) || bucketCount < 1) bucketCount = 1;
      const [fc, fi] = this._locateWall(fromWallMs);
      const [tc, ti] = this._locateWall(toWallMs);

      // Total sample count in window — needed to compute bucket width
      // and to short-circuit when the slice would already be small
      // (in which case full subarray is cheaper than bucketing).
      let M = 0;
      for (let ci = fc; ci <= tc && ci < this.chunks.length; ci++) {
        const c = this.chunks[ci];
        const start = (ci === fc) ? fi : 0;
        const end   = (ci === tc) ? ti : c.size;
        if (end > start) M += (end - start);
      }
      if (M === 0) return { count: 0, wallMs: null, values: null };

      // Pre-allocate worst-case 2 × bucketCount; subarray to actual
      // write count before returning.
      const xOut = new Float64Array(bucketCount * 2);
      const yOut = new Float64Array(bucketCount * 2);
      let w = 0;

      // Incremental bucket boundary: advancing `nextBoundary` by
      // `bucketWidth` per flush avoids a per-sample Math.floor() —
      // the inner loop becomes one float compare + the value
      // min/max compares, which JIT compiles to tight integer code.
      // The earlier per-sample `Math.floor(globalIdx / bucketWidth)`
      // benchmarked ~3x slower than the OLD slice+decimate path
      // because it forced the inner loop into a double-division
      // path; this rewrite keeps the new approach's
      // no-large-memcpy property without paying that cost.
      const bucketWidth = M / bucketCount;
      let globalIdx = 0;
      let nextBoundary = bucketWidth;                   // float — first boundary
      let bMin = Infinity, bMax = -Infinity;
      let bMinT = 0, bMaxT = 0;
      let bMinTIdx = -1, bMaxTIdx = -1;

      // Inlined flush — kept here for the per-sample loop's call.
      // Hoisting into a closure makes V8 deopt the hot loop.
      const flushBucket = () => {
        if (bMinTIdx < 0) return;
        if (bMinTIdx === bMaxTIdx) {
          xOut[w] = bMinT; yOut[w] = bMin; w++;
        } else if (bMinTIdx < bMaxTIdx) {
          xOut[w] = bMinT; yOut[w] = bMin; w++;
          xOut[w] = bMaxT; yOut[w] = bMax; w++;
        } else {
          xOut[w] = bMaxT; yOut[w] = bMax; w++;
          xOut[w] = bMinT; yOut[w] = bMin; w++;
        }
        bMin = Infinity; bMax = -Infinity;
        bMinTIdx = -1;   bMaxTIdx = -1;
      };

      for (let ci = fc; ci <= tc && ci < this.chunks.length; ci++) {
        const c = this.chunks[ci];
        const start = (ci === fc) ? fi : 0;
        const end   = (ci === tc) ? ti : c.size;
        const wallArr = c.wallMs;
        const valArr  = c.values;
        for (let i = start; i < end; i++) {
          if (globalIdx >= nextBoundary) {
            flushBucket();
            nextBoundary += bucketWidth;
          }
          const v = valArr[i];
          if (v < bMin) { bMin = v; bMinT = wallArr[i]; bMinTIdx = globalIdx; }
          if (v > bMax) { bMax = v; bMaxT = wallArr[i]; bMaxTIdx = globalIdx; }
          globalIdx++;
        }
      }
      flushBucket();

      return {
        count:  w,
        wallMs: xOut.subarray(0, w),
        values: yOut.subarray(0, w),
      };
    }

    approxBytes() {
      return this.size * (8 + 8 + this.n * DTYPE_SIZE[this.dtype]);
    }
  }

  // ---------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------

  const channels = new Map();   // name -> Channel
  let sessionStartWallMs = null;
  let sessionEndWallMs   = null;

  function append({ name, dtype, n, uptimeUs, wallMs, values }) {
    if (!name || !values) return;
    let ch = channels.get(name);
    if (!ch) {
      ch = new Channel(name, dtype, n);
      channels.set(name, ch);
    }
    if (ch.dtype !== dtype || ch.n !== n) {
      // Shape drift mid-session — would make a ragged dataset. Skip
      // the offending record. Future: rename channel by suffix.
      return;
    }
    ch.append(uptimeUs, wallMs, values);
    if (sessionStartWallMs == null) sessionStartWallMs = wallMs;
    sessionEndWallMs = wallMs;
  }

  function resetSession() {
    channels.clear();
    sessionStartWallMs = null;
    sessionEndWallMs = null;
  }

  function listChannels() {
    const out = [];
    for (const ch of channels.values()) {
      out.push({
        name: ch.name,
        dtype: ch.dtype,
        dtypeLabel: DTYPE_LABEL[ch.dtype],
        n: ch.n,
        sampleCount: ch.size,
        approxBytes: ch.approxBytes(),
      });
    }
    return out;
  }

  function slice(name, opts) {
    const ch = channels.get(name);
    if (!ch) return { count: 0 };
    return ch.slice(opts);
  }

  function sliceMinMax(name, opts) {
    const ch = channels.get(name);
    if (!ch) return null;
    return ch.sliceMinMax(opts);
  }

  function stats() {
    let samples = 0, approxBytes = 0;
    for (const ch of channels.values()) {
      samples += ch.size;
      approxBytes += ch.approxBytes();
    }
    return {
      channels: channels.size,
      samples,
      approxBytes,
      sessionStartWallMs,
      sessionEndWallMs,
    };
  }

  window.Conduit = window.Conduit || {};
  window.Conduit.dataStore = {
    append, resetSession, listChannels, slice, sliceMinMax, stats,
    get sessionStartWallMs() { return sessionStartWallMs; },
    get sessionEndWallMs()   { return sessionEndWallMs; },
    DTYPE_LABEL,
  };
})();
