// ide.js — Firmware IDE controller.
// Owns the Monaco editor, the device picker in the topbar, the Build /
// Build-&-Upload buttons, and the build-log panel. The runtime-console
// panel is owned by console.js and pulls the selected IP from our
// <select> on each poll.

(function () {
  'use strict';

  // Default template: Arduino-style setup() + loop() hooks. The firmware
  // provides main(), the network stack, the HTTP server, and the OTA
  // machinery — it exposes these two weak symbols so user code can
  // override them without touching main() or the runtime. Strong user
  // definitions win over the weak defaults in firmware/app/main.c at
  // link time. printf() from either hook is mirrored into the ring
  // buffer that backs /api/log, so it shows up in the runtime console.
  const BLINK_TEMPLATE = `#include "pico/stdlib.h"
#include "hardware/gpio.h"
#include <math.h>
#include "conduit_user.h"   // log(), transmit(), on_command()

#define LED_PIN 25

// Shared state between the loop (core 0) and command callbacks (core 1).
// volatile is enough for single 32-bit values on RP2350; reach for
// stdatomic.h for multi-field state.
static volatile uint32_t blink_period_ticks = 500;
static volatile float    sine_amplitude     = 1.0f;

// Command callback: POST /api/cmd?name=set_blink&value=<ticks>
// Try it: bottom-right "Cmd" row → name=set_blink, args=value=200
//
// Callbacks run on the network stack's TCP-callback context. Keep them
// fast — flip a flag here, do the heavy work in conduit_loop().
//
// Return NULL on success (the framework replies {"ok":true,"value":<v>})
// or a static error string (HTTP 400, {"ok":false,"error":"..."}).
static const char *on_set_blink(int32_t period) {
    if (period < 10 || period > 10000) return "period must be in [10, 10000] ticks";
    blink_period_ticks = (uint32_t)period;
    log("[cmd] blink period -> %d ticks\\n", (int)period);
    return NULL;
}

// Command callback: POST /api/cmd?name=set_amp&value=<float>
// Scales the SIN telemetry channel — you'll see the live chart respond.
static const char *on_set_amp(float value) {
    if (value < 0.0f || value > 5.0f) return "value must be in [0.0, 5.0]";
    sine_amplitude = value;
    log("[cmd] sine amplitude -> %.3f\\n", (double)value);
    return NULL;
}

// Runs once after boot. Wire up your pins + peripherals here, and
// register any custom commands.
void conduit_setup(void) {
    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);

    // Built-in commands (gpio_init/write/read/toggle, adc_read) are
    // always available. Add your own with on_command(name, T, cb) —
    // same shape as transmit(name, T, ptr). T is one of the scalar
    // typedefs (I8, U8, I16, U16, I32, U32, I64, U64, F32, F64) and
    // cb's argument type must match T's element type. The framework
    // parses ?value=<v> into that type, calls cb, and replies with
    // {"ok":true,"value":<v>} (or {"ok":false,"error":"..."}).
    on_command("set_blink", I32, on_set_blink);
    on_command("set_amp",   F32, on_set_amp);

    log("hello from conduit_setup()\\n");
}

// Runs at 1 kHz on core 0. Keep it fast — heavy work starves the network
// stack running on core 1.
//
// log() prints to the runtime console pane.
// transmit() streams numeric data to the live chart pane (and IndexedDB).
// Names are UPPER_SNAKE_CASE and auto-register on first call.
void conduit_loop(void) {
    static uint32_t ticks = 0;
    static bool led_on = false;
    ticks++;

    // Blink: toggle the LED every \`blink_period_ticks\` (≈ms). The
    // period is mutable from the IDE — try \`set_blink period=100\`.
    if (ticks % blink_period_ticks == 0) {
        led_on = !led_on;
        gpio_put(LED_PIN, led_on);
        log("tick=%u, led=%s\\n", ticks, led_on ? "on" : "off");
    }

    // Stream a sine wave to the chart pane — one F32 sample per tick.
    // Amplitude is mutable via \`set_amp value=...\` (1000 = 1.0).
    F32 sin_val;
    sin_val[0] = sine_amplitude * sinf((float)ticks * 0.01f);
    transmit("SIN", F32, sin_val);

    // Vector example — a synthetic 3-axis "sensor". Use a typedef once,
    // then pass it through transmit() like any other channel.
    //
    //   typedef int16_t IMU_T[3];
    //   IMU_T imu = { ax, ay, az };
    //   transmit("IMU_ACCEL", IMU_T, imu);
}
`;

  // localStorage layout: { source, baseVersion, baseSource }.
  // - `source`: the user's current editor content
  // - `baseVersion`: the BLINK_TEMPLATE version that was current when we
  //   last seeded an unedited template into the editor
  // - `baseSource`: the verbatim text of that template
  // When BLINK_TEMPLATE changes (we bump TEMPLATE_VERSION), on next load:
  //   - If the saved source equals the saved baseSource → user hasn't
  //     edited; silently update to the new template.
  //   - Otherwise → user has edits we don't want to lose; keep the saved
  //     source but warn in the build log so they know how to reset.
  const SOURCE_STORAGE_KEY = 'conduit_source_v2';
  const TEMPLATE_VERSION = 4;

  let editorMounted = false;

  function loadSavedSource() {
    try {
      const raw = localStorage.getItem(SOURCE_STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj && typeof obj.source === 'string') return obj;
    } catch (_) {}
    return null;
  }

  function persistSource(source) {
    try {
      localStorage.setItem(SOURCE_STORAGE_KEY, JSON.stringify({
        source,
        baseVersion: TEMPLATE_VERSION,
        baseSource: BLINK_TEMPLATE,
      }));
    } catch (_) {}
  }

  function resetTemplate() {
    try { localStorage.removeItem(SOURCE_STORAGE_KEY); } catch (_) {}
    if (window.Conduit && window.Conduit.editor && window.Conduit.editor.setSource) {
      window.Conduit.editor.setSource(BLINK_TEMPLATE);
    }
    persistSource(BLINK_TEMPLATE);
    logLine('Editor reset to default template.');
  }

  async function ensureEditor() {
    if (editorMounted) return;
    editorMounted = true;
    const api = window.Conduit && window.Conduit.editor;
    if (!api) {
      logLine('editor.js not loaded; source edit disabled');
      return;
    }

    // Decide whether to use the saved source or the current template.
    let initial = BLINK_TEMPLATE;
    let warnStaleEdits = false;
    const saved = loadSavedSource();
    if (saved) {
      if (saved.baseVersion === TEMPLATE_VERSION) {
        // Same template generation as the saved-from baseline → preserve user's source.
        initial = saved.source;
      } else if (typeof saved.baseSource === 'string' && saved.source === saved.baseSource) {
        // User had an OLDER template, never edited it → silently upgrade.
        initial = BLINK_TEMPLATE;
      } else {
        // User has edits relative to an OLDER template. Preserve their work
        // but warn — the new template may have additions they want.
        initial = saved.source;
        warnStaleEdits = true;
      }
    }

    try {
      await api.mount('ide-source', initial);
      if (warnStaleEdits) {
        logLine('Editor source carried over from an older template version.');
        logLine('Click "Reset template" if you want the latest default.');
      }
      // Re-stamp storage with the now-current baseVersion so we don't keep
      // warning every reload (the user has acknowledged their edits stay).
      persistSource(initial);
    } catch (e) {
      editorMounted = false;
      logLine(`editor mount failed: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------------
  // Resizable panes — drag the dividers between editor / side-panes
  // (vertical) and between build-log / telemetry / console (horizontal).
  // Sizes persist as percentages in localStorage so the layout survives
  // reload. Each divider has a `data-target` attr naming the CSS custom
  // property it controls (--editor-w / --log-h / --tel-h); the math is
  // generic so adding more panes later just means another divider in
  // the DOM with a new --var name.
  // ---------------------------------------------------------------------

  const LAYOUT_KEY = 'conduit.layout';
  const DEFAULT_MIN_PANE_PX = 120;   // per-resizer min, override via data-min-px

  function loadLayout() {
    try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'); }
    catch (_) { return {}; }
  }
  function saveLayout(obj) {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(obj)); }
    catch (_) {}
  }

  // ─────────────────────────────────────────────────────────────────
  // Pure layout solver. DOM-free, side-effect-free — fed an outer
  // viewport width plus the saved telemetry/log percentages and a
  // mins record, returns the clamped percentages that satisfy every
  // pane's minimum. The order of clamps is fixed (outer-first:
  // telemetry then log) so cascading constraints settle in a single
  // pass. See web/tests/unit/layout_solver.test.mjs for the contract.
  // The DOM-driven clamp paths below call this; tests drive it
  // directly via window.Conduit.layout.solve.
  function solveLayout({ ideLayoutPx, telemetryPct, logPct, mins }) {
    const m = mins || { log: 360, console: 420, telemetry: 420, resizer: 6 };
    // Clamp telemetry first (outer): main column needs at least
    // log_min + 6 + console_min, plus the 6-px telemetry resizer track
    // that's deducted from main.
    const telOtherMin = m.log + m.resizer + m.console + m.resizer;
    let telPct = Number.isFinite(telemetryPct) ? telemetryPct : 35;
    if (ideLayoutPx > 0) {
      const telMinPct = (m.telemetry / ideLayoutPx) * 100;
      const telMaxPct = 100 - (telOtherMin / ideLayoutPx) * 100;
      // Apply max first, then min. If the viewport is too small for
      // both mins to fit (max < min), this lands telPct at the min,
      // preferring to honour the telemetry pane's own width over a
      // perfect bottom-area split — the resulting overflow is the
      // honest "viewport is too small" UX, not a silent collapse.
      if (telPct > telMaxPct) telPct = telMaxPct;
      if (telPct < telMinPct) telPct = telMinPct;
    }
    // Now compute bottom-area width and clamp log against it.
    const bottomAreaPx = Math.max(0, ideLayoutPx - m.resizer - (telPct / 100) * ideLayoutPx);
    const logOtherMin  = m.console + m.resizer;
    let cLogPct = Number.isFinite(logPct) ? logPct : 50;
    if (bottomAreaPx > 0) {
      const logMinPct = (m.log / bottomAreaPx) * 100;
      const logMaxPct = 100 - (logOtherMin / bottomAreaPx) * 100;
      if (cLogPct > logMaxPct) cLogPct = logMaxPct;
      if (cLogPct < logMinPct) cLogPct = logMinPct;
    }
    return { telemetryPct: telPct, logPct: cLogPct };
  }
  window.Conduit = window.Conduit || {};
  window.Conduit.layout = { solve: solveLayout };

  // Compute a resizer's allowed [min%, max%] band against its current
  // container width. Used both during drag (live clamp) and on init /
  // window resize (re-clamp persisted values that may have been saved
  // at a larger viewport or before a new other-side min was introduced).
  function resizerBand(r) {
    const axis = r.dataset.axis;
    const minPx = Number(r.dataset.minPx) || DEFAULT_MIN_PANE_PX;
    const otherMinPx = Number(r.dataset.otherMinPx) || DEFAULT_MIN_PANE_PX;
    const containerSel = r.dataset.container
      || (axis === 'x' ? '.ide-layout' : '.main-area');
    const container = document.querySelector(containerSel);
    if (!container) return { minPct: 5, maxPct: 95 };
    const rect = container.getBoundingClientRect();
    const span = axis === 'x' ? rect.width : rect.height;
    if (span <= 0) return { minPct: 5, maxPct: 95 };
    let minPct = (minPx / span) * 100;
    let maxPct = 100 - (otherMinPx / span) * 100;
    // Tiny viewport — both mins can't be honoured. Fall back to a
    // proportional split (50/50) rather than negative numbers.
    if (maxPct <= minPct) { minPct = 5; maxPct = 95; }
    return { minPct, maxPct };
  }

  // Walk every resizer and clamp its target CSS-var into the current
  // valid band. Resizers cascade — the log↔console resizer's container
  // is .bottom-area, whose width depends on the telemetry resizer's
  // current value. So we run the clamp pass repeatedly until nothing
  // changes (max 4 iterations as a safety belt). This handles the
  // case where a saved telemetry-w is over-wide → bottom-area is
  // stale → log-w clamps against a wrong width on the first pass.
  function clampAllResizers() {
    const root = document.documentElement;
    let totalChanged = false;
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const r of document.querySelectorAll('.resizer')) {
        const target = r.dataset.target;
        if (!target) continue;
        const cur = parseFloat(getComputedStyle(root).getPropertyValue(target));
        if (!Number.isFinite(cur)) continue;
        const { minPct, maxPct } = resizerBand(r);
        let next = cur;
        if (next < minPct) next = minPct;
        if (next > maxPct) next = maxPct;
        if (Math.abs(next - cur) > 0.05) {
          root.style.setProperty(target, next.toFixed(2) + '%');
          changed = true;
          totalChanged = true;
        }
      }
      if (!changed) break;
    }
    if (totalChanged) {
      // Persist the settled values.
      const layout = loadLayout();
      for (const r of document.querySelectorAll('.resizer')) {
        const target = r.dataset.target;
        if (!target) continue;
        const cur = getComputedStyle(root).getPropertyValue(target).trim();
        if (cur) layout[target] = cur;
      }
      saveLayout(layout);
      window.dispatchEvent(new Event('resize'));
    }
  }

  function setupResizers() {
    const root = document.documentElement;
    const layout = loadLayout();
    // Restore any previously-saved CSS-var sizes before binding drag.
    // Clamp to a sane band [10%, 90%] — the resizer's offset math can
    // produce nonsense values (negative %, >100%) when the viewport
    // shrinks between sessions (e.g. after we added the Conduit topbar
    // above the IDE shell), and an out-of-range track size collapses
    // the bottom panes to ~0 with the editor eating the layout.
    for (const [k, v] of Object.entries(layout)) {
      if (typeof k !== 'string' || !k.startsWith('--')) continue;
      if (typeof v !== 'string' || !v.endsWith('%')) continue;
      const n = parseFloat(v);
      if (!Number.isFinite(n) || n < 10 || n > 90) {
        // Drop the bad entry so the CSS fallback (e.g. 60% / 35%) wins.
        delete layout[k];
        saveLayout(layout);
        continue;
      }
      root.style.setProperty(k, v);
    }

    for (const r of document.querySelectorAll('.resizer')) {
      r.addEventListener('mousedown', (e) => beginDrag(r, e));
      // Keyboard accessibility: arrow keys nudge by 2% per press.
      r.addEventListener('keydown', (ev) => onResizerKey(r, ev));
    }

    // Re-clamp now (catches values saved before we added the new
    // bottom-area constraint) and on every viewport change. requestAnimation
    // gives the layout one tick to settle so getBoundingClientRect reads
    // the post-init dimensions instead of zero.
    requestAnimationFrame(clampAllResizers);
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      // Debounced — clamping during a continuous viewport drag would
      // shrink the saved % to whatever the smallest transient size was,
      // and the user wouldn't get the room back when the window grows.
      resizeTimer = setTimeout(clampAllResizers, 150);
    });

    // Hide / show the telemetry pane via the topbar toggle. The
    // hidden state collapses the whole right column (resizer + pane)
    // and persists across reloads. The icon flips between two glyphs
    // following the standard right-sidebar convention: when the panel
    // is OPEN the arrow points right (toward the panel = "push it
    // closed against the right edge"); when CLOSED the arrow points
    // left (away from the right edge = "pull the panel back out").
    const toggleBtn = document.getElementById('ide-toggle-telemetry');
    const main = document.getElementById('ide-main-layout');
    const icons = window.Conduit && window.Conduit.icons;
    if (toggleBtn && main) {
      const apply = (hidden) => {
        main.classList.toggle('telemetry-hidden', !!hidden);
        toggleBtn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
        toggleBtn.title = hidden ? 'Show telemetry pane' : 'Hide telemetry pane';
        // 20-px glyph reads cleanly inside the 28-px topbar iconbtn —
        // 18 was inherited from when the button lived in the IDE's
        // internal toolbar and looks lost in the larger global topbar.
        if (icons) icons.set(toggleBtn, hidden ? 'panel_close' : 'panel_open',
                             { size: 20 });
        // Tell uPlot + anyone else with a ResizeObserver that the
        // viewport effectively changed.
        window.dispatchEvent(new Event('resize'));
      };
      apply(!!layout.telemetryHidden);
      toggleBtn.addEventListener('click', () => {
        const next = !main.classList.contains('telemetry-hidden');
        apply(next);
        const l = loadLayout();
        l.telemetryHidden = next;
        saveLayout(l);
      });
    }

    // Static icons in pane headers. Pause/play toggles flip their own
    // glyph from inside chart.js / console.js on state changes; here
    // we just paint the steady-state icons.
    if (icons) {
      icons.set(document.getElementById('ide-log-clear'),    'delete',   { size: 14 });
      icons.set(document.getElementById('ide-console-clear'),'delete',   { size: 14 });
      icons.set(document.getElementById('ide-console-ts'),   'schedule', { size: 14 });
      icons.set(document.getElementById('ide-add-plot'),     'add',      { size: 14 });
      icons.set(document.getElementById('ide-telemetry-download'),
                'download', { size: 14 });
    }

    // Relocated Download button — single bundle of everything the
    // browser has captured (across sessions): runtime log AND every
    // telemetry channel, packed into one HDF5. Flushes both persist
    // queues first so the file reflects the latest samples instead of
    // whatever last hit the timed flush.
    const dlBtn = document.getElementById('ide-telemetry-download');
    if (dlBtn) {
      dlBtn.addEventListener('click', async () => {
        const exporter = window.Conduit && window.Conduit.logExport;
        const nc = window.Conduit && window.Conduit.netcon;
        if (!exporter) {
          if (nc) nc.err('Download failed: log exporter not loaded');
          return;
        }
        // Snapshot the click time. The exporter filters out anything
        // with wall_ms > cutoff so a long-running session can't keep
        // the export window open indefinitely (and the file matches
        // exactly what the user saw at click time).
        const cutoffWallMs = Date.now();
        const prog = nc && nc.progress
          ? nc.progress(`Export → cutoff ${new Date(cutoffWallMs).toLocaleTimeString()}`)
          : { update() {}, done() {}, fail() {} };
        try {
          dlBtn.disabled = true;
          dlBtn.title = 'Preparing HDF5…';
          // Push any in-flight batches to IndexedDB before reading.
          if (window.Conduit.console   && window.Conduit.console.flushPersist)
            window.Conduit.console.flushPersist();
          if (window.Conduit.telemetry && window.Conduit.telemetry.flushPersist)
            window.Conduit.telemetry.flushPersist();
          const summary = await exporter.downloadHdf5({
            cutoffWallMs,
            onProgress: ({ pct, label }) => prog.update(pct, label),
          });
          const sizeKb = (summary.sizeBytes / 1024).toFixed(1);
          const t = summary.timings || {};
          // Recording window — original wall-clock times of the
          // earliest and latest sample landed in the file. Lets the
          // user verify the file really covers what they expected
          // without having to crack the HDF5 open.
          const fmtTs = (ms) => {
            if (ms == null) return '—';
            const d = new Date(ms);
            return d.toLocaleTimeString() + '.' +
                   String(d.getMilliseconds()).padStart(3, '0');
          };
          const recordedWindow = (summary.firstWallMs != null && summary.lastWallMs != null)
            ? `recorded ${fmtTs(summary.firstWallMs)} → ${fmtTs(summary.lastWallMs)} ` +
              `(${(summary.durationMs / 1000).toFixed(1)}s) · `
            : '';
          prog.done(
            `Saved ${summary.filename} — ` +
            `${summary.telemetryRecords} sample` +
            `${summary.telemetryRecords === 1 ? '' : 's'} ` +
            `across ${summary.telemetryChannels} channel` +
            `${summary.telemetryChannels === 1 ? '' : 's'} · ` +
            recordedWindow +
            `${sizeKb} KB · h5wasm ${t.h5wasmMs}ms / tlm ${t.telemetryMs}ms / ` +
            `build ${t.buildMs}ms · ${t.totalMs}ms total`
          );
        } catch (e) {
          console.error('[ide] HDF5 export failed:', e);
          prog.fail(`Download failed: ${e.message || e}`);
        } finally {
          dlBtn.disabled = false;
          dlBtn.title = 'Download recording (telemetry + log) as HDF5';
        }
      });
    }
  }

  function beginDrag(r, e) {
    e.preventDefault();
    const axis = r.dataset.axis;                       // 'x' or 'y'
    const target = r.dataset.target;                   // CSS custom property name
    const anchor = r.dataset.anchor || 'left';         // 'left'/'top' or 'right'/'bottom'
    const minPx = Number(r.dataset.minPx) || DEFAULT_MIN_PANE_PX;
    // data-other-min-px lets a resizer enforce a minimum on the OPPOSITE
    // side too. The main↔telemetry resizer uses it so dragging telemetry
    // wider stops as soon as the main column can no longer fit Build Log
    // + Runtime Console (the bottom-area panes nested inside main).
    // Without this the telemetry grow-drag could shrink main below the
    // bottom-area's required width, clipping the build/console panes.
    const otherMinPx = Number(r.dataset.otherMinPx) || DEFAULT_MIN_PANE_PX;
    const containerSel = r.dataset.container
      || (axis === 'x' ? '.ide-layout' : '.main-area');
    const container = document.querySelector(containerSel);
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const span = axis === 'x' ? rect.width : rect.height;
    const startPos = axis === 'x' ? rect.left : rect.top;

    const minPct = (minPx / span) * 100;
    const maxPct = 100 - (otherMinPx / span) * 100;

    r.classList.add('dragging');
    document.body.classList.add('resizing', axis === 'x' ? 'resizing-v' : 'resizing-h');

    const onMove = (ev) => {
      const cursorPos = axis === 'x' ? ev.clientX : ev.clientY;
      // Right- (or bottom-) anchored: target % is the size of the pane
      // on the FAR side of the resizer (e.g. telemetry width = how
      // much room the right column gets). Left/top anchored: target %
      // is the size of the pane on the NEAR side (editor width).
      let pct = (anchor === 'right' || anchor === 'bottom')
        ? ((startPos + span - cursorPos) / span) * 100
        : ((cursorPos - startPos) / span) * 100;
      if (pct < minPct) pct = minPct;
      if (pct > maxPct) pct = maxPct;
      document.documentElement.style.setProperty(target, pct.toFixed(2) + '%');
      // Cascade: dragging telemetry shrinks bottom-area → log-w may now
      // be too wide and crush the runtime console. Run the full layout
      // solver synchronously so the inner resizer adjusts in real time
      // (the debounced resize handler alone fires only after release).
      clampAllResizers();
      window.dispatchEvent(new Event('resize'));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
      r.classList.remove('dragging');
      document.body.classList.remove('resizing', 'resizing-v', 'resizing-h');
      const layout = loadLayout();
      layout[target] = document.documentElement.style.getPropertyValue(target);
      saveLayout(layout);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  }

  function onResizerKey(r, ev) {
    const axis = r.dataset.axis;
    const target = r.dataset.target;
    const anchor = r.dataset.anchor || 'left';
    // Map arrow direction to "shrink target pane" vs "grow target pane",
    // accounting for which side of the resizer the target lives on.
    const grow = (anchor === 'right' || anchor === 'bottom')
      ? (axis === 'x' ? ev.key === 'ArrowLeft' : ev.key === 'ArrowUp')
      : (axis === 'x' ? ev.key === 'ArrowRight' : ev.key === 'ArrowDown');
    const shrink = (anchor === 'right' || anchor === 'bottom')
      ? (axis === 'x' ? ev.key === 'ArrowRight' : ev.key === 'ArrowDown')
      : (axis === 'x' ? ev.key === 'ArrowLeft' : ev.key === 'ArrowUp');
    if (!grow && !shrink) return;
    ev.preventDefault();
    // Mirror the drag-handler clamps so keyboard nudges respect the
    // same per-pane mins (and the bottom-area composite min via
    // data-other-min-px).
    const minPx = Number(r.dataset.minPx) || DEFAULT_MIN_PANE_PX;
    const otherMinPx = Number(r.dataset.otherMinPx) || DEFAULT_MIN_PANE_PX;
    const containerSel = r.dataset.container
      || (axis === 'x' ? '.ide-layout' : '.main-area');
    const container = document.querySelector(containerSel);
    const span = container
      ? (axis === 'x' ? container.getBoundingClientRect().width
                       : container.getBoundingClientRect().height)
      : 0;
    const minPct = span > 0 ? (minPx / span) * 100 : 5;
    const maxPct = span > 0 ? 100 - (otherMinPx / span) * 100 : 95;
    const cur = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue(target)) || 50;
    let next = grow ? cur + 2 : cur - 2;
    if (next < minPct) next = minPct;
    if (next > maxPct) next = maxPct;
    document.documentElement.style.setProperty(target, next.toFixed(2) + '%');
    window.dispatchEvent(new Event('resize'));
    const layout = loadLayout();
    layout[target] = next.toFixed(2) + '%';
    saveLayout(layout);
  }

  function initIde() {
    console.log('[ide.js] demo polish; v=' +
                (window.CONDUIT_ASSET_VERSION || 'unknown'));

    const deviceSelect = document.getElementById('ide-device-select');
    const token = document.getElementById('ide-auth-token');

    // Restore persisted token so reload reconnects with the same
    // /api/upload + /api/cmd credentials. Device selection is restored
    // separately by refreshDeviceList() below from s.ide_ip.
    try {
      const s = JSON.parse(localStorage.getItem('conduit') || '{}');
      if (s.token) token.value = s.token;
    } catch (_) {}

    const persist = () => {
      try {
        const s = JSON.parse(localStorage.getItem('conduit') || '{}');
        s.ide_ip = deviceSelect.value;
        s.token  = token.value;
        localStorage.setItem('conduit', JSON.stringify(s));
      } catch (_) {}
    };
    deviceSelect.addEventListener('change', () => {
      persist();
      // Let the console tear down its cursor so the next poll gets the
      // current-cursor reset of the newly-selected device.
      if (window.Conduit && window.Conduit.console) {
        window.Conduit.console.resetCursor();
        window.Conduit.console.clear();
      }
    });
    token.addEventListener('change', persist);

    // Populate the dropdown from the last scan's results. Also
    // rebuilds the custom picker's <ul> menu so the visible UI tracks
    // the hidden <select>.
    function refreshDeviceList() {
      const prevValue = deviceSelect.value || (() => {
        try { return JSON.parse(localStorage.getItem('conduit') || '{}').ide_ip || ''; }
        catch (_) { return ''; }
      })();
      const known = (window.Conduit && typeof window.Conduit.getKnownDevices === 'function')
        ? window.Conduit.getKnownDevices() : [];
      deviceSelect.innerHTML = '';
      if (known.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(no device — Add one in Hardware Manager)';
        deviceSelect.appendChild(opt);
      } else {
        for (const d of known) {
          const opt = document.createElement('option');
          opt.value = d.ip;
          opt.textContent = devicePickerLabel(d);
          deviceSelect.appendChild(opt);
        }
      }
      const match = Array.from(deviceSelect.options).find((o) => o.value === prevValue);
      if (match) deviceSelect.value = prevValue;
      else if (known.length > 0) deviceSelect.value = known[0].ip;
      rebuildDeviceMenu(known);
      updateDevicePickerLabel();
    }

    // ---- Custom device picker (visible UI over the hidden select) ----
    const deviceTrigger = document.getElementById('ide-device-trigger');
    const deviceMenu    = document.getElementById('ide-device-menu');
    const deviceLabel   = document.getElementById('ide-device-label');
    const deviceLed     = document.getElementById('ide-device-led');

    // Picker label: prefer human name, then unique-id, then bare IP.
    // Same shape as Hardware Manager's row label so the picker doesn't
    // surprise people who registered the device under a name.
    function devicePickerLabel(d) {
      const head = d.name || d.uniqueId || d.ip;
      const tail = [];
      if (head !== d.ip)    tail.push(d.ip);
      if (d.version)        tail.push(`v${d.version}`);
      if (d.partition)      tail.push(d.partition);
      return tail.length ? `${head} — ${tail.join(' · ')}` : head;
    }

    function rebuildDeviceMenu(known) {
      if (!deviceMenu) return;
      deviceMenu.innerHTML = '';
      if (!known || known.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'device-picker__menu-empty';
        empty.textContent = 'No devices yet — open Hardware Manager to add one.';
        deviceMenu.appendChild(empty);
        return;
      }
      for (const d of known) {
        const li = document.createElement('li');
        li.className = 'device-picker__menu-item';
        li.setAttribute('role', 'option');
        li.dataset.value = d.ip;
        li.textContent = devicePickerLabel(d);
        if (d.ip === deviceSelect.value) li.setAttribute('aria-selected', 'true');
        deviceMenu.appendChild(li);
      }
    }
    function updateDevicePickerLabel() {
      if (!deviceLabel) return;
      const opt = deviceSelect.options[deviceSelect.selectedIndex];
      deviceLabel.textContent = (opt && opt.textContent) || '(no device — Add one in Hardware Manager)';
      // Highlight the active row in the menu (if it's open).
      if (deviceMenu) {
        for (const row of deviceMenu.querySelectorAll('.device-picker__menu-item')) {
          if (row.dataset.value === deviceSelect.value) row.setAttribute('aria-selected', 'true');
          else                                          row.removeAttribute('aria-selected');
        }
      }
    }
    function openDeviceMenu() {
      if (!deviceMenu || !deviceTrigger) return;
      deviceMenu.hidden = false;
      deviceTrigger.setAttribute('aria-expanded', 'true');
      // Defer outside-click attach so the click that opened the menu
      // doesn't immediately close it.
      setTimeout(() => {
        document.addEventListener('click',   onDeviceMenuOutside);
        document.addEventListener('keydown', onDeviceMenuKey);
      }, 0);
    }
    function closeDeviceMenu() {
      if (!deviceMenu || !deviceTrigger) return;
      deviceMenu.hidden = true;
      deviceTrigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click',   onDeviceMenuOutside);
      document.removeEventListener('keydown', onDeviceMenuKey);
    }
    function onDeviceMenuOutside(ev) {
      if (deviceMenu.contains(ev.target) || deviceTrigger.contains(ev.target)) return;
      closeDeviceMenu();
    }
    function onDeviceMenuKey(ev) {
      if (ev.key === 'Escape') { closeDeviceMenu(); deviceTrigger.focus(); }
    }
    if (deviceTrigger) {
      deviceTrigger.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (deviceMenu.hidden) openDeviceMenu();
        else                   closeDeviceMenu();
      });
    }
    if (deviceMenu) {
      // Event-delegated row click — picks an item, syncs the hidden
      // <select>, and dispatches a 'change' event so the rest of
      // ide.js (persist, console reset) reacts the same way it would
      // for a native select.
      deviceMenu.addEventListener('click', (ev) => {
        const row = ev.target.closest('.device-picker__menu-item');
        if (!row || !row.dataset.value) return;
        deviceSelect.value = row.dataset.value;
        deviceSelect.dispatchEvent(new Event('change', { bubbles: true }));
        updateDevicePickerLabel();
        closeDeviceMenu();
      });
    }
    // Keep the picker label in sync whenever the hidden select changes
    // (e.g. an Add probe sets `deviceSelect.value = ip` directly).
    deviceSelect.addEventListener('change', updateDevicePickerLabel);

    // Mirror the telemetry stream's status onto the picker's LED. The
    // telemetry pane already maintains a `.status-dot[data-state]` span;
    // rather than re-deriving the connection state here, we just copy
    // its data-state attribute whenever it changes.
    //
    // A separate web/health.js was tried (independent /api/status
    // probe driving the LED for faster red→green), but the extra
    // HTTPS handshakes it generated competed with OTA uploads and
    // wedged the device across sessions. Reverted — the slower
    // stream-mirrored LED is reliable and the CONNECT_TIMEOUT_MS
    // halving in telemetry.js/console.js already cuts the worst-case
    // latency from 8 s to 4 s without adding probe traffic.
    const telState = document.getElementById('ide-telemetry-state');
    if (telState && deviceLed) {
      const syncLed = () => deviceLed.setAttribute('data-state',
        telState.getAttribute('data-state') || 'off');
      syncLed();
      new MutationObserver(syncLed).observe(telState,
        { attributes: true, attributeFilter: ['data-state'] });
    }

    refreshDeviceList();
    window.addEventListener('conduit:devices-updated', refreshDeviceList);

    // Add-by-IP lives in the Hardware Manager view now; the IDE
    // topbar no longer has its own Add input. Devices flow into the
    // picker via the 'conduit:devices-updated' event above.

    document.getElementById('ide-btn-build').addEventListener('click', onBuild);
    document.getElementById('ide-btn-build-upload').addEventListener('click', onBuildUpload);

    // Wait until the WS stream is both stability-gated AND actively
    // streaming, or `timeoutMs` elapses. Used by reconnect() to hold
    // the "Reconnected" banner until the green LED would flip — the
    // probe alone is just HTTPS reachability and isn't enough to
    // claim the user is back online.
    async function awaitStableStream(timeoutMs) {
      const s = window.Conduit && window.Conduit.stream;
      if (!s || typeof s.isStable !== 'function') return true; // no gate; assume ok
      const start = performance.now();
      while (performance.now() - start < timeoutMs) {
        if (s.isStable() && s.isStreaming && s.isStreaming()) return true;
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    }

    // Reconnect — re-probes the bound IP and force-restarts the
    // telemetry / runtime-console streams. Auto-fires once on UI start
    // to recover from a stale dropdown selection pointing at a device
    // that's been power-cycled / reflashed since last visit, which
    // otherwise leaves the panes silent even though the device is on
    // the LAN.
    async function reconnect() {
      const ip = (deviceSelect.value || '').trim();
      if (!ip) { connStatus('no device — Add one in Hardware Manager', 'err'); return; }

      // Don't pause streams during the probe. The previous design did
      // — to avoid 3 simultaneous TLS handshakes on a single-threaded
      // mbedtls — but the firmware-side slab + 128 KB MEM_SIZE handle
      // that load fine now, and the pause/resume choreography was
      // load-bearing for a subtle bug: if the probe failed for ANY
      // reason (transient network glitch, brief device reboot,
      // browser-side quirk), the resume branch was skipped via the
      // early return, leaving both streams paused with no path back
      // online without a manual page reload. Streams running through
      // the probe is now the cleaner default — the streamLoop's own
      // retry logic handles their lifecycle, the probe is just an
      // out-of-band reachability check that updates the connStatus
      // banner.
      try {
        connStatus(`Reconnecting ${ip}…`);
        const result = await window.Conduit.probeAndRemember(ip);
        if (!result) {
          connStatus(`no response from ${ip}`, 'err');
          return;
        }
        // Probe succeeded (HTTPS reachable) but that's not the same
        // as "user-facing reconnected" — the WS stream still has to
        // pass its stability gate (≥5 s streamConnected + streaming)
        // before the green LED flips. Wait for that signal so the
        // banner doesn't claim success ahead of the LED. If the
        // stream doesn't stabilize within the window (chronic
        // page-load cycling, or device went away again), report
        // probed-but-not-streaming so the banner stays honest.
        const stable = await awaitStableStream(15000);
        if (stable) {
          connStatus(`Reconnected (v${result.version}, ${result.partition})`, 'ok');
        } else {
          connStatus(`stream still establishing (v${result.version}, ${result.partition})`, '');
        }
      } catch (e) {
        connStatus(`reconnect error: ${e.message || e}`, 'err');
        return;
      } finally {
        refreshDeviceList();
      }
    }
    // Auto-kick reconnect once on boot. Deferred slightly so the rest
    // of init (telemetry's streamLoop, console's poll loop) has wired
    // up — pause/resume needs the loops to exist to do their thing.
    setTimeout(() => { reconnect().catch(() => {}); }, 200);

    setupResizers();

    // Clear buttons for the two output panes.
    const clearLogBtn = document.getElementById('ide-log-clear');
    if (clearLogBtn) clearLogBtn.addEventListener('click', clearLog);
    // Console clear is wired up inside console.js.

    // Reset-template button: discards localStorage source + warning state
    // and re-seeds the current default. Confirms first to avoid accidents.
    const resetBtn = document.getElementById('ide-source-reset');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      if (window.confirm('Discard your current source and load the default template?')) {
        resetTemplate();
      }
    });

    // Keyboard shortcut: ⌘/Ctrl+Enter triggers Build & Upload from anywhere
    // on the page (including while the editor has focus). Monaco normally
    // swallows unrecognized key events, so we register the accelerator on
    // document too as a belt-and-braces — the editor.js side installs it as
    // a Monaco command in the editor context.
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        onBuildUpload();
      }
    });

    // Persist source on every edit (debounced).
    let persistSrcTimer = 0;
    if (window.Conduit && window.Conduit.editor && window.Conduit.editor.onChange) {
      window.Conduit.editor.onChange(() => {
        clearTimeout(persistSrcTimer);
        persistSrcTimer = setTimeout(() => {
          try {
            const src = window.Conduit.editor.getSource();
            if (src != null) persistSource(src);
          } catch (_) {}
        }, 400);
      });
    }

    ensureEditor();
  }

  // Binary version to stamp into every IDE-built UF2. See memory note
  // project_rom_reboot_watchdog_race for why this must strictly increase
  // per upload (tied versions roll back).
  function nextStampedVersion() {
    return {
      major: 0x7fff,
      minor: Math.floor(Date.now() / 1000) & 0xffff,
    };
  }

  async function buildUf2(opts) {
    const { version = null } = opts || {};
    const api = window.Conduit || {};
    if (typeof api.elfToUf2 !== 'function') {
      throw new Error('UF2 pipeline not available (uf2.js missing).');
    }
    const compilerReady = api.compiler && typeof api.compiler.compile === 'function';
    const source = api.editor && typeof api.editor.getSource === 'function'
      ? api.editor.getSource()
      : null;
    if (!(compilerReady && source && source.trim())) {
      throw new Error('No source to compile (editor not ready?).');
    }

    api.compiler.setProgress(({ stage, pct, detail }) => {
      logLine(`[${stage}] ${Math.round(pct)}% ${detail || ''}`);
      // Bar pct comes from elapsed time, not from {stage,pct} —
      // ensures monotonic, smooth fill regardless of how many sub-
      // phases the compiler emits per stage. The label still carries
      // the live stage/detail so the user knows which step is running.
      const tag = detail ? `${stage} · ${detail}` : stage;
      setProgressBar({ pct: buildPct(), label: `Building · ${tag}` });
    });
    const elfBytes = await api.compiler.compile(source);
    logLine(`compile+link produced ${elfBytes.byteLength}-byte ELF`);

    let extraChunks = [];
    let patches = [];
    if (api.finalize && typeof api.finalize.finalizeElf === 'function') {
      const meta = await api.finalize.finalizeElf(elfBytes, { setTbyb: true, version });
      extraChunks = meta.extraChunks || [];
      patches = meta.patches || [];
      if (meta.hash) {
        const hex = Array.from(meta.hash, (b) => b.toString(16).padStart(2, '0')).join('');
        logLine(`hash = ${hex.slice(0, 16)}… (SHA256 over loadable + new IMAGE_DEF block)`);
      }
      if (version) logLine(`stamped version ${version.major}.${version.minor}, TBYB on`);
    }
    return api.elfToUf2(elfBytes, { extraChunks, patches });
  }

  async function onBuild() {
    clearLog();
    resetBuildBar();
    setProgressBar({ pct: 0, label: 'Building…', title: null });
    try {
      const uf2 = await buildUf2({ version: nextStampedVersion() });
      // Build is a compile + link check now — used to validate the
      // user's main.c without committing to an OTA. The factory
      // commissioning image (bootloader + non-TBYB app) is produced
      // by .github/workflows/commissioning-image.yml; the in-IDE
      // path is OTA-only via Build & Upload.
      logLine(`built ${uf2.byteLength} bytes, ${uf2.byteLength / 512} UF2 blocks`);
      recordBuildDuration();
      setProgressBar({ pct: 100, label: `Built ${uf2.byteLength} B`, kind: 'ok' });
    } catch (e) {
      if (e.stderr) logLine(e.stderr.trim());
      logLine(`error: ${e.message}`);
      const summary = extractCompileError(e.stderr) || e.message;
      const short = compactError(summary);
      setProgressBar({
        label: short ? `Build failed — ${short}` : 'Build failed',
        title: summary,
        kind: 'err',
      });
    }
  }

  async function onBuildUpload() {
    const ip = document.getElementById('ide-device-select').value.trim();
    const token = document.getElementById('ide-auth-token').value;
    if (!ip) {
      setProgressBar({ pct: 0, label: 'Pick a device (Add an IP)', kind: 'err' });
      return;
    }
    if (!token) {
      setProgressBar({ pct: 0, label: 'Auth token is empty', kind: 'err' });
      return;
    }

    clearLog();
    resetBuildBar();
    setProgressBar({ pct: 0, label: 'Building…', title: null });

    // Streams are paused at the start of the upload phase (see below,
    // just after buildUf2 returns) and resumed in the outer finally.
    // The build phase is pure CPU (WASM compile, no device traffic) so
    // it runs with streams still live. Once we start uploading, every
    // mbedtls cycle the device spends encrypting a 16-byte stream
    // keepalive is a cycle it isn't spending decrypting upload bytes —
    // and the device's slab/lwIP heap headroom is tighter when three
    // TLS sessions (upload + 2 streams) all need state at once. Pause
    // → upload → resume gives mbedtls undivided focus on the upload.
    // The resume in finally fires on every exit path (build error,
    // updateFirmware throw, success), so a stream that was running on
    // entry is running on exit. The stream's own retry loop then
    // reconnects against the post-reboot device — same path that page
    // reload uses, which the user has confirmed works reliably.
    const tlm = window.Conduit && window.Conduit.telemetry;
    const con = window.Conduit && window.Conduit.console;

    // Handle for the elapsed-time ticker that runs during the
    // 'uploading' stage (was a dots-spinner before xhr.upload.onprogress
    // gave us a real percentage). Declared at function scope so the
    // outer `finally` can clear it regardless of which error path the
    // upload took. See the onStage 'uploading' branch below for the
    // ticker setup.
    let uploadSpinHandle = null;
    let result;
    try {

    const stampVer = nextStampedVersion();
    try {
      const pre = await window.Conduit.getStatus(ip);
      logLine(`device at v${pre.version} on partition ${pre.partition} — stamping v${stampVer.major}.${stampVer.minor}`);
    } catch (e) {
      logLine(`precheck failed (${e.message}); stamping v${stampVer.major}.${stampVer.minor} anyway`);
    }

    let uf2;
    try {
      uf2 = await buildUf2({ version: stampVer });
    } catch (e) {
      if (e.stderr) logLine(e.stderr.trim());
      logLine(`error: ${e.message}`);
      const summary = extractCompileError(e.stderr) || e.message;
      const short = compactError(summary);
      setProgressBar({
        label: short ? `Build failed — ${short}` : 'Build failed',
        title: summary,
        kind: 'err',
      });
      return;
    }
    recordBuildDuration();
    logLine(`built ${uf2.byteLength} bytes`);

    // Build done — bar at 50%; upload phase covers 50..95%, then commit
    // tops it up to 100%. We keep the colour/kind clean here so the
    // bar stays neutral until we have a concrete final outcome.
    setProgressBar({ pct: 50, label: 'Uploading…' });

    // Pause both streams before kicking the upload. Aborts the active
    // fetches, flushes any persistence, drops the chart series, and
    // flips both panes' status lights to "paused". The outer finally
    // resumes them after the OTA — regardless of outcome — and their
    // own retry loops reconnect against the post-reboot device.
    if (tlm && tlm.pause)       tlm.pause();
    if (con && con.pauseStream) con.pauseStream();

    // The 'uploading' stage is long (15-90 s on HTTPS) and the
    // displayed % is OS-TCP-send-buffer-fill, not on-the-wire bytes
    // (see upload.js:159-173). Effect: % jumps to ~30 instantly, sits
    // flat for ~15 s while TCP drains and the device flashes, then
    // climbs to 100. Flat-but-progressing looks like a hang to the
    // user. So while the bytes-progress is honest enough, we ALSO
    // show an elapsed-time counter so motion is always visible.
    //
    // The previous dots-spinner setInterval (uploadSpinHandle) was
    // added back when there was no real progress source — it now
    // just stomps onProgress's "Uploading · 42% (...)" label every
    // 500 ms with "Uploading...". Removed; xhr.upload.onprogress is
    // the honest signal.
    let uploadStartMs = 0;
    let lastProgressLabel = 'Uploading…';

    // Race the post-OTA poll against the WS reconnect: once the device
    // reboots into the new firmware and stream.js lands its first
    // STATUS frame, fire fastReady so updateFirmware skips the 2 s
    // poll interval and proceeds straight to verify/commit. Cuts the
    // 10-20 s "uploading 100% → committed" gap down to ~1 s on LAN.
    // Created BEFORE updateFirmware kicks off; the WS will still be
    // paused-but-alive during the upload (stream.pause is flag-only
    // post-`80d7081`), so onNextConnect only fires after the device
    // reboot kills the existing WS and the reconnect lands.
    const stream = window.Conduit && window.Conduit.stream;
    const fastReady = stream && typeof stream.onNextConnect === 'function'
      ? new Promise((resolve) => {
          const unsub = stream.onNextConnect(() => {
            try { unsub(); } catch (_) {}
            resolve();
          });
        })
      : null;

    result = await window.Conduit.updateFirmware({
        ip, token, data: uf2, fastReady,
        onProgress: ({ pct, loaded, total }) => {
          // Upload covers 50..95% of the overall bar; the last 5% is
          // reserved for verify/commit so the user never sees 100%
          // until the device actually reports the new image running.
          const overall = 50 + (pct / 100) * 45;
          const kb = (n) => (n / 1024).toFixed(0);
          const elapsed = uploadStartMs ? Math.round((performance.now() - uploadStartMs) / 1000) : 0;
          lastProgressLabel =
            `Uploading · ${Math.round(pct)}% (${kb(loaded)}/${kb(total)} KB, ${elapsed}s)`;
          setProgressBar({ pct: overall, label: lastProgressLabel });
        },
        onStage: (stage, detail) => {
          // Build log always reflects the raw stage event. The progress
          // bar gets a structured render via the stage descriptor table
          // in upload.js — adding a new stage there is a one-row edit
          // and the unit test (web/tests/unit/upload_stages.test.mjs)
          // fails CI if a name is emitted without a matching table entry.
          logLine(detail && typeof detail === 'string' ? `[${stage}] ${detail}` : `[${stage}]`);
          const d = window.Conduit && window.Conduit.stageDescriptor
            ? window.Conduit.stageDescriptor(stage, detail) : null;

          // Any stage transition clears the upload-elapsed ticker; the
          // ticker only exists during the 'uploading' window.
          if (uploadSpinHandle) {
            clearInterval(uploadSpinHandle);
            uploadSpinHandle = null;
          }

          if (d) {
            setProgressBar({ pct: d.pct, label: d.label });
            if (stage === 'uploading') {
              // Start the elapsed-time ticker. It re-renders the most
              // recent onProgress label every 1 s with the updated
              // "Xs" suffix, so even when % is flat (OS buffer
              // draining), the user sees the seconds counter advance.
              // If no onProgress has fired yet, the ticker fills in a
              // synthetic label showing only elapsed time.
              uploadStartMs = performance.now();
              uploadSpinHandle = setInterval(() => {
                const elapsed = Math.round((performance.now() - uploadStartMs) / 1000);
                // If we have a real progress label, splice the new
                // elapsed time in. Otherwise render a fallback so the
                // bar shows motion even before the first progress event.
                if (lastProgressLabel.includes('% (')) {
                  setProgressBar({
                    label: lastProgressLabel.replace(/,\s*\d+s\)$/, `, ${elapsed}s)`),
                  });
                } else {
                  setProgressBar({ label: `Uploading… (${elapsed}s)` });
                }
              }, 1000);
            }
          } else {
            setProgressBar({ label: `${stage}…` });
          }
        },
    });

    // Refresh the device dropdown's cached entry with whatever post-OTA
    // status we got back. Without this the dropdown keeps showing the
    // pre-upload version + partition until the next periodic scan, which
    // is confusing because the chip you just successfully OTA'd reads
    // as if nothing happened.
    if (result.post && result.post.version) {
      window.Conduit.updateKnownDevice(ip, {
        version:   result.post.version,
        partition: result.post.partition,
        mac:       result.post.mac,
        board_id:  result.post.board_id,
      });
    } else if (result.pre && result.pre.version) {
      // Rollback / unreachable: write the pre-state so the dropdown
      // still reflects what's actually running, not the (uncommitted)
      // attempted version.
      window.Conduit.updateKnownDevice(ip, {
        version:   result.pre.version,
        partition: result.pre.partition,
        mac:       result.pre.mac,
        board_id:  result.pre.board_id,
      });
    }

    switch (result.outcome) {
      case 'committed':
        setProgressBar({ pct: 100, kind: 'ok',
          label: `Committed ✓ v${result.post.version} on partition ${result.post.partition}` });
        logLine(`commit OK; running v${result.post.version} on ${result.post.partition}`);
        break;
      case 'rebooted':
        setProgressBar({ pct: 100, kind: 'ok',
          label: `Running v${result.post.version} on ${result.post.partition}` });
        logLine(`image now running at v${result.post.version}, ${result.post.partition}`);
        break;
      case 'rollback':
        setProgressBar({ kind: 'warn',
          label: `Rolled back — still on ${result.pre.partition}. New image booted but didn't commit.` });
        logLine('Image was written and briefly booted but reset before commit.');
        logLine('Most likely your code crashed early. Try the "Reset template" button or simplify your code.');
        break;
      case 'unreachable':
        setProgressBar({ kind: 'warn',
          label: 'Device did not respond — wedged or slow reboot.' });
        logLine('device did not come back — wedged or slow reboot');
        break;
      case 'error': {
        const msg = result.error.message || result.error;
        setProgressBar({ kind: 'err', label: `Error: ${msg}` });
        logLine(`error: ${msg}`);
        break;
      }
    }
    } finally {
      if (uploadSpinHandle) {
        clearInterval(uploadSpinHandle);
        uploadSpinHandle = null;
      }
      // Resume both streams. Mirrors the pause-at-upload-start above.
      // Runs on every exit path — build failure (early return), an
      // updateFirmware throw, or a clean outcome. resume() on an
      // already-running stream is a no-op (the early-return path
      // before the pause hits this), so the unconditional call is
      // safe. Order matters: console first so its streamLoop kicks
      // off; telemetry's resume re-arms its console-handoff gate, so
      // its first runStream open blocks until console reports a live
      // connection. The user prefers log lines surfacing first, then
      // the chart picking up.
      if (con && con.resumeStream) con.resumeStream();
      if (tlm && tlm.resume)       tlm.resume();
    }
  }

  // Build / upload progress bar — drives the #ide-upload-status footer
  // in the build-log pane. Used for the entire Build → Upload → Commit
  // flow so the user sees one continuous progress indicator instead of
  // a tiny status word in the topbar. Knobs:
  //   pct    — 0..100, the bar fill width (omit to keep current width)
  //   label  — short text under the bar (omit to keep)
  //   title  — hover-tooltip with the full text (the label may
  //            ellipsis-truncate at narrow widths; pass the full
  //            message here so the user can read it on hover). Pass
  //            null to clear, omit to keep.
  //   kind   — 'ok' | 'warn' | 'err' | undefined, sets the bar/text colour
  function setProgressBar({ pct, label, title, kind } = {}) {
    const status = document.getElementById('ide-upload-status');
    const bar = document.getElementById('ide-upload-bar');
    const msg = document.getElementById('ide-upload-msg');
    if (!status || !bar || !msg) return;
    status.classList.remove('hidden');
    if (pct != null)   bar.style.width = `${pct}%`;
    if (label != null) msg.textContent = label;
    if (title !== undefined) {
      if (title) msg.setAttribute('title', title);
      else       msg.removeAttribute('title');
    }
    const color = kind === 'err'  ? 'var(--red)'
                : kind === 'warn' ? 'var(--orange)'
                : kind === 'ok'   ? 'var(--green)'
                : '';
    bar.style.background = color;
    msg.style.color      = color;
  }

  // Pull a meaningful one-liner out of clang stderr so we can surface
  // it next to "Build failed" on the progress bar. Prefers static-
  // assertion messages — those carry our hand-written guidance like
  // "exceeded CONDUIT_TRANSMIT_MAX" — and falls back to the first
  // generic `error:` / `fatal error:` line. Returns null if stderr
  // has nothing useful (in which case the caller falls back to
  // e.message).
  function extractCompileError(stderr) {
    if (!stderr) return null;
    // Static-assertion: clang formats as
    //   error: static_assert failed: "MESSAGE"
    // or
    //   error: static assertion failed: "MESSAGE"
    // Inner quotes inside MESSAGE may be backslash-escaped — handle
    // both bare and \"escaped\" forms.
    const sa = stderr.match(
      /static[_\s]assert(?:ion)?\s*failed[:\s]*"((?:\\.|[^"\\])*)"/i);
    if (sa) return sa[1].replace(/\\(.)/g, '$1').trim();
    const fatal = stderr.match(/^[^\n]*?fatal error:\s*(.+)$/im);
    if (fatal) return fatal[1].trim();
    const err = stderr.match(/^[^\n]*?error:\s*(.+)$/im);
    if (err) return err[1].trim();
    return null;
  }

  // Squash a long error message down to its first sentence so it fits
  // alongside "Build failed —" on the one-line progress bar. Stops at
  // the first sentence-ending period (followed by whitespace) or em-
  // dash separator. The full text is still passed via the tooltip.
  function compactError(s) {
    if (!s) return s;
    let cut = s.length;
    const dot = s.search(/\.(?=\s)/);
    if (dot >= 0) cut = Math.min(cut, dot + 1);
    const dash = s.indexOf(' — ');
    if (dash >= 0) cut = Math.min(cut, dash);
    return s.slice(0, cut).trim();
  }

  // Map "where are we in the build phase" to bar pct via TIME, not via
  // per-stage budgets. The user's mental model is "0% at the first
  // event, 100% at the last" — a uniform progression. Per-stage
  // budgets fight this because the compiler fires multiple 0..100%
  // cycles under the same stage name (e.g. SDK fetch then SDK
  // unpack), which makes a high-water-based bar look stuck after the
  // first sub-phase pins it to that stage's end.
  //
  // Instead: anchor on elapsed time since the build started, paced
  // against the duration of the previous build (persisted to
  // localStorage). On the very first run we use a sensible cold-cache
  // estimate. The bar fills at a constant rate and the per-stage
  // label tells the user which phase is currently running.
  const BUILD_DURATION_KEY = 'conduit.lastBuildMs';
  const BUILD_DURATION_DEFAULT_MS = 30_000;   // typical cold-cache run
  let buildStartMs = 0;
  let estimatedBuildMs = BUILD_DURATION_DEFAULT_MS;
  try {
    const saved = Number(localStorage.getItem(BUILD_DURATION_KEY));
    if (Number.isFinite(saved) && saved > 1000) estimatedBuildMs = saved;
  } catch (_) {}

  function resetBuildBar() {
    buildStartMs = Date.now();
  }
  // Compute the bar pct for an in-flight build event. Returns a value
  // in [0, 49] so we leave a tiny gap for the "Built …" success state
  // to push to 50 (the boundary between build and upload halves).
  function buildPct() {
    if (!buildStartMs) return 0;
    const elapsed = Date.now() - buildStartMs;
    const frac = elapsed / estimatedBuildMs;
    return Math.min(49, frac * 50);
  }
  // Record the actual duration so the next build's pacing improves.
  function recordBuildDuration() {
    if (!buildStartMs) return;
    const dur = Date.now() - buildStartMs;
    if (dur < 1000) return;
    estimatedBuildMs = dur;
    try { localStorage.setItem(BUILD_DURATION_KEY, String(dur)); } catch (_) {}
  }

  // Connection-flavoured status (probe / reconnect / scan results).
  // Routed into the runtime console pane instead of the topbar chip
  // so old messages scroll away naturally — "no response from X"
  // doesn't linger after the next attempt succeeds. The topbar chip
  // is kept clear of connection content; build/upload progress still
  // uses setStatus.
  function connStatus(text, kind) {
    const con = window.Conduit && window.Conduit.console;
    if (con && con.note) con.note(text, kind);
    else console.log('[conn]', text);
  }

  function logLine(s) {
    const el = document.getElementById('ide-log');
    el.textContent += (el.textContent ? '\n' : '') + s;
    el.scrollTop = el.scrollHeight;
  }

  function clearLog() {
    document.getElementById('ide-log').textContent = '';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initIde);
  } else {
    initIde();
  }
})();
