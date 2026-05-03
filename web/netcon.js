// netcon.js — Telemetry console (lives inside the telemetry pane).
//
// File name kept as `netcon.js` and public API kept as Conduit.netcon
// for stability — the visible label changed from "Network console" to
// "Telemetry console" once the pane moved into the telemetry column.
//
// A unified browser-side event log for things the user does THROUGH the
// IDE (cmd dispatches, OTA-export downloads, etc.) — separate from the
// runtime console which streams the firmware's printf() output.
//
// Why split: runtime console = device→browser; network console =
// browser→device + browser-local IDE actions. Mixing them obscures the
// "what did I just do" question with the "what is the firmware saying"
// question and vice versa.
//
// Public surface:
//
//   Conduit.netcon.info(msg)   — neutral entry (e.g. "Saved file …")
//   Conduit.netcon.ok(msg)     — green success
//   Conduit.netcon.err(msg)    — red error
//   Conduit.netcon.clear()     — wipe history
//
// Same scrollback semantics as the cmd-log strip: capped at MAX_ENTRIES,
// auto-scrolls to bottom unless the user has manually scrolled up.

(function () {
  'use strict';

  const MAX_ENTRIES = 500;

  let pane = null;
  let body = null;
  let stateEl = null;

  function ensureDom() {
    if (body) return body;
    pane = document.getElementById('ide-netcon');
    body = document.getElementById('ide-netcon-body');
    stateEl = document.getElementById('ide-netcon-state');
    if (!body) return null;
    const clearBtn = document.getElementById('ide-netcon-clear');
    if (clearBtn) clearBtn.addEventListener('click', clear);
    const icons = window.Conduit && window.Conduit.icons;
    if (icons && clearBtn) icons.set(clearBtn, 'delete', { size: 14 });
    return body;
  }

  function append(msg, kind) {
    const el = ensureDom();
    if (!el) return;
    const wasAtBottom =
      (el.scrollTop + el.clientHeight) >= (el.scrollHeight - 2);
    const entry = document.createElement('div');
    entry.className = 'netcon-entry' + (kind ? ' ' + kind : '');
    const ts = document.createElement('span');
    ts.className = 'netcon-ts';
    const d = new Date();
    ts.textContent =
      String(d.getHours()).padStart(2, '0')   + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
    entry.appendChild(ts);
    entry.appendChild(document.createTextNode(' ' + String(msg)));
    el.appendChild(entry);
    while (el.children.length > MAX_ENTRIES) el.removeChild(el.firstChild);
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
    if (stateEl) {
      stateEl.textContent = `${el.children.length} event${el.children.length === 1 ? '' : 's'}`;
    }
  }

  function clear() {
    const el = ensureDom();
    if (!el) return;
    el.textContent = '';
    if (stateEl) stateEl.textContent = '0 events';
  }

  function info(msg) { append(msg, 'info'); }
  function ok  (msg) { append(msg, 'ok'); }
  function err (msg) { append(msg, 'err'); }

  // Live progress entry — single row with a fill bar that updates in
  // place as the caller posts new percentages. Callers receive a
  // controller they can update/done/fail on. Use for long-running
  // operations (HDF5 export, future plant-runner test runs, etc).
  //
  //   const p = Conduit.netcon.progress('Exporting');
  //   p.update(25, 'reading telemetry…');
  //   p.update(75, 'building HDF5…');
  //   p.done('Saved foo.h5');         // turns green
  //   p.fail('Disk full');            // turns red
  function progress(label) {
    const el = ensureDom();
    if (!el) return { update() {}, done() {}, fail() {} };
    const wasAtBottom =
      (el.scrollTop + el.clientHeight) >= (el.scrollHeight - 2);
    const entry = document.createElement('div');
    entry.className = 'netcon-entry netcon-progress info';
    const ts = document.createElement('span');
    ts.className = 'netcon-ts';
    const d = new Date();
    ts.textContent =
      String(d.getHours()).padStart(2, '0')   + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
    const text = document.createElement('span');
    text.className = 'netcon-progress-text';
    text.textContent = ' ' + label + '… 0%';
    const bar = document.createElement('div');
    bar.className = 'netcon-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'netcon-progress-fill';
    bar.appendChild(fill);
    entry.appendChild(ts);
    entry.appendChild(text);
    entry.appendChild(bar);
    el.appendChild(entry);
    while (el.children.length > MAX_ENTRIES) el.removeChild(el.firstChild);
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
    if (stateEl) {
      stateEl.textContent = `${el.children.length} event${el.children.length === 1 ? '' : 's'}`;
    }

    let lastLabel = label;
    return {
      update(pct, sublabel) {
        if (sublabel) lastLabel = sublabel;
        const p = Math.max(0, Math.min(100, Number(pct) || 0));
        fill.style.width = p.toFixed(1) + '%';
        text.textContent = ' ' + lastLabel + '… ' + p.toFixed(0) + '%';
      },
      done(msg) {
        entry.classList.remove('info'); entry.classList.add('ok');
        bar.style.display = 'none';
        text.textContent = ' ' + (msg || (lastLabel + ' done'));
      },
      fail(msg) {
        entry.classList.remove('info'); entry.classList.add('err');
        bar.style.display = 'none';
        text.textContent = ' ' + (msg || (lastLabel + ' failed'));
      },
    };
  }

  // Hydrate on load so the icons are correct from the start.
  function init() { ensureDom(); }

  window.Conduit = window.Conduit || {};
  window.Conduit.netcon = { info, ok, err, clear, progress };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
