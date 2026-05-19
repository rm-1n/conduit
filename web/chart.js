// chart.js — uPlot-backed live telemetry charts.
//
// Architecture: plots are PURE DISPLAYS over the central in-memory time-
// series store (window.Conduit.dataStore). Each Chart owns a uPlot
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
//   window.Conduit.chart.push({ name, n, dtype, wallMs, values })
//                                                      → notify all charts
//   window.Conduit.chart.clear()                       → all charts (per-plot cutoff)
//   window.Conduit.chart.reset()                       → all charts (full rebuild)
//   window.Conduit.chart.gap()                         → no-op (gaps detected from wallMs deltas)
//
// Multi-plot API:
//   window.Conduit.charts.list()              → Chart[]
//   window.Conduit.charts.add(opts?)          → Chart
//   window.Conduit.charts.remove(id)          → bool
//   window.Conduit.charts.persist()           → ()

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Module-level constants + helpers
  // ---------------------------------------------------------------------

  const SETDATA_MIN_MS    = 33;          // throttle uPlot.setData → ~30 fps
  const DEFAULT_WINDOW_S  = 10;
  // Hard cap on the visible / scrolled-back window. The chart still
  // collects everything in dataStore, but the UI never asks the
  // decimator to digest more than 1 hour at once — that keeps every
  // wheel/drag interaction in the steady-state perf envelope even
  // after a long streaming session.
  const MAX_WINDOW_S      = 3600;
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

  // ---------------------------------------------------------------------
  // Global plot line style — 'continuous' (linear interpolation across
  // union-merge null cells) or 'discrete' (zero-order-hold rendered as
  // explicit step-after paths). Surfaced via Conduit.chart.setStyle()
  // for the Settings UI; persisted to localStorage so the choice
  // survives reloads. Charts pick this up at series-build time inside
  // _buildOpts.
  // ---------------------------------------------------------------------
  const PLOT_STYLE_KEY = 'conduit.plotStyle';
  let plotStyle = 'continuous';
  try {
    const saved = localStorage.getItem(PLOT_STYLE_KEY);
    if (saved === 'continuous' || saved === 'discrete') plotStyle = saved;
  } catch (_) {}
  function seriesPathsForStyle() {
    if (plotStyle !== 'discrete') return undefined;             // default linear
    if (!window.uPlot || !window.uPlot.paths || !window.uPlot.paths.stepped) return undefined;
    return window.uPlot.paths.stepped({ align: 1 });            // step-after
  }

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
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
    return (n / (1024 * 1024)).toFixed(2) + 'MB';
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
    const ds = window.Conduit && window.Conduit.dataStore;
    if (!ds) { centralStatsEl.textContent = ''; return; }
    const s = ds.stats();
    if (s.channels === 0 || s.samples === 0) {
      centralStatsEl.textContent = '';
      return;
    }
    const span = (s.sessionStartWallMs != null && s.sessionEndWallMs != null)
      ? (s.sessionEndWallMs - s.sessionStartWallMs) / 1000 : 0;
    // Separators sit in their own spans so each segment can be hidden
    // along with the sep that immediately follows it (`.stat-X +
    // .stat-sep` rule in style.css). That way dropping the leftmost
    // segment doesn't leave a dangling " · " at the start.
    // Drop priority on narrow panes: points first, channels, bytes,
    // time last (see container queries in style.css `.telemetry-pane`).
    // Number and unit are joined with no space — the stats element
    // overrides the pane-header's letter-spacing so the units don't
    // float away from their numbers; the wider gap between segments
    // is provided by the `.stat-sep` margin in style.css instead.
    centralStatsEl.innerHTML =
      `<span class="stat-points">${s.samples.toLocaleString()}PTS</span>` +
      `<span class="stat-sep">·</span>` +
      `<span class="stat-channels">${s.channels}CH</span>` +
      `<span class="stat-sep">·</span>` +
      `<span class="stat-bytes">${fmtBytes(s.approxBytes)}</span>` +
      `<span class="stat-sep">·</span>` +
      `<span class="stat-time">${fmtDuration(span)}</span>`;
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

      // Channels the user has explicitly opted out of from the channel
      // picker. Different from seriesShow: a channel in this set is
      // dropped at push() time so its data never reaches the plot,
      // while seriesShow only hides a series visually inside uPlot.
      // Persisted so an exclusion survives reload.
      this.excludedChannels = new Set(
        Array.isArray(opts.excludedChannels) ? opts.excludedChannels : []);

      // Channel metadata (NOT samples). dataStore owns the bytes.
      // name → { color, n, dtype }.
      this.knownChannels = new Map();

      // Per-plot "clear" cutoff — only this plot hides earlier samples;
      // dataStore is unaffected (so other plots and the HDF5 export keep
      // seeing the full session). null = no cutoff.
      this.clearedSinceMs = null;

      // Pause state. When paused:
      //   - pauseAtMs is the dataStore wallMs at which we froze the
      //     view; _buildRenderData uses it as the slice's right edge so
      //     post-pause samples don't extend the trace.
      //   - frozenMin / frozenMax are the x-scale (in seconds) at pause
      //     time; _applyXScale uses them instead of live lastT, and the
      //     drag-zoom handler updates them so zoom while paused
      //     navigates within the frozen data instead of snapping the
      //     scale to live "now" (where there's no data yet).
      this.pauseAtMs  = null;
      this.frozenMin  = null;
      this.frozenMax  = null;
      // Explicit Y-axis range. When both are set, _applyScales pins the
      // y scale to them (set by drag-zoom-Y or shift-wheel-Y). When
      // null, _applyScales recomputes from the visible series' min/max
      // each render — same as uPlot's auto, but we drive it explicitly
      // so the auto-range button can reliably reset back to "fit data".
      this.frozenYMin = null;
      this.frozenYMax = null;

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
      // Picker exclusion only stops routing this record into THIS plot.
      // Recording continues independently: telemetry.js calls
      // dataStore.append() BEFORE chart.push(), so excluded channels
      // are still captured in the in-memory store and end up in the
      // HDF5 export. The same exclusion applied across every plot
      // would still leave the channel fully recorded.
      if (this.excludedChannels.has(rec.name)) return;
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
      const ds = window.Conduit && window.Conduit.dataStore;
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
      // Clear picker exclusions too — they reference channel names from
      // the previous firmware and may no longer exist. Carrying them
      // over leaves stale entries in the picker menu (e.g. CONST_1
      // sticks around after the user removes its transmit() call and
      // re-flashes). User can re-exclude in the new firmware if needed.
      this.excludedChannels.clear();
      this.clearedSinceMs = null;
      this.userZoomed = false;
      this.frozenMin  = null; this.frozenMax  = null;
      this.frozenYMin = null; this.frozenYMax = null;
      this.pauseAtMs  = null;
      if (this.uplot) { try { this.uplot.destroy(); } catch (_) {} this.uplot = null; }
      if (this.legendRO) { try { this.legendRO.disconnect(); } catch (_) {} }
      const placeholder = document.createElement('div');
      placeholder.className = 'chart-placeholder';
      placeholder.textContent = 'waiting for telemetry…';
      this.mount.innerHTML = '';
      this.mount.appendChild(placeholder);
      // Picker may have been open mid-reset — refresh its rows so it
      // doesn't render rows for now-cleared channels.
      if (this.pickerMenu && !this.pickerMenu.hidden) this._populatePicker();
      emitLayoutChange();
    }

    // No-op: gaps are derived on the read path from wallMs deltas
    // (> GAP_THRESHOLD_S → null inserted between samples). Callers that
    // historically forced a gap don't need to do anything anymore.
    gap() { /* no-op */ }

    destroy() {
      if (this.uplot)    { try { this.uplot.destroy(); }    catch (_) {} this.uplot = null; }
      if (this.ro)       { try { this.ro.disconnect(); }    catch (_) {} this.ro = null; }
      if (this.legendRO) { try { this.legendRO.disconnect(); } catch (_) {} this.legendRO = null; }
      // Picker listeners only attached while open, but remove
      // unconditionally — removeEventListener with the wrong handler is
      // a no-op, and we don't want to leak if the plot is destroyed
      // mid-open.
      if (this._docClickHandler)   document.removeEventListener('click',  this._docClickHandler);
      if (this._docKeydownHandler) document.removeEventListener('keydown', this._docKeydownHandler);
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
        excludedChannels: [...this.excludedChannels],
        seriesShow,
      };
    }

    // ------------------------------------------------------------------
    // DOM
    // ------------------------------------------------------------------

    _buildDom() {
      const icons = window.Conduit && window.Conduit.icons;

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
        ev.dataTransfer.setData('text/conduit-plot', this.id);
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
                             [60000, '60 s'], [300000, '5 min'],
                             [900000, '15 min'], [3600000, '1 h']];
      this._refreshWindowOptions();
      this.windowSel.addEventListener('change', () => {
        this.windowS = Math.min(MAX_WINDOW_S,
                                (Number(this.windowSel.value) || 10000) / 1000);
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
        if (this.paused) {
          // Freeze: capture both the data cutoff (so the slice stops
          // accumulating new samples) and the current scale (so future
          // zooms know where we were when frozen).
          const ds = window.Conduit && window.Conduit.dataStore;
          this.pauseAtMs = (ds && ds.sessionEndWallMs != null)
                           ? ds.sessionEndWallMs : Date.now();
          if (this.uplot) {
            this.frozenMin = this.uplot.scales.x.min;
            this.frozenMax = this.uplot.scales.x.max;
          }
        } else {
          this.pauseAtMs = null;
          this.frozenMin = null;
          this.frozenMax = null;
          this._syncToUplot();
        }
      });

      this.clearBtn = document.createElement('button');
      this.clearBtn.type = 'button';
      this.clearBtn.className = 'btn-ghost btn-mini btn-icon';
      this.clearBtn.title = 'Clear this plot (data store + other plots unaffected)';
      this.clearBtn.setAttribute('aria-label', 'Clear this plot');
      if (icons) icons.set(this.clearBtn, 'delete', { size: 14 });
      this.clearBtn.addEventListener('click', () => this.clear());

      this.autoRangeBtn = document.createElement('button');
      this.autoRangeBtn.type = 'button';
      this.autoRangeBtn.className = 'btn-ghost btn-mini btn-icon';
      this.autoRangeBtn.title = 'Auto-range: reset x to 10 s, y to fit visible series';
      this.autoRangeBtn.setAttribute('aria-label', 'Auto-range');
      if (icons) icons.set(this.autoRangeBtn, 'crop_free', { size: 14 });
      this.autoRangeBtn.addEventListener('click', () => this._autoRange());

      // Channel picker — toggleable popover with a checkbox per series.
      // Useful when the channel set has grown big enough that uPlot's
      // legend wraps onto multiple rows and starts squeezing the canvas
      // (the dynamic-size code in _sizeUplot keeps the canvas from
      // overflowing, but the user still wants explicit visibility
      // control without click-fishing on tiny legend entries).
      this.pickerBtn = document.createElement('button');
      this.pickerBtn.type = 'button';
      this.pickerBtn.className = 'btn-ghost btn-mini btn-icon plot-picker-btn';
      this.pickerBtn.title = 'Show / hide channels';
      this.pickerBtn.setAttribute('aria-label', 'Show / hide channels');
      this.pickerBtn.setAttribute('aria-haspopup', 'true');
      this.pickerBtn.setAttribute('aria-expanded', 'false');
      if (icons) icons.set(this.pickerBtn, 'filter_list', { size: 14 });
      this.pickerBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._togglePicker();
      });

      this.pickerMenu = document.createElement('div');
      this.pickerMenu.className = 'plot-channel-menu';
      this.pickerMenu.hidden = true;
      this.pickerMenu.addEventListener('click', (ev) => ev.stopPropagation());

      // Document-level click handler used to close the picker on
      // outside-click. Bound here so destroy() can remove it cleanly.
      this._docClickHandler = (ev) => {
        if (this.pickerMenu.hidden) return;
        if (this.pickerMenu.contains(ev.target) || this.pickerBtn.contains(ev.target)) return;
        this._closePicker();
      };
      this._docKeydownHandler = (ev) => {
        if (ev.key === 'Escape' && !this.pickerMenu.hidden) this._closePicker();
      };

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
      this.header.appendChild(this.autoRangeBtn);
      this.header.appendChild(this.pickerBtn);
      this.header.appendChild(this.deleteBtn);
      this.header.appendChild(this.pickerMenu);

      this.mount = document.createElement('div');
      this.mount.className = 'chart-wrap';
      const placeholder = document.createElement('div');
      placeholder.className = 'chart-placeholder';
      placeholder.textContent = 'waiting for telemetry…';
      this.mount.appendChild(placeholder);

      this.root.appendChild(this.header);
      this.root.appendChild(this.mount);
      this.parent.appendChild(this.root);

      // Both the chart-wrap and the legend can change height
      // independently — chart-wrap when the user resizes the pane / adds
      // or removes plots, the legend when channels (de)register or wrap
      // onto another row. Either change has to feed the same setSize
      // call so the canvas stays inside the chart-wrap. Two observers
      // share `_sizeUplot` for that.
      this.ro = new ResizeObserver(() => this._sizeUplot());
      this.ro.observe(this.mount);
      // legendRO is (re)attached inside _rebuildUplot once the .u-legend
      // element exists. Declared here so destroy() can disconnect it.
      this.legendRO = null;

      // Double-click resets the visible window to MAX_WINDOW_S — the
      // single discoverable affordance for "show me everything I've
      // recorded" after a series of zoom-ins. In paused mode this also
      // clears the frozen-view bounds so the next render shows the
      // widest allowed range of the snapshot.
      this.mount.addEventListener('dblclick', () => {
        this.windowS = MAX_WINDOW_S;
        if (this.paused) {
          // Anchor the unzoomed view at pauseAtMs so we stay frozen but
          // see a wider range of the snapshot.
          const right = (this.pauseAtMs != null ? this.pauseAtMs : Date.now()) / 1000;
          this.frozenMax = right;
          this.frozenMin = right - this.windowS;
        }
        this._refreshWindowOptions();
        this._renderNow();
        emitLayoutChange();
      });

      // Mouse-wheel zoom — works in both live and paused modes.
      //   scroll up           → zoom in  (smaller window)
      //   scroll down         → zoom out (larger window)
      //   shift + scroll      → zoom Y instead of X
      // Both axes keep the data point under the cursor stationary so
      // the user can scroll through detail at a specific event without
      // losing it. The auto-range button (top-right of the header)
      // resets back to "10 s window, y fits visible series".
      this.mount.addEventListener('wheel', (ev) => {
        if (!this.uplot) return;
        ev.preventDefault();
        const factor = (ev.deltaY > 0) ? 1.25 : 0.8;
        const rect = this.uplot.over.getBoundingClientRect();
        if (ev.shiftKey) {
          // ---- Y zoom (shift held) -----------------------------------
          // Anchor at cursor's data y value so zooming into a specific
          // peak/trough doesn't drift it off-screen. Always sets an
          // explicit frozen Y range — auto-range button resets.
          const py = ev.clientY - rect.top;
          const cursorY = this.uplot.posToVal(py, 'y');
          const yMin = this.uplot.scales.y.min;
          const yMax = this.uplot.scales.y.max;
          if (yMin == null || yMax == null) return;
          let newYMin = cursorY - (cursorY - yMin) * factor;
          let newYMax = cursorY + (yMax - cursorY) * factor;
          if (newYMax - newYMin < 1e-9) {
            const c = (newYMin + newYMax) / 2;
            newYMin = c - 5e-10; newYMax = c + 5e-10;
          }
          this.frozenYMin = newYMin;
          this.frozenYMax = newYMax;
        } else {
          // ---- X zoom -------------------------------------------------
          if (this.paused && this.frozenMin != null && this.frozenMax != null) {
            const px = ev.clientX - rect.left;
            const cursorVal = this.uplot.posToVal(px, 'x');
            const oldMin = this.frozenMin, oldMax = this.frozenMax;
            let newMin = cursorVal - (cursorVal - oldMin) * factor;
            let newMax = cursorVal + (oldMax - cursorVal) * factor;
            if (newMax - newMin < 0.001) {
              const c = (newMin + newMax) / 2;
              newMin = c - 0.0005; newMax = c + 0.0005;
            }
            // Cap zoom-out at MAX_WINDOW_S, keeping the cursor anchor.
            if (newMax - newMin > MAX_WINDOW_S) {
              const half = MAX_WINDOW_S / 2;
              newMin = cursorVal - half;
              newMax = cursorVal + half;
            }
            this.frozenMin = newMin;
            this.frozenMax = newMax;
            this.windowS  = newMax - newMin;
          } else {
            this.windowS = Math.max(0.1, Math.min(MAX_WINDOW_S, this.windowS * factor));
          }
        }
        this._refreshWindowOptions();
        this._renderNow();
        emitLayoutChange();
      }, { passive: false });
    }

    // Auto-range — single user-facing reset:
    //   - x window goes back to the default 10 s preset
    //   - y range recomputed from the currently-visible series (legend
    //     toggles are honored by _computeAutoYRange)
    //   - if paused, the x range stays anchored at pauseAtMs so the
    //     user keeps inspecting the same snapshot, just at the default
    //     zoom; if live, the right edge re-tracks "now"
    _autoRange() {
      this.windowS = 10;
      this.frozenYMin = null;
      this.frozenYMax = null;
      if (this.paused) {
        const right = (this.pauseAtMs != null ? this.pauseAtMs : Date.now()) / 1000;
        this.frozenMax = right;
        this.frozenMin = right - this.windowS;
      } else {
        this.frozenMin = null;
        this.frozenMax = null;
      }
      this._refreshWindowOptions();
      this._renderNow();
      emitLayoutChange();
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
      // `paths` is undefined for the default linear renderer
      // (continuous mode) and a step-after path generator for
      // discrete mode. The Settings UI flips this via
      // Conduit.chart.setStyle(); existing charts schedule a rebuild
      // and pick up the new value here on next _buildOpts call.
      const seriesArr = [{ label: 'time', value: (u, t) => fmtClockMs(t) }];
      const seriesPaths = seriesPathsForStyle();
      let colorIdx = 0;
      for (const [name, meta] of this.knownChannels) {
        if (meta.n === 1) {
          seriesArr.push({
            label: name, stroke: meta.color, width: 1.25,
            // spanGaps:true bridges union-merge null cells (timestamps
            // owned by sibling streams) with linear interpolation, so
            // every series renders as a continuous line through its
            // own real samples — not stepped horizontals. See
            // mergeTimelines() comment.
            spanGaps: true, points: { show: false },
            paths: seriesPaths,
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
              spanGaps: true, points: { show: false },
              paths: seriesPaths,
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
        const ds = window.Conduit && window.Conduit.dataStore;
        return (ds && ds.sessionEndWallMs != null) ? ds.sessionEndWallMs / 1000 : 0;
      };

      return {
        width: w, height: h,
        pxAlign: 1,
        cursor: {
          // 2D drag — width controls X zoom (with the live-anchoring
          // semantics described in the setSelect handler), height
          // controls Y. setScale:false keeps uPlot from auto-zooming;
          // we apply scales explicitly via setSelect.
          drag:  { x: true, y: true, setScale: false },
          focus: { prox: 16 },
        },
        hooks: {
          setSelect: [(u) => {
            const sel = u.select;
            if (!sel) return;
            const hadX = sel.width  > 0;
            const hadY = sel.height > 0;
            if (!hadX && !hadY) return;
            // Capture the selection BEFORE clearing — otherwise
            // setSelect({...},false) would zero out our reads.
            let xa, xb, ya, yb;
            if (hadX) {
              xa = u.posToVal(sel.left, 'x');
              xb = u.posToVal(sel.left + sel.width, 'x');
            }
            if (hadY) {
              // Pixel y grows downward but the data y grows upward —
              // top-of-rect = max value, bottom = min.
              yb = u.posToVal(sel.top, 'y');
              ya = u.posToVal(sel.top + sel.height, 'y');
            }
            // Clear the visible selection rectangle so it doesn't
            // paint a stale box on the next redraw.
            u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);

            if (hadX) {
              this.windowS = Math.max(0.1, Math.min(MAX_WINDOW_S, xb - xa));
              if (this.paused) {
                // Paused → respect the SELECTED RANGE (xa..xb), not
                // just its width. The frozen view shifts to whatever
                // sub-region the user dragged over, letting them
                // inspect arbitrary parts of the snapshot. Clamp the
                // range width to MAX_WINDOW_S, keeping the selection
                // centered so the user's anchor stays visible.
                if (xb - xa > MAX_WINDOW_S) {
                  const center = (xa + xb) / 2;
                  xa = center - MAX_WINDOW_S / 2;
                  xb = center + MAX_WINDOW_S / 2;
                }
                this.frozenMin = xa;
                this.frozenMax = xb;
              }
            }
            if (hadY) {
              // Y zoom always pins to the explicit range — there's
              // no "live tracking" concern for Y.
              this.frozenYMin = ya;
              this.frozenYMax = yb;
            }
            this._refreshWindowOptions();
            // Force a one-shot render even if paused — re-decimating
            // for the new (smaller) range gives the user finer
            // resolution as they zoom in. Bypass the throttle.
            this._renderNow();
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
            // Autosize to the widest tick label so big magnitudes
            // (e.g. "1234567") don't overflow the y-axis gutter and
            // get clipped by .chart-wrap's overflow:hidden. uPlot
            // calls this with the about-to-render formatted values;
            // measure them via the live canvas context so the result
            // matches the actual rendered glyphs (font, kerning, etc).
            // Floor of 50 keeps tiny ranges from collapsing the gutter.
            size: (u, values) => {
              if (!values || values.length === 0) return 50;
              const ctx = u.ctx;
              ctx.save();
              // Must match the .uplot CSS font (style.css) — uPlot
              // renders tick labels with that font, so measuring with
              // a different one mis-sizes the y-axis gutter.
              ctx.font = '12px "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
              let max = 0;
              for (const v of values) {
                const w = ctx.measureText(String(v)).width;
                if (w > max) max = w;
              }
              ctx.restore();
              // +18 = ~6 px tick mark + ~12 px breathing room
              return Math.max(50, Math.ceil(max) + 18);
            },
          },
        ],
        series: seriesArr,
      };
    }

    _rebuildUplot() {
      if (!this.mount || !window.uPlot) return;
      // Tear down whatever was here, unconditionally. We used to early-
      // return when knownChannels was empty, but that left a stale
      // uPlot still rendering the previous trace — visible when the
      // user deselected the only-remaining channel via the picker (the
      // canvas kept showing the now-removed series until the next
      // channel registered). Destroying first means any zero-channel
      // state immediately lands on the "waiting for telemetry…"
      // placeholder.
      if (this.uplot)    { try { this.uplot.destroy(); }    catch (_) {} this.uplot = null; }
      if (this.legendRO) { try { this.legendRO.disconnect(); } catch (_) {} }
      this.mount.innerHTML = '';

      if (this.knownChannels.size === 0) {
        // No series to draw — show the placeholder. Picker may still
        // list excluded channels for re-enabling; the placeholder is
        // the right empty-state for the canvas itself.
        const placeholder = document.createElement('div');
        placeholder.className = 'chart-placeholder';
        placeholder.textContent = 'waiting for telemetry…';
        this.mount.appendChild(placeholder);
        if (this.pickerMenu && !this.pickerMenu.hidden) this._populatePicker();
        return;
      }

      const data = this._buildRenderData();
      this.uplot = new uPlot(this._buildOpts(data), data, this.mount);
      this._applyXScale();
      this._observeLegend();
      // Series set may have changed — refresh the picker if it was open
      // when the rebuild fired (e.g. a new channel registered).
      if (this.pickerMenu && !this.pickerMenu.hidden) this._populatePicker();
    }

    // Re-(attach) the legend observer to the .u-legend element that
    // uPlot created in this.mount. Sized once synchronously so the
    // canvas drops to the legend's actual height immediately, then on
    // every legend size change after that.
    _observeLegend() {
      const legend = this.mount && this.mount.querySelector('.u-legend');
      if (!legend) return;
      this._sizeUplot();
      if (!this.legendRO) {
        this.legendRO = new ResizeObserver(() => this._sizeUplot());
      }
      this.legendRO.observe(legend);
    }

    // Single source of truth for canvas height. Reads the legend's
    // actual rendered height (uPlot's `height` arg only sizes the
    // canvas + axes — it doesn't subtract the legend, so the legend's
    // row count directly eats into chart-wrap if we don't compensate).
    _sizeUplot() {
      if (!this.uplot || !this.mount) return;
      // When the parent view is display:none (e.g. user popped over to
      // Hardware Manager), clientWidth collapses to 0. Skip the resize
      // — uPlot keeps its last good size, and ResizeObserver will fire
      // again automatically when the view becomes visible again.
      const w = this.mount.clientWidth;
      if (w === 0) return;
      const legend = this.mount.querySelector('.u-legend');
      const legendH = legend ? Math.ceil(legend.getBoundingClientRect().height) : CHROME_H;
      const h = Math.max(60, this.mount.clientHeight - legendH);
      this.uplot.setSize({ width: w, height: h });
    }

    // ---- Channel picker --------------------------------------------------

    _togglePicker() {
      if (this.pickerMenu.hidden) this._openPicker();
      else this._closePicker();
    }

    _openPicker() {
      this._populatePicker();
      this.pickerMenu.hidden = false;
      this.pickerBtn.setAttribute('aria-expanded', 'true');
      // Defer the listener-add by one tick so the click that opened the
      // picker doesn't itself fire the outside-click handler.
      setTimeout(() => {
        document.addEventListener('click', this._docClickHandler);
        document.addEventListener('keydown', this._docKeydownHandler);
      }, 0);
    }

    _closePicker() {
      this.pickerMenu.hidden = true;
      this.pickerBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', this._docClickHandler);
      document.removeEventListener('keydown', this._docKeydownHandler);
    }

    // Channel names the picker should list — the union of currently
    // registered channels and ones the user has excluded (so excluded
    // entries stay visible in the menu, ready to be re-enabled).
    _pickerChannels() {
      const out = new Set();
      for (const name of this.knownChannels.keys()) out.add(name);
      for (const name of this.excludedChannels) out.add(name);
      return [...out].sort();
    }

    // Flip a single channel's enabled state. Disabling drops it from
    // knownChannels and rebuilds (the series + its data disappear).
    // Enabling tries to re-register immediately from dataStore meta so
    // the channel reappears without waiting for the next telemetry
    // record; if dataStore has no record of it, push() will register
    // on next arrival.
    _setChannelEnabled(name, enabled) {
      if (enabled) {
        this.excludedChannels.delete(name);
        if (!this.knownChannels.has(name)) {
          const ds = window.Conduit && window.Conduit.dataStore;
          const meta = ds && ds.listChannels
            ? ds.listChannels().find((c) => c.name === name) : null;
          if (meta) {
            this.knownChannels.set(name, {
              n: meta.n, dtype: meta.dtype,
              color: colorFor(this.knownChannels.size),
            });
            this._scheduleRebuild();
          }
        }
      } else {
        this.excludedChannels.add(name);
        if (this.knownChannels.has(name)) {
          this.knownChannels.delete(name);
          this._scheduleRebuild();
        }
      }
    }

    _setAllChannelsEnabled(enabled) {
      for (const name of this._pickerChannels()) {
        this._setChannelEnabled(name, enabled);
      }
    }

    _populatePicker() {
      const channels = this._pickerChannels();
      this.pickerMenu.innerHTML = '';

      if (channels.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'plot-channel-menu__empty';
        empty.textContent = 'no channels yet';
        this.pickerMenu.appendChild(empty);
        return;
      }

      const enabled  = channels.map((n) => !this.excludedChannels.has(n));
      const allShown  = enabled.every(Boolean);
      const noneShown = enabled.every((v) => !v);

      // "Select all" / "Deselect all" — indeterminate when mixed.
      const allRow = document.createElement('label');
      allRow.className = 'plot-channel-menu__row plot-channel-menu__all';
      const allCb = document.createElement('input');
      allCb.type = 'checkbox';
      allCb.checked = allShown;
      allCb.indeterminate = !allShown && !noneShown;
      allCb.addEventListener('change', () => {
        this._setAllChannelsEnabled(!allShown);
        this._populatePicker();
        emitLayoutChange();
      });
      const allText = document.createElement('span');
      allText.className = 'plot-channel-menu__label';
      allText.textContent = allShown ? 'Deselect all' : 'Select all';
      allRow.appendChild(allCb);
      allRow.appendChild(allText);
      this.pickerMenu.appendChild(allRow);

      const sep = document.createElement('div');
      sep.className = 'plot-channel-menu__sep';
      this.pickerMenu.appendChild(sep);

      // Per-channel list. Color marker reads knownChannels.color when
      // the channel is currently registered, else falls back to a
      // muted swatch — excluded channels still need a visual marker.
      const list = document.createElement('div');
      list.className = 'plot-channel-menu__list';
      for (let i = 0; i < channels.length; i++) {
        const name = channels[i];
        const row = document.createElement('label');
        row.className = 'plot-channel-menu__row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = enabled[i];
        cb.addEventListener('change', () => {
          this._setChannelEnabled(name, cb.checked);
          this._populatePicker();
          emitLayoutChange();
        });
        const marker = document.createElement('span');
        marker.className = 'plot-channel-menu__marker';
        const meta = this.knownChannels.get(name);
        marker.style.background = meta ? meta.color : 'var(--text3, #6e7681)';
        if (!enabled[i]) marker.style.opacity = '0.4';
        const text = document.createElement('span');
        text.className = 'plot-channel-menu__label';
        text.textContent = name;
        row.appendChild(cb);
        row.appendChild(marker);
        row.appendChild(text);
        list.appendChild(row);
      }
      this.pickerMenu.appendChild(list);
    }

    _applyXScale() {
      if (!this.uplot) return;
      // ---- X scale -----------------------------------------------------
      // Paused with an explicit frozen view → use it. This is the case
      // after the user drag-zoomed inside a paused snapshot; we want
      // the scale to land on the actual data they selected, NOT live
      // "now" (where there's no data because the slice cutoff is at
      // pauseAtMs). Without this branch, zoom-while-paused snapped to
      // an empty x-window and the chart looked blank.
      if (this.paused && this.frozenMin != null && this.frozenMax != null) {
        this.uplot.setScale('x', { min: this.frozenMin, max: this.frozenMax });
      } else if (!this.userZoomed) {
        const ds = window.Conduit && window.Conduit.dataStore;
        const lastTms = ds && ds.sessionEndWallMs;
        if (lastTms != null) {
          const max = lastTms / 1000;
          this.uplot.setScale('x', { min: max - this.windowS, max });
        }
      }
      // ---- Y scale -----------------------------------------------------
      // Explicit frozen Y from drag-zoom-Y or shift-wheel → use it.
      // Otherwise compute from currently-visible series so legend
      // toggles take effect immediately (uPlot's built-in auto picks
      // up `series[i].show` but won't recompute on a stale dataset
      // without a setData call; doing it ourselves here is reliable).
      if (this.frozenYMin != null && this.frozenYMax != null) {
        this.uplot.setScale('y', { min: this.frozenYMin, max: this.frozenYMax });
      } else {
        const r = this._computeAutoYRange();
        if (r) this.uplot.setScale('y', r);
      }
    }

    _computeAutoYRange() {
      if (!this.uplot) return null;
      let yMin = Infinity, yMax = -Infinity;
      const data = this.uplot.data;
      const series = this.uplot.series;
      for (let s = 1; s < series.length; s++) {
        if (series[s].show === false) continue;
        const arr = data[s];
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i];
          if (v == null || !Number.isFinite(v)) continue;
          if (v < yMin) yMin = v;
          if (v > yMax) yMax = v;
        }
      }
      if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
      if (yMin === yMax) {
        // Avoid a zero-height plot when all visible samples are equal.
        const half = Math.max(Math.abs(yMin) * 0.05, 0.5);
        return { min: yMin - half, max: yMax + half };
      }
      const pad = (yMax - yMin) * 0.05;
      return { min: yMin - pad, max: yMax + pad };
    }

    _syncToUplot() {
      // Keep the central readout in sync with whatever just landed.
      scheduleCentralStats();
      if (!this.uplot) return;
      // Paused → freeze new-data ingest. Zoom + pause/resume use
      // _renderNow() to force a one-shot redraw without going through
      // this throttled live-update path.
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

    // Coalesced user-initiated redraw. Bypasses the paused gate (so
    // zoom/pan still re-paint a frozen snapshot) and bypasses the 30 fps
    // live-data throttle (so the user gets immediate feedback). But
    // batched via rAF: rapid wheel/drag streams (Firefox emits 60+
    // wheel events/sec on smooth scrolling) collapse into one paint
    // per frame. Without this coalescing each event ran a full
    // setData → buildRenderData → mergeTimelines → decimate cycle
    // synchronously, blocking the main thread long enough that the
    // WebSocket's STALL_MS (5 s) tripped and tore down the connection.
    _renderNow() {
      if (this.renderNowPending) return;
      this.renderNowPending = true;
      requestAnimationFrame(() => {
        this.renderNowPending = false;
        if (!this.uplot) return;
        const expectedSeriesCount = 1 + this._seriesLabels().length;
        if (this.uplot.series.length !== expectedSeriesCount) return;
        this.lastSetDataMs = performance.now();
        this.uplot.setData(this._buildRenderData(), false);
        this._applyXScale();
      });
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
      const ds = window.Conduit && window.Conduit.dataStore;
      const t0 = performance.now();
      // Wrap the actual builder so we can time it without leaking the
      // measurement into every early-return path below.
      const out = this._buildRenderDataInner(ds);
      const dt = performance.now() - t0;
      // 16 ms = one 60 fps frame budget. Anything past that means the
      // chart is the main-thread offender that's blocking the WS RX
      // queue (plan cause #2). Rate-limit the warning to once per
      // second per chart so a sustained slow window doesn't flood.
      if (dt > 16) {
        const now = performance.now();
        if (!this._lastBuildWarnMs || now - this._lastBuildWarnMs > 1000) {
          this._lastBuildWarnMs = now;
          const stats = (ds && ds.stats) ? ds.stats() : null;
          console.warn('[chart]',
            `_buildRenderData ${dt.toFixed(1)}ms, windowS=${this.windowS}, ` +
            `channels=${this.knownChannels.size}` +
            (stats ? `, store=${stats.samples} samples` : ''));
        }
      }
      return out;
    }

    _buildRenderDataInner(ds) {
      if (!ds || this.knownChannels.size === 0) {
        // Empty placeholder — uPlot needs at least one column.
        const labels = this._seriesLabels();
        const out = [[]];
        for (let i = 0; i < labels.length; i++) out.push([]);
        return out;
      }

      // Right edge of the slice. When paused, freeze at pauseAtMs so
      // newer samples don't extend the trace. When live, use the
      // dataStore's current high-water mark.
      const lastTms = (this.paused && this.pauseAtMs != null)
        ? this.pauseAtMs
        : ds.sessionEndWallMs;
      if (lastTms == null) {
        const labels = this._seriesLabels();
        const out = [[]];
        for (let i = 0; i < labels.length; i++) out.push([]);
        return out;
      }

      // Slice window. When paused with a frozen view (post drag-zoom),
      // honor the explicit min/max so we slice only the user-selected
      // range — which lets the decimator allocate the bucket budget to
      // the visible region instead of the full pre-zoom window.
      let winMinMs, winMaxMs;
      if (this.paused && this.frozenMin != null && this.frozenMax != null) {
        winMinMs = this.frozenMin * 1000;
        winMaxMs = this.frozenMax * 1000 + 1;
      } else {
        winMinMs = lastTms - this.windowS * 1000;
        winMaxMs = lastTms + 1;
      }
      // Belt-and-suspenders cap: even if windowS slipped past the
      // cap (e.g. via a stale persisted layout that pre-dates
      // MAX_WINDOW_S), the slice is bounded to the rightmost
      // MAX_WINDOW_S * 1000 ms. Keeps the decimator's worst case
      // inside the perf envelope regardless of input shape.
      const maxBackMs = MAX_WINDOW_S * 1000;
      if (winMaxMs - winMinMs > maxBackMs) {
        winMinMs = winMaxMs - maxBackMs;
      }
      if (this.clearedSinceMs != null && this.clearedSinceMs > winMinMs) {
        winMinMs = this.clearedSinceMs;
      }

      // Slice each registered channel. Vector channels expand to one
      // entry per component. For the common single-channel-per-plot case
      // (where every entry shares the same wallMs array — they all came
      // from the same dataStore.slice), we fall through to a fast path
      // that skips the union-merge.
      //
      // PRE-DECIMATION: when a series's raw slice exceeds ~2× pxWidth,
      // we decimate it INDEPENDENTLY here to canvas resolution before
      // any cross-series merging. This is the critical perf win for
      // multi-channel plots over big windows: mergeTimelines is O(total
      // samples across all series), and for two series of 2.5 M samples
      // each the merge alone ran ~50 ms per frame. After pre-decimation
      // each series is ~2 k points, the merge becomes trivial, and the
      // final decimateForCanvas degenerates into its early-return path.
      const pxWidth = (this.mount && this.mount.clientWidth) || 600;
      const decimateThreshold = pxWidth * 2;
      const sliced = []; // [{ wallMs, values }]
      for (const [name, meta] of this.knownChannels) {
        // Scalar channels with a known-large range take the
        // sliceMinMax fast path: dataStore walks chunks once and
        // emits min/max per pixel-bucket WITHOUT concatenating the
        // raw samples. For a 30-min recording at 1 kHz this drops
        // per-frame memory traffic from ~22 MB to ~20 KB and is what
        // stops heavy pan/zoom from stalling the main thread long
        // enough for the WS stall watchdog to fire. Vector channels
        // (n > 1) fall through to the regular slice path because
        // sliceMinMax doesn't handle vectors yet — uncommon for
        // long-running channels in practice.
        if (meta.n === 1 && ds.sliceMinMax) {
          // We don't know slice.count without doing some work, so we
          // just always go through sliceMinMax for scalars. For tiny
          // ranges (range that already fits in 2 × pxWidth points)
          // sliceMinMax short-circuits to the bucketed walk which is
          // already O(range), no worse than the regular slice.
          const dec = ds.sliceMinMax(name, {
            fromWallMs: winMinMs, toWallMs: winMaxMs, bucketCount: pxWidth,
          });
          if (!dec || dec.count === 0) {
            sliced.push({ wallMs: null, values: null });
          } else {
            sliced.push({ wallMs: dec.wallMs, values: dec.values });
          }
          continue;
        }
        const slice = ds.slice(name, { fromWallMs: winMinMs, toWallMs: winMaxMs });
        if (slice.count === 0) {
          for (let k = 0; k < meta.n; k++) sliced.push({ wallMs: null, values: null });
          continue;
        }
        // Vector channels: each per-component series gets its own
        // optional pre-decimation pass.
        if (meta.n === 1) {
          if (slice.count > decimateThreshold) {
            const dec = decimateSeries(slice.wallMs, slice.values, 1, 0, pxWidth);
            sliced.push(dec);
          } else {
            sliced.push({ wallMs: slice.wallMs, values: slice.values });
          }
        } else {
          for (let k = 0; k < meta.n; k++) {
            if (slice.count > decimateThreshold) {
              const dec = decimateSeries(slice.wallMs, slice.values, meta.n, k, pxWidth);
              sliced.push(dec);
            } else {
              // Strided view of the kth component. Float64 destination is
              // safe for any source dtype — uPlot wants Numbers anyway.
              const sub = new Float64Array(slice.count);
              const src = slice.values;
              for (let i = 0; i < slice.count; i++) sub[i] = src[i * meta.n + k];
              sliced.push({ wallMs: slice.wallMs, values: sub });
            }
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

      // Decimate FIRST, in millisecond timestamps. The decimator only
      // touches indices, so passing ms vs sec doesn't change its work.
      // Then convert the small decimated x-output (≈2× canvas width,
      // typically <2000 values) from ms to seconds. Doing it the other
      // way around forces an N-element Float64Array allocation + N
      // divisions every frame — fine for the small steady-state slice,
      // but ruinous for >1 M-point windows where the conversion alone
      // takes 30-50 ms and laggies the wheel scroll. uPlot expects
      // seconds on time scales; we honor that contract at decimator
      // output instead of input.
      //
      // We also don't inject null breakpoints for wallMs gaps here —
      // that tripped up the decimator (every bucket containing a
      // leading-edge sparse-fill null got flagged as a gap, blanking
      // the chart). Real network/OTA gaps are typically followed by a
      // chart.reset() anyway; if we want explicit gap rendering later,
      // wire uPlot's per-series `gaps` callback instead.
      // Post-merge safety-net decimation. After pre-decimation each
      // input series is ≤2× pxWidth, and the merge of k such series is
      // ≤2× pxWidth × k. That's already small enough for uPlot, but
      // running decimateForCanvas again keeps the wire-format identical
      // to the legacy path and handles the corner case where a series
      // wasn't pre-decimated (count below threshold).
      const decimated = decimateForCanvas([xMs, ...yArrays], pxWidth);
      const xDec = decimated[0];
      const xLen = xDec.length;
      const xSec = new Float64Array(xLen);
      for (let i = 0; i < xLen; i++) xSec[i] = xDec[i] / 1000;
      return [xSec, ...decimated.slice(1)];
    }
  }

  // ---------------------------------------------------------------------
  // Helpers — timeline merge, decimation
  // ---------------------------------------------------------------------

  // K-way merge for multiple channels with different sample timelines
  // sharing one plot. Output: unified xMs Float64Array + per-stream y
  // arrays where each cell holds the stream's REAL sample value if it
  // contributed at that timestamp, otherwise null.
  //
  // The series config sets spanGaps: true, so uPlot bridges across
  // those nulls with a linear interpolation — visually each series
  // looks like a continuous line through its own real samples,
  // independent of timestamps owned by other streams. The earlier
  // implementation used zero-order hold (carry-forward) to keep the
  // line continuous, but that produced visible step "platforms" for
  // any series whose samples landed mid-cycle when several channels
  // emit back-to-back: SIN0's timestamp landed first in each cycle so
  // its held span was µs-thin, while SIN1/2/3 had ms-long held spans
  // that rendered as horizontal segments.
  function mergeTimelines(sliced) {
    const k = sliced.length;
    const idx = new Array(k).fill(0);
    const xs = sliced.map((s) => s.wallMs || new Float64Array(0));
    const ys = sliced.map((s) => s.values || []);

    let total = 0;
    for (const arr of xs) total += arr.length;
    const xMs = new Float64Array(total);
    const yArrays = sliced.map(() => new Array(total));
    let w = 0;

    for (;;) {
      // Find the smallest current head across active streams.
      let bestT = Infinity;
      for (let i = 0; i < k; i++) {
        if (idx[i] >= xs[i].length) continue;
        const t = xs[i][idx[i]];
        if (t < bestT) bestT = t;
      }
      if (bestT === Infinity) break;
      xMs[w] = bestT;
      // For each stream: real value if it contributed at this slot,
      // null otherwise. Series spanGaps:true bridges the nulls with
      // linear interpolation at draw time.
      for (let i = 0; i < k; i++) {
        if (idx[i] < xs[i].length && xs[i][idx[i]] === bestT) {
          yArrays[i][w] = ys[i][idx[i]];
          idx[i]++;
        } else {
          yArrays[i][w] = null;
        }
      }
      w++;
    }

    return {
      xMs: w === total ? xMs : xMs.slice(0, w),
      yArrays: yArrays.map((arr) => w === total ? arr : arr.slice(0, w)),
    };
  }

  // Per-series pre-decimation. Operates on (wallMs, valuesView) for ONE
  // series and returns a small {wallMs, values} pair containing only
  // bucket-extreme samples (min + max per bucket). For vector channels
  // the caller passes `stride > 1` and `componentOffset` to strip out
  // the kth component while decimating in-place — no intermediate
  // Float64Array allocation for the full component vector.
  //
  // The output preserves bucket min/max samples in time order, so the
  // polyline still renders the peaks and troughs the user can see at
  // canvas resolution. Compared to running decimateForCanvas on the
  // post-merge union, this scales with O(slice.count) per series
  // instead of O(slice.count × series_count), and produces tiny inputs
  // for the downstream mergeTimelines pass.
  function decimateSeries(wallMs, values, stride, componentOffset, pxWidth) {
    const n = wallMs.length;
    const numBuckets = pxWidth;
    const bucketWidth = n / numBuckets;
    // Max 2 emitted points per bucket (min + max); pre-size with that.
    const xOut = new Float64Array(numBuckets * 2);
    const yOut = new Float64Array(numBuckets * 2);
    let w = 0;
    for (let b = 0; b < numBuckets; b++) {
      const a = Math.floor(b * bucketWidth);
      const z = Math.min(Math.floor((b + 1) * bucketWidth), n);
      let mn = Infinity, mx = -Infinity, iMn = -1, iMx = -1;
      for (let i = a; i < z; i++) {
        // Vector channels are flat-packed [comp0, comp1, ..., compN, comp0, comp1, ...].
        const v = values[i * stride + componentOffset];
        if (v < mn) { mn = v; iMn = i; }
        if (v > mx) { mx = v; iMx = i; }
      }
      if (iMn === -1) continue;     // empty bucket; skip entirely
      if (iMn === iMx) {
        xOut[w] = wallMs[iMn]; yOut[w] = values[iMn * stride + componentOffset]; w++;
      } else if (iMn < iMx) {
        xOut[w] = wallMs[iMn]; yOut[w] = values[iMn * stride + componentOffset]; w++;
        xOut[w] = wallMs[iMx]; yOut[w] = values[iMx * stride + componentOffset]; w++;
      } else {
        xOut[w] = wallMs[iMx]; yOut[w] = values[iMx * stride + componentOffset]; w++;
        xOut[w] = wallMs[iMn]; yOut[w] = values[iMn * stride + componentOffset]; w++;
      }
    }
    return {
      wallMs: xOut.subarray(0, w),
      values: yOut.subarray(0, w),
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
  const LAYOUT_KEY = 'conduit.plots';
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
      const id = ev.dataTransfer && ev.dataTransfer.types.includes('text/conduit-plot');
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
      const srcId = ev.dataTransfer && ev.dataTransfer.getData('text/conduit-plot');
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
  window.Conduit = window.Conduit || {};
  window.Conduit.chart = {
    push:  (rec) => {
      // Refresh the central recording-volume readout BEFORE per-chart
      // routing. Recording lives in dataStore (telemetry.js calls
      // dataStore.append() before chart.push()), so the PTS/CH/BYTES/
      // TIME header has to keep ticking even when every chart's picker
      // has excluded the incoming channel — otherwise the user reads
      // a frozen header as "recording stopped" when in fact the
      // dataStore is still growing in the background.
      scheduleCentralStats();
      for (const c of charts) c.push(rec);
    },
    clear: ()    => { for (const c of charts) c.clear(); },
    reset: ()    => { for (const c of charts) c.reset(); },
    gap:   ()    => { /* no-op — see Chart.gap() */ },
    // Global plot line style. Persisted to localStorage; charts pick
    // up the new value on the next _rebuildUplot via _buildOpts.
    getStyle: () => plotStyle,
    setStyle: (style) => {
      if (style !== 'continuous' && style !== 'discrete') return;
      if (plotStyle === style) return;
      plotStyle = style;
      try { localStorage.setItem(PLOT_STYLE_KEY, style); } catch (_) {}
      for (const c of charts) c._scheduleRebuild();
    },
  };
  window.Conduit.charts = {
    list:    () => charts.slice(),
    add:     addChart,
    remove:  removeChartById,
    persist: saveLayout,
  };

  // Diagnostic: dump every chart's view config (no buffers anymore).
  window.CONDUIT_TLM_DUMP = () => charts.map((c) => ({
    id: c.id, title: c.title, windowS: c.windowS,
    paused: c.paused, userZoomed: c.userZoomed,
    clearedSinceMs: c.clearedSinceMs,
    knownChannels: [...c.knownChannels.keys()],
  }));
})();
