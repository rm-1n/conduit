// data_store.js — In-memory time-series store for telemetry.
//
// Per-channel typed arrays (uptime_us + wall_ms + values), grown on
// demand by power-of-two doubling. Append is O(1) amortized; slice by
// time range is O(log N) via binary search; export concatenates per-
// channel typed-array slices straight into HDF5 datasets — no
// per-record IndexedDB transactions, no structured-clone overhead.
//
// Lifetime = current browser session. Page reload starts fresh; an
// OTA / device switch fires resetSession() to start a new window.
// IDB persistence was intentionally removed: it was the dominant cost
// of the previous design and the user explicitly wants
// session-start → now semantics with no across-reload retention.
//
// Public surface (window.PicoPoE.dataStore):
//   append({ name, dtype, n, uptimeUs, wallMs, values })  – ingest
//   resetSession()                                          – wipe all
//   listChannels()                                          – channel meta
//   slice(name, { fromWallMs, toWallMs })                   – range read
//   sessionStartWallMs / sessionEndWallMs                   – getters
//   stats()                                                  – { channels, samples, approxBytes }

(function () {
  'use strict';

  // KEEP IN SYNC with poe_dtype_t in firmware/app/data_buffer.h.
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
  function widerTypedArray(src, newLen) {
    // Same constructor as src, sized to newLen.
    const C = src.constructor;
    const out = new C(newLen);
    out.set(src);
    return out;
  }

  // Binary search: first index where wallMs[i] >= target. Operates on
  // a Float64Array of length `len` (the channel's filled prefix).
  function bisectLeftWallMs(arr, len, target) {
    let lo = 0, hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  class Channel {
    constructor(name, dtype, n) {
      this.name = name;
      this.dtype = dtype;
      this.n = n;          // elements per sample (1 for scalar, 3 for I16x3, etc)
      this.cap = 1024;     // initial sample capacity; doubles on grow
      this.size = 0;       // sample count actually filled
      // uptime_us is stored as Float64 (not BigInt64) — h5wasm's WASM
      // heap can't hold BigInt64 elements (`BigInt64Array elements are
      // incompatible with Int32Array`), and Float64's 53-bit mantissa
      // gives us ~285 years of microsecond resolution. Plenty.
      this.uptimeUs = new Float64Array(this.cap);
      this.wallMs   = new Float64Array(this.cap);
      this.values   = typedArrayForDtype(dtype, this.cap * n);
    }

    _ensureCapacity(needed) {
      if (needed <= this.cap) return;
      let newCap = this.cap;
      while (newCap < needed) newCap *= 2;
      this.uptimeUs = widerTypedArray(this.uptimeUs, newCap);
      this.wallMs   = widerTypedArray(this.wallMs,   newCap);
      this.values   = widerTypedArray(this.values,   newCap * this.n);
      this.cap = newCap;
    }

    append(uptimeUs, wallMs, values) {
      this._ensureCapacity(this.size + 1);
      // uptimeUs may arrive as Number (typical: telemetry.js builds it
      // as `hi * 0x100000000 + lo`) or BigInt — coerce to Number.
      this.uptimeUs[this.size] = (typeof uptimeUs === 'bigint') ? Number(uptimeUs) : uptimeUs;
      this.wallMs[this.size]   = wallMs;
      const off = this.size * this.n;
      // values is typically a Float64Array (telemetry.js decodes into
      // one regardless of source dtype). Copy element-wise so dtype
      // narrowing from f64 → e.g. i16 actually narrows.
      for (let k = 0; k < this.n; k++) this.values[off + k] = values[k];
      this.size++;
    }

    // Slice by wall-clock range [fromWallMs, toWallMs). Returns
    // SUBARRAY VIEWS over the live buffer; the caller MUST consume
    // them before the next append (which can reallocate). Pass
    // { copy: true } to get independent typed-array copies.
    slice({ fromWallMs = -Infinity, toWallMs = Infinity, copy = false } = {}) {
      const lo = bisectLeftWallMs(this.wallMs, this.size, fromWallMs);
      const hi = bisectLeftWallMs(this.wallMs, this.size, toWallMs);
      const M = hi - lo;
      if (M === 0) return { count: 0, uptimeUs: null, wallMs: null, values: null };
      let uptimeUs = this.uptimeUs.subarray(lo, hi);
      let wallMs   = this.wallMs.subarray(lo, hi);
      let values   = this.values.subarray(lo * this.n, hi * this.n);
      if (copy) {
        uptimeUs = new Float64Array(uptimeUs);
        wallMs   = new Float64Array(wallMs);
        values   = new (this.values.constructor)(values);
      }
      return { count: M, uptimeUs, wallMs, values };
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

  window.PicoPoE = window.PicoPoE || {};
  window.PicoPoE.dataStore = {
    append, resetSession, listChannels, slice, stats,
    get sessionStartWallMs() { return sessionStartWallMs; },
    get sessionEndWallMs()   { return sessionEndWallMs; },
    DTYPE_LABEL,
  };
})();
