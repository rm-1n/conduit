// chart.js — uPlot-backed live telemetry charts.
//
// Multi-instance: each Chart owns its own buffer + uPlot canvas + controls,
// stacked vertically inside the telemetry pane. Telemetry pushes fan out
// to every Chart, which decides whether to ingest based on its own
// channel filter. The classic single-plot UX is preserved by default —
// one chart starts mounted, showing every channel.
//
// External API (kept stable so telemetry.js doesn't need to change):
//   window.PicoPoE.chart.push({ name, n, values, wallMs, ... })  // → all charts
//   window.PicoPoE.chart.clear()                                  // → all charts
//   window.PicoPoE.chart.reset()                                  // → all charts
//   window.PicoPoE.chart.gap()                                    // → all charts
//
// Multi-plot API:
//   window.PicoPoE.charts.list()              → Chart[]
//   window.PicoPoE.charts.add(opts?)          → Chart   // create + register
//   window.PicoPoE.charts.remove(id)          → bool
//   window.PicoPoE.charts.persist()           → ()      // save layout
//
// Why uPlot: purpose-built for high-density time-series tail. Renders
// 100k+ points smoothly at 60 fps, ~30 KB min+gz. Loaded from a CDN.
//
// Per-chart data model:
//   xs[]            — time axis in seconds (unix epoch). Same-tick records
//                     (multiple transmit() in one device loop iter) collapse
//                     to a single x-index via TICK_TOLERANCE_S.
//   series[name]    — { idx, values, color } where values is null-padded
//                     to xs.length.
//   channelFilter   — null = accept all; Set<string> = accept only those.

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Module-level constants + helpers (stateless, shared across charts).
  // ---------------------------------------------------------------------

  const BUFFER_DURATION_S  = 5 * 60;
  const TRIM_AFTER_PUSHES  = 256;
  const SETDATA_MIN_MS     = 33;
  const DEFAULT_WINDOW_S   = 10;
  const TICK_TOLERANCE_S   = 0.0005;
  const GAP_THRESHOLD_S    = 0.5;
  // Reserved chrome height inside each chart for the uPlot bottom-axis +
  // legend (lives below the canvas, overflows .chart-wrap).
  const CHROME_H = 56;

  const PALETTE = [
    '#58a6ff', '#3fb950', '#ff7b72', '#d29922',
    '#a371f7', '#79c0ff', '#56d4dd', '#f0883e',
    '#ffa657', '#7ee787', '#f778ba', '#bc8cff',
  ];
  const colorFor = (i) => PALETTE[i % PALETTE.length];

  function bisectFirst(arr, target) {
    let lo = 0, hi = arr.length;
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
  // Chart class — one instance per plot widget.
  // ---------------------------------------------------------------------

  let nextChartSeq = 1;

  class Chart {
    constructor(opts = {}) {
      this.id        = opts.id      || `plot-${Date.now()}-${nextChartSeq++}`;
      this.title     = opts.title   || (nextChartSeq <= 2 ? 'Plot' : `Plot ${nextChartSeq - 1}`);
      this.windowS   = opts.windowS || DEFAULT_WINDOW_S;
      // null = accept every channel; Array<string> = whitelist.
      this.channelFilter = Array.isArray(opts.channels) && opts.channels.length > 0
        ? new Set(opts.channels) : null;
      // Per-series visibility state restored from persistence — keys are
      // channel names, values are boolean. Anything missing defaults to
      // visible. Driven by the legend chip clicks.
      this.seriesShow = opts.seriesShow ? new Map(Object.entries(opts.seriesShow))
                                        : new Map();

      // Buffer state.
      this.xs = [];
      this.series = new Map();
      this.gapIdx = new Set();
      this.lastT = 0;

      // Render state.
      this.uplot = null;
      this.paused = false;
      this.userZoomed = false;
      this.pushesSinceTrim = 0;
      this.lastSetDataMs = 0;
      this.setDataPending = false;
      this.infoPending = false;
      this.rebuildScheduled = false;

      // DOM. parent is the container that holds all plots; the Chart
      // builds + appends its own .plot subtree.
      this.parent = opts.parent || document.getElementById('ide-plots');
      this._buildDom();
    }

    // ------------------------------------------------------------------
    // Public lifecycle
    // ------------------------------------------------------------------

    push(rec) {
      if (!rec || !rec.values) return;
      if (this.channelFilter && !this.channelFilter.has(rec.name)) return;
      const tSec = (rec.wallMs || Date.now()) / 1000;
      if (rec.n === 1) {
        this._pushSample(rec.name, tSec, rec.values[0]);
      } else {
        for (let k = 0; k < rec.n; k++) {
          this._pushSample(`${rec.name}[${k}]`, tSec, rec.values[k]);
        }
      }
      if (++this.pushesSinceTrim >= TRIM_AFTER_PUSHES) {
        this.pushesSinceTrim = 0;
        this._trim();
      }
      this._syncToUplot();
    }

    clear() {
      this.xs.length = 0;
      for (const s of this.series.values()) s.values.length = 0;
      this.gapIdx.clear();
      this.lastT = 0;
      if (this.uplot) this.uplot.setData(this._dataArr());
      this._updateInfo();
    }

    reset() {
      this.xs.length = 0;
      this.series.clear();
      this.gapIdx.clear();
      this.lastT = 0;
      this.userZoomed = false;
      this._rebuildUplot();
      this._updateInfo();
    }

    gap() {
      if (this.xs.length === 0) return;
      this.gapIdx.add(this.xs.length);
      this.xs.push(this.xs[this.xs.length - 1] + 1e-3);
      for (const s of this.series.values()) s.values.push(null);
      this._syncToUplot();
    }

    destroy() {
      if (this.uplot) { try { this.uplot.destroy(); } catch (_) {} this.uplot = null; }
      if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    }

    // Snapshot of persistable config for the layout store.
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
      // draggable is toggled on by the drag-handle's mousedown so we
      // don't accidentally drag the plot when grabbing a control.
      this.root.draggable = false;

      // Header: drag handle + title input + window select + per-plot
      // pause/clear/delete.
      this.header = document.createElement('div');
      this.header.className = 'plot-header';

      this.dragHandle = document.createElement('span');
      this.dragHandle.className = 'plot-drag';
      this.dragHandle.title = 'Drag to reorder plots';
      this.dragHandle.setAttribute('aria-label', 'Drag to reorder');
      if (icons) this.dragHandle.innerHTML = icons.svg('drag_indicator', { size: 14 });
      // Mouse-down arms the drag; the actual reorder is HTML5 DnD on
      // the .plot root. Touchstart is a no-op for now (touch DnD has
      // its own quirks; nice-to-have, not blocking).
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
        // Clear any drop-indicator from siblings.
        for (const el of this.parent.querySelectorAll('.plot.drop-above, .plot.drop-below')) {
          el.classList.remove('drop-above', 'drop-below');
        }
      });

      this.titleInput = document.createElement('input');
      this.titleInput.type = 'text';
      this.titleInput.className = 'plot-title';
      this.titleInput.value = this.title;
      this.titleInput.title = 'Plot title (used in HDF5 export)';
      this.titleInput.addEventListener('input', () => {
        this.title = this.titleInput.value;
        emitLayoutChange();
      });

      this.infoEl = document.createElement('span');
      this.infoEl.className = 'plot-info';

      this.windowSel = document.createElement('select');
      this.windowSel.className = 'cmd-select';
      this.windowSel.title = 'Time window';
      for (const [val, label] of [[10000, '10 s'], [30000, '30 s'],
                                   [60000, '60 s'], [300000, '5 min']]) {
        const opt = document.createElement('option');
        opt.value = val; opt.textContent = label;
        if (val === this.windowS * 1000) opt.selected = true;
        this.windowSel.appendChild(opt);
      }
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
      this.clearBtn.title = 'Clear plot history';
      this.clearBtn.setAttribute('aria-label', 'Clear plot history');
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
      this.header.appendChild(this.infoEl);
      this.header.appendChild(this.windowSel);
      this.header.appendChild(this.pauseBtn);
      this.header.appendChild(this.clearBtn);
      this.header.appendChild(this.deleteBtn);

      // Canvas mount. Channel show/hide is driven by uPlot's built-in
      // legend (clickable series labels under the canvas) — no separate
      // chip row needed.
      this.mount = document.createElement('div');
      this.mount.className = 'chart-wrap';
      const placeholder = document.createElement('div');
      placeholder.className = 'chart-placeholder';
      placeholder.textContent = 'waiting for telemetry…';
      this.mount.appendChild(placeholder);

      this.root.appendChild(this.header);
      this.root.appendChild(this.mount);
      this.parent.appendChild(this.root);

      // Resize uPlot when this plot's container size changes.
      this.ro = new ResizeObserver(() => {
        if (!this.uplot || !this.mount) return;
        const h = Math.max(60, this.mount.clientHeight - CHROME_H);
        this.uplot.setSize({ width: this.mount.clientWidth, height: h });
      });
      this.ro.observe(this.mount);

      // Double-click to release any in-flight drag-zoom.
      this.mount.addEventListener('dblclick', () => {
        if (!this.userZoomed) return;
        this.userZoomed = false;
        this._syncToUplot();
        this._applyXScale();
      });
    }

    _isSeriesVisible(name) {
      return this.seriesShow.has(name) ? !!this.seriesShow.get(name) : true;
    }

    // ------------------------------------------------------------------
    // Series / data ingest
    // ------------------------------------------------------------------

    _ensureSeries(name) {
      let s = this.series.get(name);
      if (s) return s;
      const newIdx = this.series.size + 1;
      const padded = new Array(this.xs.length);
      for (let i = 0; i < this.xs.length; i++) padded[i] = null;
      s = { idx: newIdx, values: padded, color: colorFor(this.series.size) };
      this.series.set(name, s);
      // Debounce: rapid back-to-back registrations (SIN then COS) coalesce
      // into a single uPlot rebuild with both series populated.
      this._scheduleRebuild();
      return s;
    }

    _pushSample(name, tSec, v) {
      const s = this._ensureSeries(name);
      let xi;
      const xs = this.xs;
      if (xs.length > 0 && Math.abs(xs[xs.length - 1] - tSec) < TICK_TOLERANCE_S) {
        xi = xs.length - 1;
      } else {
        if (xs.length > 0 && Math.abs(tSec - xs[xs.length - 1]) > GAP_THRESHOLD_S) {
          this.gapIdx.add(xs.length);
          xs.push(xs[xs.length - 1] + 1e-3);
          for (const ss of this.series.values()) ss.values.push(null);
        }
        xi = xs.length;
        xs.push(tSec);
        this.lastT = tSec;
        for (const ss of this.series.values()) ss.values.push(null);
      }
      s.values[xi] = v;
    }

    _trim() {
      if (this.xs.length === 0) return;
      const cutoff = this.lastT - BUFFER_DURATION_S;
      let drop = 0;
      while (drop < this.xs.length && this.xs[drop] < cutoff) drop++;
      if (drop > 0) {
        this.xs.splice(0, drop);
        for (const s of this.series.values()) s.values.splice(0, drop);
        if (this.gapIdx.size > 0) {
          const kept = [];
          for (const idx of this.gapIdx) {
            const next = idx - drop;
            if (next >= 0) kept.push(next);
          }
          this.gapIdx.clear();
          for (const idx of kept) this.gapIdx.add(idx);
        }
      }
    }

    // ------------------------------------------------------------------
    // uPlot setup + render
    // ------------------------------------------------------------------

    _scheduleRebuild() {
      if (this.rebuildScheduled) return;
      this.rebuildScheduled = true;
      setTimeout(() => {
        this.rebuildScheduled = false;
        this._rebuildUplot();
      }, 50);
    }

    _buildOpts() {
      const w = (this.mount && this.mount.clientWidth)  || 600;
      const fullH = (this.mount && this.mount.clientHeight) || 200;
      const h = Math.max(60, fullH - CHROME_H);
      const stroke = getCssVar('--text2', '#8b949e');
      const grid   = getCssVar('--border-soft', '#20252b');
      const tick   = getCssVar('--border', '#2a3038');
      const seriesArr = [
        { label: 'time', value: (u, t) => fmtClockMs(t) },
        ...[...this.series.entries()].map(([name, s]) => ({
          label: name,
          stroke: s.color,
          width: 1.25,
          spanGaps: false,
          points: { show: false },
          show: this._isSeriesVisible(name),
          value: (u, v) => fmtVal(v),
        })),
      ];
      const lastT = this.lastT;
      return {
        width: w, height: h,
        pxAlign: 1,
        cursor: {
          drag:  { x: true, y: false, setScale: true },
          focus: { prox: 16 },
        },
        hooks: {
          setSelect: [(u) => {
            if (u.select && u.select.width > 0) this.userZoomed = true;
          }],
          // Persist legend-driven show/hide so reload restores it.
          // uPlot calls setSeries with idx/null for the cursor focus
          // path too — only persist when `opts.show` is the change.
          setSeries: [(u, idx, opts) => {
            if (idx == null || !opts || !('show' in opts)) return;
            const seriesCfg = u.series[idx];
            const name = seriesCfg && seriesCfg.label;
            if (!name) return;
            this.seriesShow.set(name, !!opts.show);
            emitLayoutChange();
          }],
        },
        legend: { show: true, live: true, markers: { width: 2 } },
        scales: { x: { time: true }, y: { auto: true } },
        axes: [
          {
            stroke, grid: { stroke: grid, width: 1 }, ticks: { stroke: tick, width: 1 },
            space: 60,
            values: (u, splits) => splits.map((s) => {
              const dt = s - lastT;
              return dt === 0 ? '0s' : `${dt.toFixed(dt > -10 ? 1 : 0)}s`;
            }),
          },
          {
            stroke, grid: { stroke: grid, width: 1 }, ticks: { stroke: tick, width: 1 },
            size: 56,
          },
        ],
        series: seriesArr,
      };
    }

    _dataArr() {
      const d = [this.xs];
      for (const s of this.series.values()) d.push(s.values);
      return d;
    }

    _buildRenderData() {
      const xs = this.xs;
      const n = xs.length;
      if (n === 0) return [[]];
      const winMax = this.lastT;
      const winMin = winMax - this.windowS;
      const startIdx = bisectFirst(xs, winMin);
      const visibleCount = n - startIdx;
      if (visibleCount === 0) return this._dataArr();

      const px = (this.mount && this.mount.clientWidth) || 600;
      const target = px * 2;
      if (visibleCount <= target) {
        const xSlice = xs.slice(startIdx);
        const out = [xSlice];
        for (const s of this.series.values()) out.push(s.values.slice(startIdx));
        return out;
      }

      // Per-extreme decimation — see the comment block in the previous
      // version for the rationale (kept verbatim in spirit, condensed).
      const numBuckets = px;
      const bucketWidth = visibleCount / numBuckets;
      const seriesArr = [...this.series.values()];
      const xOut = [];
      const seriesOut = seriesArr.map(() => []);

      for (let b = 0; b < numBuckets; b++) {
        const a = startIdx + Math.floor(b * bucketWidth);
        const z = Math.min(startIdx + Math.floor((b + 1) * bucketWidth), n);

        let bucketHasGap = false;
        for (let i = a; i < z; i++) {
          if (this.gapIdx.has(i)) { bucketHasGap = true; break; }
          if (i > a && (xs[i] - xs[i - 1]) > GAP_THRESHOLD_S) {
            bucketHasGap = true; break;
          }
        }
        if (bucketHasGap) {
          const xCenter = xs[Math.min(a + ((z - a) >> 1), n - 1)];
          xOut.push(xCenter);
          for (let si = 0; si < seriesArr.length; si++) seriesOut[si].push(null);
          continue;
        }

        const posSet = new Set();
        for (let si = 0; si < seriesArr.length; si++) {
          const s = seriesArr[si];
          let mn = Infinity, mx = -Infinity, iMn = -1, iMx = -1;
          for (let i = a; i < z; i++) {
            const v = s.values[i];
            if (v == null) continue;
            if (v < mn) { mn = v; iMn = i; }
            if (v > mx) { mx = v; iMx = i; }
          }
          if (iMn >= 0) posSet.add(iMn);
          if (iMx >= 0) posSet.add(iMx);
        }
        if (posSet.size === 0) {
          const xCenter = xs[Math.min(a + ((z - a) >> 1), n - 1)];
          xOut.push(xCenter);
          for (let si = 0; si < seriesArr.length; si++) seriesOut[si].push(null);
          continue;
        }

        const positions = [...posSet].sort((p, q) => p - q);
        for (const pos of positions) {
          xOut.push(xs[pos]);
          for (let si = 0; si < seriesArr.length; si++) {
            seriesOut[si].push(seriesArr[si].values[pos]);
          }
        }
      }
      return [xOut, ...seriesOut];
    }

    _rebuildUplot() {
      if (!this.mount || !window.uPlot) return;
      if (this.series.size === 0) return;
      if (this.uplot) { try { this.uplot.destroy(); } catch (_) {} this.uplot = null; }
      const placeholder = this.mount.querySelector('.chart-placeholder');
      if (placeholder) placeholder.parentNode.removeChild(placeholder);
      for (const stray of this.mount.querySelectorAll('.uplot')) {
        stray.parentNode.removeChild(stray);
      }
      this.uplot = new uPlot(this._buildOpts(), this._dataArr(), this.mount);
      this._applyXScale();
    }

    _applyXScale() {
      if (!this.uplot || this.xs.length === 0 || this.userZoomed) return;
      const max = this.lastT;
      const minWanted = max - this.windowS;
      let min = minWanted;
      const startIdx = bisectFirst(this.xs, minWanted);
      if (startIdx < this.xs.length && this.xs[startIdx] - minWanted > 0.010) {
        min = this.xs[startIdx];
      }
      this.uplot.setScale('x', { min, max });
    }

    _scheduleInfoUpdate() {
      if (this.infoPending) return;
      this.infoPending = true;
      requestAnimationFrame(() => {
        this.infoPending = false;
        this._updateInfo();
      });
    }

    _syncToUplot() {
      this._scheduleInfoUpdate();
      if (!this.uplot) return;
      if (this.paused) return;
      if (this.uplot.series.length - 1 !== this.series.size) return;
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

    _updateInfo() {
      if (!this.infoEl) return;
      if (this.series.size === 0 || this.xs.length === 0) {
        this.infoEl.textContent = 'no data';
        return;
      }
      const bytes = this.xs.length * 8 * (1 + this.series.size);
      const span  = this.xs[this.xs.length - 1] - this.xs[0];
      this.infoEl.textContent =
        `${this.series.size} ch · ${fmtBytes(bytes)} · ${fmtDuration(span)}`;
    }
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
  // Move chart `srcId` to the slot just BEFORE `beforeId`, or to the
  // end if beforeId is null. Reorders both the charts array and the
  // DOM order so the next persisted layout matches what the user sees.
  function reorderChart(srcId, beforeId) {
    const fromIdx = charts.findIndex((c) => c.id === srcId);
    if (fromIdx < 0) return;
    const [c] = charts.splice(fromIdx, 1);
    const toIdx  = beforeId == null ? charts.length
                                    : charts.findIndex((x) => x.id === beforeId);
    charts.splice(toIdx < 0 ? charts.length : toIdx, 0, c);
    // Re-append in new order — appendChild moves existing nodes.
    const parent = c.parent;
    for (const x of charts) parent.appendChild(x.root);
    emitLayoutChange();
  }

  // The "no plots" placeholder lives inside the container; show/hide
  // it as charts come and go. The user can re-add via the topbar `+`.
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
  // Init: restore saved plots (or create one default), wire the
  // `+ add plot` button, expose the public façade.
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

    const addBtn = document.getElementById('ide-add-plot');
    if (addBtn) {
      addBtn.addEventListener('click', () => addChart({ title: 'Plot' }));
    }

    // Reorder via HTML5 drag-and-drop. Each .plot is the drag source
    // (armed by its drag handle's mousedown — see the Chart ctor).
    // The container is the drop target; on dragover we mark the
    // sibling the cursor is hovering over with .drop-above /
    // .drop-below so the user gets a positional cue, and on drop we
    // resolve to the BEFORE-which sibling and call reorderChart().
    parent.addEventListener('dragover', (ev) => {
      const id = ev.dataTransfer && ev.dataTransfer.types.includes('text/picopoe-plot');
      if (!id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      // Clear previous indicators.
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
    gap:   ()    => { for (const c of charts) c.gap(); },
  };
  window.PicoPoE.charts = {
    list:    () => charts.slice(),
    add:     addChart,
    remove:  removeChartById,
    persist: saveLayout,
  };

  // Diagnostic: dump every chart's state. Same exit shape as before but
  // wrapped per-chart so the test scripts can iterate.
  window.PICOPOE_TLM_DUMP = () => {
    return charts.map((c) => {
      const round = (v) => (typeof v === 'number' && Number.isFinite(v))
        ? +v.toFixed(6) : v;
      const head = (arr, n) => arr.slice(0, n).map(round);
      const tail = (arr, n) => arr.slice(-n).map(round);
      const out = {
        id: c.id, title: c.title, windowS: c.windowS,
        xs_length: c.xs.length, lastT: c.lastT,
        gapIdx_size: c.gapIdx.size,
        paused: c.paused, userZoomed: c.userZoomed,
        series: {},
      };
      for (const [name, s] of c.series) {
        out.series[name] = {
          color: s.color, idx: s.idx,
          values_first10: head(s.values, 10),
          values_last5:   tail(s.values, 5),
          visible: c._isSeriesVisible(name),
        };
      }
      return out;
    });
  };
})();
