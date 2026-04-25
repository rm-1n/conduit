// chart.js — minimal multi-series scope renderer for the telemetry pane.
//
// Pull model: telemetry.js calls window.PicoPoE.chart.push(record) for each
// decoded record. We keep a bounded ring per series and redraw on
// requestAnimationFrame. No external dependencies.
//
// Series key: `${name}` for scalar messages, `${name}[k]` for vectors.

(function () {
  'use strict';

  const DEFAULT_WINDOW_MS = 30_000;
  const MAX_POINTS_PER_SERIES = 4096;   // ~30 s × 100 Hz with headroom

  let canvas = null;
  let ctx = null;
  let pauseBtn = null;
  let clearBtn = null;
  let windowSel = null;
  let infoEl = null;

  let paused = false;
  let windowMs = DEFAULT_WINDOW_MS;
  let series = new Map();   // key → { color, points: {t, v}[] }
  let drawScheduled = false;
  let lastWallMs = 0;       // most recent record wall_ms — drives the X axis

  // Distinct-ish hue palette. Cycles past 12 — fine for the 32-channel cap.
  const PALETTE = [
    '#58a6ff', '#3fb950', '#ff7b72', '#d29922',
    '#a371f7', '#79c0ff', '#56d4dd', '#f0883e',
    '#ffa657', '#7ee787', '#f778ba', '#bc8cff',
  ];

  function colorFor(idx) { return PALETTE[idx % PALETTE.length]; }

  function ensureSeries(key) {
    let s = series.get(key);
    if (!s) {
      s = { color: colorFor(series.size), points: [] };
      series.set(key, s);
    }
    return s;
  }

  function pushPoint(key, t, v) {
    const s = ensureSeries(key);
    s.points.push({ t, v });
    if (s.points.length > MAX_POINTS_PER_SERIES) {
      s.points.splice(0, s.points.length - MAX_POINTS_PER_SERIES);
    }
  }

  function scheduleDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => {
      drawScheduled = false;
      draw();
    });
  }

  // Find min/max Y across the current window of points.
  function visibleRange(now) {
    let lo = Infinity, hi = -Infinity, count = 0;
    const tMin = now - windowMs;
    for (const s of series.values()) {
      for (let k = s.points.length - 1; k >= 0; k--) {
        const p = s.points[k];
        if (p.t < tMin) break;
        if (p.v < lo) lo = p.v;
        if (p.v > hi) hi = p.v;
        count++;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = -1; hi = 1;
    }
    if (lo === hi) { lo -= 0.5; hi += 0.5; }
    // 5% padding
    const pad = (hi - lo) * 0.05;
    return { lo: lo - pad, hi: hi + pad, count };
  }

  function fmtTick(v) {
    const a = Math.abs(v);
    if (a >= 1000 || (a > 0 && a < 0.01)) return v.toExponential(2);
    return v.toFixed(a < 1 ? 3 : a < 10 ? 2 : 1);
  }

  function draw() {
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== Math.round(cssW * dpr)
        || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear.
    ctx.fillStyle = getCssVar('--card', '#0d1117');
    ctx.fillRect(0, 0, cssW, cssH);

    const padL = 56, padR = 8, padT = 8, padB = 22;
    const w = cssW - padL - padR;
    const h = cssH - padT - padB;
    if (w <= 0 || h <= 0) return;

    const now = lastWallMs > 0 ? lastWallMs : Date.now();
    const tMin = now - windowMs;
    const { lo, hi, count } = visibleRange(now);

    // Grid.
    ctx.strokeStyle = getCssVar('--border', '#30363d');
    ctx.lineWidth = 1;
    ctx.fillStyle = getCssVar('--text-dim', '#8b949e');
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const y = padT + (h * i) / yTicks;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + w, y);
      ctx.stroke();
      const v = hi - ((hi - lo) * i) / yTicks;
      ctx.fillText(fmtTick(v), padL - 4, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = 6;
    for (let i = 0; i <= xTicks; i++) {
      const x = padL + (w * i) / xTicks;
      const tMs = tMin + ((now - tMin) * i) / xTicks;
      const dt = (now - tMs) / 1000;
      ctx.fillText(`-${dt.toFixed(1)}s`, x, padT + h + 4);
    }

    // Series lines.
    const xScale = (t) => padL + ((t - tMin) / (now - tMin || 1)) * w;
    const yScale = (v) => padT + ((hi - v) / (hi - lo || 1)) * h;
    let idx = 0;
    for (const [key, s] of series.entries()) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let k = 0; k < s.points.length; k++) {
        const p = s.points[k];
        if (p.t < tMin) continue;
        const x = xScale(p.t);
        const y = yScale(p.v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      idx++;
    }

    // Legend (top-left of plot area).
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    let lx = padL + 6;
    const ly = padT + 4;
    for (const [key, s] of series.entries()) {
      const label = key;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, ly + 4, 8, 2);
      ctx.fillStyle = getCssVar('--text', '#c9d1d9');
      ctx.fillText(label, lx + 12, ly);
      lx += 12 + tw + 12;
      if (lx > cssW - padR - 100) break;
    }

    if (infoEl) {
      infoEl.textContent = series.size > 0
        ? `${series.size} ch · ${count} pt`
        : 'no data';
    }
  }

  function getCssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) { return fallback; }
  }

  function push(rec) {
    if (paused) return;
    if (!rec || !rec.values) return;
    lastWallMs = rec.wallMs || Date.now();
    if (rec.n === 1) {
      pushPoint(rec.name, rec.wallMs, rec.values[0]);
    } else {
      for (let k = 0; k < rec.n; k++) {
        pushPoint(`${rec.name}[${k}]`, rec.wallMs, rec.values[k]);
      }
    }
    scheduleDraw();
  }

  function clear() {
    series = new Map();
    scheduleDraw();
  }

  function reset() {
    series = new Map();
    lastWallMs = 0;
    scheduleDraw();
  }

  function init() {
    canvas = document.getElementById('ide-chart-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    pauseBtn = document.getElementById('ide-chart-pause');
    clearBtn = document.getElementById('ide-chart-clear');
    windowSel = document.getElementById('ide-chart-window');
    infoEl = document.getElementById('ide-chart-info');

    if (pauseBtn) pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      if (!paused) scheduleDraw();
    });
    if (clearBtn) clearBtn.addEventListener('click', clear);
    if (windowSel) windowSel.addEventListener('change', () => {
      const ms = Number(windowSel.value) || DEFAULT_WINDOW_MS;
      windowMs = ms;
      scheduleDraw();
    });

    window.addEventListener('resize', scheduleDraw);

    // Tick at ~10 Hz so the time axis advances even when no data is
    // arriving (the "now" line moves left).
    setInterval(() => {
      if (!paused) {
        if (lastWallMs > 0) lastWallMs = Math.max(lastWallMs, Date.now());
        scheduleDraw();
      }
    }, 100);

    scheduleDraw();

    window.PicoPoE = window.PicoPoE || {};
    window.PicoPoE.chart = { push, clear, reset };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
