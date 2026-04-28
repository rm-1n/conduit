// chart.js — uPlot-backed live telemetry charts.
//
// Architecture: plots are PURE DISPLAYS over the central in-memory time-
// series store (window.PicoPoE.dataStore). Each Chart owns a uPlot
// canvas + per-plot view config (window length, channel filter, legend
// visibility, per-plot zoom-cutoff) but NOT the underlying samples.
// Every render slices the dataStore for the requested wall-clock window
// and pushes a fresh frame into uPlot.
//
// Why: previously each plot maintained its own ring buffer (xs[],
// series[name].values[]). Adding a second plot at t=5min and a third at
// t=8min produced three plots showing different ranges of the same data
// (4.19 MB / 797 KB / 320 KB in the prior screenshot) — confusing,
// because the data is identical; only WHEN-the-plot-was-added differed.
// dataStore is the single source of truth; the recording-volume readout
// lives ONCE in the telemetry-pane header (#ide-telemetry-stats).
//
// External API (kept stable so telemetry.js doesn't need to change):
//   window.PicoPoE.chart.push({ name, n, dtype, wallMs, values })
//                                                      → notify all charts
//   window.PicoPoE.chart.clear()                       → all charts (per-plot cutoff)
//   window.PicoPoE.chart.reset()                       → all charts (full rebuild)
//   window.PicoPoE.chart.gap()                         → no-op (gaps detected from wallMs deltas)
//
// Multi-plot API:
//   window.PicoPoE.charts.list()              → Chart[]
//   window.PicoPoE.charts.add(opts?)          → Chart
//   window.PicoPoE.charts.remove(id)          → bool
//   window.PicoPoE.charts.persist()           → ()

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Module-level constants + helpers
  // ---------------------------------------------------------------------

  const SETDATA_MIN_MS    = 33;          // throttle uPlot.setData → ~30 fps
  const DEFAULT_WINDOW_S  = 10;
  const GAP_THRESHOLD_S   = 0.5;
  // Reserved height inside .chart-wrap for uPlot's legend (which sits
  // BELOW the canvas and isn't part of uPlot's `height` opt). Sized to
  // match .u-legend padding/line-height in style.css — bump together if
  // either changes.
  const CHROME_H = 28;

  const PALETTE = [
    '#58a6ff', '#3fb950', '#ff7b72', '#d29922',
    '#a371f7', '#79c0ff', '#56d4dd', '#f0883e',
    '#ffa657', '#7ee787', '#f778ba', '#bc8cff',
  ];
  const colorFor = (i) => PALETTE[i % PALETTE.length];

  function bisectFirst(arr, target, len) {
    let lo = 0, hi = (len != null) ? len : arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function getCssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  }
  const pad2 = (n) => n < 10 ? '0' + n : '' + n;
  const pad3 = (n) => n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n;
  function fmtClockMs(tSec) {
    if (tSec == null || !Number.isFinite(tSec)) return '—';
    const d = new Date(tSec * 1000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' +
           pad2(d.getSeconds()) + '.' + pad3(d.getMilliseconds());
  }
  function fmtVal(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1000 || (a > 0 && a < 0.001)) return v.toExponential(3);
    return v.toFixed(a < 1 ? 4 : a < 100 ? 3 : 2);
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }
  function fmtDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    if (sec < 60) return sec.toFixed(sec < 10 ? 1 : 0) + 's';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec - m * 60);
    if (m < 60) return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
    const h = Math.floor(m / 60);
    const mm = m - h * 60;
    return h + 'h ' + (mm < 10 ? '0' : '') + mm + 'm';
  }

  // ---------------------------------------------------------------------
  // Central recording-volume readout — one element, fed by dataStore.
  // ---------------------------------------------------------------------

  let centralStatsEl = null;
  let centralStatsPending = false;

  function scheduleCentralStats() {
    if (centralStatsPending) return;
    centralStatsPending = true;
    requestAnimationFrame(() => {
      centralStatsPending = false;
      updateCentralStats();
    });
  }

  function updateCentralStats() {
    if (!centralStatsEl) centralStatsEl = document.getElementById('ide-telemetry-stats');
    if (!centralStatsEl) return;
    const ds = window.PicoPoE && window.PicoPoE.dataStore;
    if (!ds) { centralStatsEl.textContent = ''; return; }
    const s = ds.stats();
    if (s.channels === 0 || s.samples === 0) {
      centralStatsEl.textContent = '';
      return;
    }
    const span = (s.sessionStartWallMs != null && s.sessionEndWallMs != null)
      ? (s.sessionEndWallMs - s.sessionStartWallMs) / 1000 : 0;
    centralStatsEl.textContent =
      `${s.channels} ch · ${s.samples.toLocaleString()} pts · ` +
      `${fmtBytes(s.approxBytes)} · ${fmtDuration(span)}`;
  }

  // ---------------------------------------------------------------------
  // Chart class — one instance per plot widget.
  // ---------------------------------------------------------------------

  let nextChartSeq = 1;

  class Chart {
    constructor(opts = {}) {
      this.id      = opts.id    || `plot-${Date.now()}-${nextChartSeq++}`;
      this.title   = opts.title || (nextChartSeq <= 2 ? 'Plot' : `Plot ${nextChartSeq - 1}`);
      this.windowS = opts.windowS || DEFAULT_WINDOW_S;
      // null = accept every channel; Set<string> = whitelist.
      this.channelFilter = Array.isArray(opts.channels) && opts.channels.length > 0
        ? new Set(opts.channels) : null;
      // Per-series visibility restored from persistence — keys are the
      // legend-row label (channel name OR `${name}[${k}]` for vector
      // components). Anything missing defaults to visible.
      this.seriesShow = opts.seriesShow ? new Map(Object.entries(opts.seriesShow))
                                        : new Map();

      // Channel metadata (NOT samples). dataStore owns the bytes.
      // name → { color, n, dtype }.
      this.knownChannels = new Map();

      // Per-plot "clear" cutoff — only this plot hides earlier samples;
      // dataStore is unaffected (so other plots and the HDF5 export keep
      // seeing the full session). null = no cutoff.
      this.clearedSinceMs = null;

      // Render state.
      this.uplot = null;
      this.paused = false;
      this.userZoomed = false;
      this.lastSetDataMs = 0;
      this.setDataPending = false;
      this.rebuildScheduled = false;

      this.parent = opts.parent || document.getElementById('ide-plots');
      this._buildDom();
    }

    // ------------------------------------------------------------------
    // Public lifecycle
    // ------------------------------------------------------------------

    push(rec) {
      if (!rec || !rec.name) return;
      if (this.channelFilter && !this.channelFilter.has(rec.name)) return;
      // Register the channel + (re)schedule a uPlot rebuild if its shape
      // is new. The rebuild adds the necessary series rows; the next
      // _syncToUplot draws them.
      const known = this.knownChannels.get(rec.name);
      if (!known) {
        this.knownChannels.set(rec.name, {
          n: rec.n, dtype: rec.dtype,
          color: colorFor(this.knownChannels.size),
        });
        this._scheduleRebuild();
      } else if (known.n !== rec.n || known.dtype !== rec.dtype) {
        // Shape drift mid-session — replace and rebuild.
        known.n = rec.n; known.dtype = rec.dtype;
        this._scheduleRebuild();
      }
      this._syncToUplot();
    }

    // Per-plot "clear": set a cutoff at the most recent sample time. Only
    // affects what THIS chart renders — dataStore + other plots untouched.
    // The user can drag-zoom or change window to bring older samples back
    // into view if they want; clearing doesn't destroy anything.
    clear() {
      const ds = window.PicoPoE && window.PicoPoE.dataStore;
      this.clearedSinceMs = (ds && ds.sessionEndWallMs != null)
        ? ds.sessionEndWallMs : Date.now();
      this._syncToUplot();
    }

    // Full reset — drop known-channel registry, rebuild uPlot from scratch
    // (no series → placeholder shows). Called on OTA / device switch
    // alongside dataStore.resetSession() so the chart starts blank for
    // the new firmware.
    reset() {
      this.knownChannels.clear();
      this.clearedSinceMs = null;
      this.userZoomed = false;
      if (this.uplot) { try { this.uplot.destroy(); } catch (_) {} this.uplot = null; }
      const placeholder = document.createElement('div');
      placeholder.className = 'chart-placeholder';
      placeholder.textContent = 'waiting for telemetry…';
      this.mount.innerHTML = '';
      this.mount.appendChild(placeholder);
    }

    // No-op: gaps are derived on the read path from wallMs deltas
    // (> GAP_THRESHOLD_S → null inserted between samples). Callers that
    // historically forced a gap don't need to do anything anymore.
    gap() { /* no-op */ }

    destroy() {
      if (this.uplot) { try { this.uplot.destroy(); } catch (_) {} this.uplot = null; }
      if (this.ro)    { try { this.ro.disconnect(); }   catch (_) {} this.ro = null; }
      if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    }

    // Snapshot for the layout store.
    serialize() {
      const seriesShow = {};
      for (const [k, v] of this.seriesShow) seriesShow[k] = v;
      return {
        id: this.id,
        title: this.title,
        windowS: this.windowS,
        channels: this.channelFilter ? [...this.channelFilter] : null,
        seriesShow,
      };
    }

    // ------------------------------------------------------------------
    // DOM
    // ------------------------------------------------------------------

    _buildDom() {
      const icons = window.PicoPoE && window.PicoPoE.icons;

      this.root = document.createElement('div');
      this.root.className = 'plot';
      this.root.dataset.id = this.id;
      this.root.draggable = false;

      this.header = document.createElement('div');
      this.header.className = 'plot-header';

      this.dragHandle = document.createElement('span');
      this.dragHandle.className = 'plot-drag';
      this.dragHandle.title = 'Drag to reorder plots';
      this.dragHandle.setAttribute('aria-label', 'Drag to reorder');
      if (icons) this.dragHandle.innerHTML = icons.svg('drag_indicator', { size: 14 });
      this.dragHandle.addEventListener('mousedown', () => { this.root.draggable = true; });
      this.dragHandle.addEventListener('mouseup',   () => { this.root.draggable = false; });
      this.root.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/picopoe-plot', this.id);
        this.root.classList.add('dragging');
        document.body.classList.add('plot-dragging');
      });
      this.root.addEventListener('dragend', () => {
        this.root.draggable = false;
        this.root.classList.remove('dragging');
        document.body.classList.remove('plot-dragging');
        for (const el of this.parent.querySelectorAll('.plot.drop-above, .plot.drop-below')) {
          el.classList.remove('drop-above', 'drop-below');
        }
      });

      this.titleInput = document.createElement('input');
      this.titleInput.type = 'text';
      this.titleInput.className = 'plot-title';
      this.titleInput.value = this.title;
      this.titleInput.title = 'Plot title';
      this.titleInput.addEventListener('input', () => {
        this.title = this.titleInput.value;
        emitLayoutChange();
      });

      this.windowSel = document.createElement('select');
      this.windowSel.className = 'cmd-select';
      this.windowSel.title = 'Time window';
      this._windowPresets = [[10000, '10 s'], [30000, '30 s'],
                             [60000, '60 s'], [300000, '5 min']];
      this._refreshWindowOptions();
      this.windowSel.addEventListener('change', () => {
        this.windowS = (Number(this.windowSel.value) || 10000) / 1000;
        this.userZoomed = false;
        this._syncToUplot();
        this._applyXScale();
        emitLayoutChange();
      });

      this.pauseBtn = document.createElement('button');
      this.pauseBtn.type = 'button';
      this.pauseBtn.className = 'btn-ghost btn-mini btn-icon';
      this.pauseBtn.title = 'Pause';
      this.pauseBtn.setAttribute('aria-label', 'Pause');
      if (icons) icons.set(this.pauseBtn, 'pause', { size: 14 });
      this.pauseBtn.addEventListener('click', () => {
        this.paused = !this.paused;
        if (icons) icons.set(this.pauseBtn,
          this.paused ? 'play_arrow' : 'pause', { size: 14 });
        this.pauseBtn.title = this.paused ? 'Resume' : 'Pause';
        this.pauseBtn.setAttribute('aria-label', this.paused ? 'Resume' : 'Pause');
        this.pauseBtn.classList.toggle('is-active', this.paused);
        if (!this.paused) this._syncToUplot();
      });

      this.clearBtn = document.createElement('button');
      this.clearBtn.type = 'button';
      this.clearBtn.className = 'btn-ghost btn-mini btn-icon';
      this.clearBtn.title = 'Clear this plot (data store + other plots unaffected)';
      this.clearBtn.setAttribute('aria-label', 'Clear this plot');
      if (icons) icons.set(this.clearBtn, 'delete', { size: 14 });
      this.clearBtn.addEventListener('click', () => this.clear());

      this.deleteBtn = document.createElement('button');
      this.deleteBtn.type = 'button';
      this.deleteBtn.className = 'btn-ghost btn-mini btn-icon plot-delete';
      this.deleteBtn.title = 'Remove this plot';
      this.deleteBtn.setAttribute('aria-label', 'Remove this plot');
      if (icons) icons.set(this.deleteBtn, 'close', { size: 14 });
      this.deleteBtn.addEventListener('click', () => removeChartById(this.id));

      this.header.appendChild(this.dragHandle);
      this.header.appendChild(this.titleInput);
      this.header.appendChild(this.windowSel);
      this.header.appendChild(this.pauseBtn);
      this.header.appendChild(this.clearBtn);
      this.header.appendChild(this.deleteBtn);

      this.mount = document.createElement('div');
      this.mount.className = 'chart-wrap';
      const placeholder = document.createElement('div');
      placeholder.className = 'chart-placeholder';
      placeholder.textContent = 'waiting for telemetry…';
      this.mount.appendChild(placeholder);

      this.root.appendChild(this.header);
      this.root.appendChild(this.mount);
      this.parent.appendChild(this.root);

      this.ro = new ResizeObserver(() => {
        if (!this.uplot || !this.mount) return;
        const h = Math.max(60, this.mount.clientHeight - CHROME_H);
        this.uplot.setSize({ width: this.mount.clientWidth, height: h });
      });
      this.ro.observe(this.mount);

      // Double-click resets the visible window to the largest preset
      // (5 min) — the single discoverable affordance for "show me
      // everything I've recorded" after a series of zoom-ins.
      this.mount.addEventListener('dblclick', () => {
        this.windowS = 300;
        this._refreshWindowOptions();
        this._syncToUplot();
        this._applyXScale();
        emitLayoutChange();
      });
    }

    _isSeriesVisible(label) {
      return this.seriesShow.has(label) ? !!this.seriesShow.get(label) : true;
    }

    // Rebuild the window-selector <option> set so the dropdown always
    // shows the current windowS as a selected entry — when the user
    // drag-zooms to an off-preset value (say 2.4 s), we splice in a
    // synthetic "Custom (2.4s)" option and select it. Picking any
    // preset replaces the synthetic option on the next refresh.
    _refreshWindowOptions() {
      if (!this.windowSel) return;
      const currentMs = Math.round(this.windowS * 1000);
      const presetMs = this._windowPresets.map((p) => p[0]);
      this.windowSel.innerHTML = '';
      const items = presetMs.includes(currentMs)
        ? this._windowPresets
        : [...this._windowPresets, [currentMs, `Custom (${this.windowS.toFixed(1)}s)`]];
      for (const [val, label] of items) {
        const opt = document.createElement('option');
        opt.value = val; opt.textContent = label;
        if (val === currentMs) opt.selected = true;
        this.windowSel.appendChild(opt);
      }
    }

    // ------------------------------------------------------------------
    // uPlot setup
    // ------------------------------------------------------------------

    // The flat list of legend labels — channel name for scalar channels,
    // `${name}[${k}]` for each component of a vector channel. Order
    // matches the columns in the data array returned by
    // _buildRenderData() (after the leading x array).
    _seriesLabels() {
      const out = [];
      for (const [name, meta] of this.knownChannels) {
        if (meta.n === 1) out.push(name);
        else for (let k = 0; k < meta.n; k++) out.push(`${name}[${k}]`);
      }
      return out;
    }

    _scheduleRebuild() {
      if (this.rebuildScheduled) return;
      this.rebuildScheduled = true;
      // 50 ms debounce — back-to-back registrations (e.g. SIN then COS in
      // the same tick) coalesce into one rebuild instead of N.
      setTimeout(() => {
        this.rebuildScheduled = false;
        this._rebuildUplot();
      }, 50);
    }

    _buildOpts(initialData) {
      const w = (this.mount && this.mount.clientWidth)  || 600;
      const fullH = (this.mount && this.mount.clientHeight) || 200;
      const h = Math.max(60, fullH - CHROME_H);
      const stroke = getCssVar('--text2', '#8b949e');
      const grid   = getCssVar('--border-soft', '#20252b');
      const tick   = getCssVar('--border', '#2a3038');

      // Series array — built off knownChannels in registration order.
      const seriesArr = [{ label: 'time', value: (u, t) => fmtClockMs(t) }];
      let colorIdx = 0;
      for (const [name, meta] of this.knownChannels) {
        if (meta.n === 1) {
          seriesArr.push({
            label: name, stroke: meta.color, width: 1.25,
            spanGaps: false, points: { show: false },
            show:  this._isSeriesVisible(name),
            value: (u, v) => fmtVal(v),
          });
        } else {
          for (let k = 0; k < meta.n; k++) {
            const lbl = `${name}[${k}]`;
            // Vector components share the channel base color modulated by
            // index — slightly varied so the legend can tell them apart.
            seriesArr.push({
              label: lbl, stroke: colorFor(colorIdx + k), width: 1.25,
              spanGaps: false, points: { show: false },
              show:  this._isSeriesVisible(lbl),
              value: (u, v) => fmtVal(v),
            });
          }
        }
        colorIdx += meta.n;
      }

      // x-axis: relative-to-now seconds labels are easier to read for
      // streaming data than absolute clock times. Right edge = now.
      // Reads sessionEndWallMs LIVE each time uPlot redraws the axis —
      // this keeps every plot's labels consistent (e.g. "0s ... -5s")
      // regardless of when each plot was created. Previously we
      // captured lastT at chart-build time and plots added later
      // showed labels offset against earlier plots' references.
      const livePresent = () => {
        const ds = window.PicoPoE && window.PicoPoE.dataStore;
        return (ds && ds.sessionEndWallMs != null) ? ds.sessionEndWallMs / 1000 : 0;
      };

      return {
        width: w, height: h,
        pxAlign: 1,
        cursor: {
          // setScale:false — uPlot would otherwise zoom to exactly the
          // dragged range, freezing the right edge wherever the user
          // released. We only want the drag's WIDTH (as the new
          // windowS) and keep auto-scrolling at "now". The setSelect
          // hook below extracts the width and re-applies scale via
          // _applyXScale, which always anchors max=lastT.
          drag:  { x: true, y: false, setScale: false },
          focus: { prox: 16 },
        },
        hooks: {
          setSelect: [(u) => {
            if (!u.select || u.select.width <= 0) return;
            const a = u.posToVal(u.select.left, 'x');
            const b = u.posToVal(u.select.left + u.select.width, 'x');
            const newWindowS = Math.max(0.1, b - a);
            // Clear the visible selection rectangle now that we've
            // captured its width — leaving it set would paint a stale
            // box on the next redraw.
            u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
            this.windowS = newWindowS;
            this._refreshWindowOptions();
            this._syncToUplot();
            this._applyXScale();
            emitLayoutChange();
          }],
          setSeries: [(u, idx, opts) => {
            if (idx == null || !opts || !('show' in opts)) return;
            const seriesCfg = u.series[idx];
            const lbl = seriesCfg && seriesCfg.label;
            if (!lbl) return;
            this.seriesShow.set(lbl, !!opts.show);
            emitLayoutChange();
          }],
        },
        legend: { show: true, live: true, markers: { width: 2 } },
        scales: { x: { time: true }, y: { auto: true } },
        axes: [
          {
            stroke, grid: { stroke: grid, width: 1 }, ticks: { stroke: tick, width: 1 },
            space: 60,
            values: (u, splits) => {
              const lastT = livePresent();
              return splits.map((s) => {
                const dt = s - lastT;
                return dt === 0 ? '0s' : `${dt.toFixed(dt > -10 ? 1 : 0)}s`;
              });
            },
          },
          {
            stroke, grid: { stroke: grid, width: 1 }, ticks: { stroke: tick, width: 1 },
            size: 56,
          },
        ],
        series: seriesArr,
      };
    }

    _rebuildUplot() {
      if (!this.mount || !window.uPlot) return;
      if (this.knownChannels.size === 0) return;
      if (this.uplot) { try { this.uplot.destroy(); } catch (_) {} this.uplot = null; }
      const placeholder = this.mount.querySelector('.chart-placeholder');
      if (placeholder) placeholder.parentNode.removeChild(placeholder);
      for (const stray of this.mount.querySelectorAll('.uplot')) {
        stray.parentNode.removeChild(stray);
      }
      const data = this._buildRenderData();
      this.uplot = new uPlot(this._buildOpts(data), data, this.mount);
      this._applyXScale();
    }

    _applyXScale() {
      if (!this.uplot || this.userZoomed) return;
      const ds = window.PicoPoE && window.PicoPoE.dataStore;
      const lastTms = ds && ds.sessionEndWallMs;
      if (lastTms == null) return;
      const max = lastTms / 1000;
      const min = max - this.windowS;
      this.uplot.setScale('x', { min, max });
    }

    _syncToUplot() {
      // Keep the central readout in sync with whatever just landed.
      scheduleCentralStats();
      if (!this.uplot) return;
      if (this.paused) return;
      // Don't sync mid-rebuild — the new uPlot's series shape may not
      // match the current registry yet.
      const expectedSeriesCount = 1 + this._seriesLabels().length;
      if (this.uplot.series.length !== expectedSeriesCount) return;
      const now = performance.now();
      if (now - this.lastSetDataMs < SETDATA_MIN_MS) {
        if (!this.setDataPending) {
          this.setDataPending = true;
          requestAnimationFrame(() => {
            this.setDataPending = false;
            this.lastSetDataMs = performance.now();
            if (!this.uplot || this.paused) return;
            this.uplot.setData(this._buildRenderData(), false);
            this._applyXScale();
          });
        }
        return;
      }
      this.lastSetDataMs = now;
      this.uplot.setData(this._buildRenderData(), false);
      this._applyXScale();
    }

    // ------------------------------------------------------------------
    // Data slicing (the new core — replaces _pushSample / _trim / _dataArr)
    // ------------------------------------------------------------------

    // Returns the [xs, ...ys] data array uPlot expects. Pulls fresh
    // slices from dataStore for each known channel within the current
    // window. xs is in seconds (uPlot convention); gaps are inserted as
    // null breakpoints when consecutive samples are more than
    // GAP_THRESHOLD_S apart.
    _buildRenderData() {
      const ds = window.PicoPoE && window.PicoPoE.dataStore;
      if (!ds || this.knownChannels.size === 0) {
        // Empty placeholder — uPlot needs at least one column.
        const labels = this._seriesLabels();
        const out = [[]];
        for (let i = 0; i < labels.length; i++) out.push([]);
        return out;
      }

      const lastTms = ds.sessionEndWallMs;
      if (lastTms == null) {
        const labels = this._seriesLabels();
        const out = [[]];
        for (let i = 0; i < labels.length; i++) out.push([]);
        return out;
      }

      let winMinMs = lastTms - this.windowS * 1000;
      if (this.clearedSinceMs != null && this.clearedSinceMs > winMinMs) {
        winMinMs = this.clearedSinceMs;
      }
      const winMaxMs = lastTms + 1;   // inclusive of lastTms

      // Slice each registered channel. Vector channels expand to one
      // entry per component; for the common single-channel-per-plot case
      // (where every entry shares the same wallMs array — they all came
      // from the same dataStore.slice), we fall through to a fast path
      // that skips the union-merge.
      const sliced = []; // [{ wallMs, values }]
      for (const [name, meta] of this.knownChannels) {
        const slice = ds.slice(name, { fromWallMs: winMinMs, toWallMs: winMaxMs });
        if (slice.count === 0) {
          // Push empty entries so the column count still matches the
          // legend. uPlot tolerates empty arrays.
          if (meta.n === 1) sliced.push({ wallMs: null, values: null });
          else for (let k = 0; k < meta.n; k++) sliced.push({ wallMs: null, values: null });
          continue;
        }
        if (meta.n === 1) {
          sliced.push({ wallMs: slice.wallMs, values: slice.values });
        } else {
          for (let k = 0; k < meta.n; k++) {
            // Strided view of the kth component. Float64 destination is
            // safe for any source dtype — uPlot wants Numbers anyway.
            const sub = new Float64Array(slice.count);
            const src = slice.values;
            for (let i = 0; i < slice.count; i++) sub[i] = src[i * meta.n + k];
            sliced.push({ wallMs: slice.wallMs, values: sub });
          }
        }
      }

      // Determine the canonical wallMs array for the unified x axis.
      // Fast path: every populated slice points at the same wallMs
      // buffer (true when the chart only knows about ONE channel —
      // typical case — OR when multiple channels were transmitted in
      // sync at exactly the same wallMs sequence).
      let sharedWall = null;
      for (const s of sliced) {
        if (!s.wallMs) continue;
        if (sharedWall == null) sharedWall = s.wallMs;
        else if (s.wallMs !== sharedWall) { sharedWall = null; break; }
      }

      let xMs, yArrays;
      if (sharedWall) {
        xMs = sharedWall;
        yArrays = sliced.map((s) => s.values || []);
      } else {
        // Multi-channel union path: streams have different timelines so
        // we merge into a single x axis. Sparse fills use zero-order
        // hold (carry-forward) so each series's line stays continuous
        // across timestamps that belong to OTHER streams — without
        // carry-forward, every other sample would be null and uPlot's
        // spanGaps:false would draw nothing.
        const merged = mergeTimelines(sliced);
        xMs = merged.xMs;
        yArrays = merged.yArrays;
      }

      const n = xMs.length;
      if (n === 0) return [[], ...yArrays.map(() => [])];

      // Convert ms → seconds (uPlot expects seconds on time scales).
      // We don't inject null breakpoints for wallMs gaps here — that
      // tripped up the decimator (every bucket containing a leading-
      // edge sparse-fill null got flagged as a gap, blanking the
      // chart). Real network/OTA gaps are typically followed by a
      // chart.reset() anyway; if we want explicit gap rendering later,
      // wire uPlot's per-series `gaps` callback instead.
      const xSec = new Float64Array(n);
      for (let i = 0; i < n; i++) xSec[i] = xMs[i] / 1000;

      return decimateForCanvas([xSec, ...yArrays],
                               (this.mount && this.mount.clientWidth) || 600);
    }
  }

  // ---------------------------------------------------------------------
  // Helpers — timeline merge, decimation
  // ---------------------------------------------------------------------

  // K-way merge for multiple channels with different sample timelines
  // sharing one plot. Output: unified xMs Float64Array + per-stream y
  // arrays where every cell holds the most recently observed value for
  // that stream (zero-order hold). Cells before that stream's first
  // sample stay null, so uPlot's spanGaps:false leaves the series
  // invisible until it has data — but once it produces a sample, the
  // line stays continuous across union timestamps owned by OTHER streams
  // instead of going null/value/null/value (which would render as nothing
  // visible at typical canvas resolutions).
  function mergeTimelines(sliced) {
    const k = sliced.length;
    const idx = new Array(k).fill(0);
    const xs = sliced.map((s) => s.wallMs || new Float64Array(0));
    const ys = sliced.map((s) => s.values || []);
    const lastSeen = new Array(k).fill(null);

    let total = 0;
    for (const arr of xs) total += arr.length;
    const xMs = new Float64Array(total);
    const yArrays = sliced.map(() => new Array(total));
    let w = 0;

    for (;;) {
      // Find the smallest current head across active streams.
      let bestT = Infinity, bestStreams = null;
      for (let i = 0; i < k; i++) {
        if (idx[i] >= xs[i].length) continue;
        const t = xs[i][idx[i]];
        if (t < bestT) { bestT = t; bestStreams = [i]; }
        else if (t === bestT) bestStreams.push(i);
      }
      if (bestStreams == null) break;
      xMs[w] = bestT;
      for (const i of bestStreams) {
        lastSeen[i] = ys[i][idx[i]];
        idx[i]++;
      }
      // Carry-forward (or null if not yet seen) for every series at this
      // union slot, including the contributors — they get the value we
      // just stored in lastSeen.
      for (let i = 0; i < k; i++) yArrays[i][w] = lastSeen[i];
      w++;
    }

    return {
      xMs: w === total ? xMs : xMs.slice(0, w),
      yArrays: yArrays.map((arr) => w === total ? arr : arr.slice(0, w)),
    };
  }

  // Per-bucket extreme decimation — when the visible region has many
  // more samples than pixels, downsample so the polyline draw is cheap
  // without losing visible peaks. Returns the input untouched if the
  // count is already manageable. Operates on the post-gap-injection
  // arrays so gap nulls survive (they end up in their own bucket).
  function decimateForCanvas(data, pxWidth) {
    const xs = data[0];
    const n = xs.length;
    if (n === 0) return data;
    const target = pxWidth * 2;
    if (n <= target) return data;

    const numBuckets = pxWidth;
    const bucketWidth = n / numBuckets;
    const ySrcs = data.slice(1);
    const xOut = [];
    const yOuts = ySrcs.map(() => []);

    for (let b = 0; b < numBuckets; b++) {
      const a = Math.floor(b * bucketWidth);
      const z = Math.min(Math.floor((b + 1) * bucketWidth), n);
      // Nulls are no longer treated as gap markers — with carry-forward
      // they only appear at the leading edge of a series (before its
      // first sample). The min/max scan below skips them naturally.

      // Collect the indices of the min and max value across every series
      // in this bucket — they're the visually-load-bearing samples.
      const positions = new Set();
      for (let s = 0; s < ySrcs.length; s++) {
        const ys = ySrcs[s];
        let mn = Infinity, mx = -Infinity, iMn = -1, iMx = -1;
        for (let i = a; i < z; i++) {
          const v = ys[i];
          if (v == null) continue;
          if (v < mn) { mn = v; iMn = i; }
          if (v > mx) { mx = v; iMx = i; }
        }
        if (iMn >= 0) positions.add(iMn);
        if (iMx >= 0) positions.add(iMx);
      }
      if (positions.size === 0) {
        xOut.push(xs[Math.min(a + ((z - a) >> 1), n - 1)]);
        for (const yo of yOuts) yo.push(null);
        continue;
      }
      const sorted = [...positions].sort((p, q) => p - q);
      for (const pos of sorted) {
        xOut.push(xs[pos]);
        for (let s = 0; s < ySrcs.length; s++) yOuts[s].push(ySrcs[s][pos]);
      }
    }
    return [xOut, ...yOuts];
  }

  // ---------------------------------------------------------------------
  // Registry — fans pushes to all charts, persists layout.
  // ---------------------------------------------------------------------

  const charts = [];
  const LAYOUT_KEY = 'picopoe.plots';
  let layoutSaveTimer = null;

  function emitLayoutChange() {
    if (layoutSaveTimer) return;
    layoutSaveTimer = setTimeout(() => {
      layoutSaveTimer = null;
      saveLayout();
    }, 250);
  }

  function saveLayout() {
    try {
      const arr = charts.map((c) => c.serialize());
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(arr));
    } catch (_) {}
  }
  function loadLayout() {
    try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); }
    catch (_) { return null; }
  }

  function addChart(opts) {
    const c = new Chart(opts || {});
    charts.push(c);
    updateEmptyState();
    emitLayoutChange();
    return c;
  }
  function removeChartById(id) {
    const idx = charts.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    const [c] = charts.splice(idx, 1);
    c.destroy();
    updateEmptyState();
    emitLayoutChange();
    return true;
  }
  function reorderChart(srcId, beforeId) {
    const fromIdx = charts.findIndex((c) => c.id === srcId);
    if (fromIdx < 0) return;
    const [c] = charts.splice(fromIdx, 1);
    const toIdx  = beforeId == null ? charts.length
                                    : charts.findIndex((x) => x.id === beforeId);
    charts.splice(toIdx < 0 ? charts.length : toIdx, 0, c);
    const parent = c.parent;
    for (const x of charts) parent.appendChild(x.root);
    emitLayoutChange();
  }

  function updateEmptyState() {
    const parent = document.getElementById('ide-plots');
    if (!parent) return;
    let placeholder = parent.querySelector('.plots-empty');
    if (charts.length === 0) {
      if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'plots-empty';
        placeholder.textContent = 'No plots — click + above to add one.';
        parent.appendChild(placeholder);
      }
    } else if (placeholder) {
      placeholder.parentNode.removeChild(placeholder);
    }
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  function init() {
    const parent = document.getElementById('ide-plots');
    if (!parent) return;
    if (typeof window.uPlot === 'undefined') {
      console.warn('[chart] uPlot script not loaded — chart disabled.');
      parent.textContent = 'uPlot failed to load (check CDN reachability).';
      return;
    }

    const saved = loadLayout();
    if (Array.isArray(saved) && saved.length > 0) {
      for (const cfg of saved) addChart(cfg);
    } else {
      addChart({ title: 'Plot' });
    }
    updateEmptyState();
    updateCentralStats();

    const addBtn = document.getElementById('ide-add-plot');
    if (addBtn) {
      addBtn.addEventListener('click', () => addChart({ title: 'Plot' }));
    }

    parent.addEventListener('dragover', (ev) => {
      const id = ev.dataTransfer && ev.dataTransfer.types.includes('text/picopoe-plot');
      if (!id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      for (const el of parent.querySelectorAll('.plot.drop-above, .plot.drop-below')) {
        el.classList.remove('drop-above', 'drop-below');
      }
      const target = closestPlot(ev.target);
      if (!target || target.classList.contains('dragging')) return;
      const rect = target.getBoundingClientRect();
      const above = (ev.clientY - rect.top) < (rect.height / 2);
      target.classList.add(above ? 'drop-above' : 'drop-below');
    });
    parent.addEventListener('drop', (ev) => {
      const srcId = ev.dataTransfer && ev.dataTransfer.getData('text/picopoe-plot');
      if (!srcId) return;
      ev.preventDefault();
      const target = closestPlot(ev.target);
      let beforeId = null;
      if (target && !target.classList.contains('dragging')) {
        const rect = target.getBoundingClientRect();
        const above = (ev.clientY - rect.top) < (rect.height / 2);
        beforeId = above ? target.dataset.id : nextSiblingPlotId(target);
      }
      reorderChart(srcId, beforeId);
    });
  }

  function closestPlot(el) {
    while (el && el !== document) {
      if (el.classList && el.classList.contains('plot')) return el;
      el = el.parentNode;
    }
    return null;
  }
  function nextSiblingPlotId(el) {
    let n = el.nextElementSibling;
    while (n && (!n.classList || !n.classList.contains('plot'))) n = n.nextElementSibling;
    return n ? n.dataset.id : null;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API.
  window.PicoPoE = window.PicoPoE || {};
  window.PicoPoE.chart = {
    push:  (rec) => { for (const c of charts) c.push(rec); },
    clear: ()    => { for (const c of charts) c.clear(); },
    reset: ()    => { for (const c of charts) c.reset(); },
    gap:   ()    => { /* no-op — see Chart.gap() */ },
  };
  window.PicoPoE.charts = {
    list:    () => charts.slice(),
    add:     addChart,
    remove:  removeChartById,
    persist: saveLayout,
  };

  // Diagnostic: dump every chart's view config (no buffers anymore).
  window.PICOPOE_TLM_DUMP = () => charts.map((c) => ({
    id: c.id, title: c.title, windowS: c.windowS,
    paused: c.paused, userZoomed: c.userZoomed,
    clearedSinceMs: c.clearedSinceMs,
    knownChannels: [...c.knownChannels.keys()],
  }));
})();
