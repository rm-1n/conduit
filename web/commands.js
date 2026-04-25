// commands.js — POST /api/cmd?name=...&k=v... client + telemetry-pane
// command strip wiring. Reuses the topbar token and device IP.
//
// Public:
//   await window.PicoPoE.cmd.send(name, args)
//     Returns the parsed JSON response object on success, throws on
//     network/HTTP error.

(function () {
  'use strict';

  function getIp() {
    try {
      const sel = document.getElementById('ide-device-select');
      if (sel && sel.value) return sel.value;
      const fallback = document.getElementById('ide-quick-ip');
      return fallback && fallback.value.trim() ? fallback.value.trim() : null;
    } catch (_) { return null; }
  }

  function getToken() {
    const el = document.getElementById('ide-auth-token');
    return el ? el.value || '' : '';
  }

  function buildQuery(name, args) {
    const parts = [`name=${encodeURIComponent(name)}`];
    if (args && typeof args === 'object') {
      for (const k of Object.keys(args)) {
        const v = args[k];
        if (v == null) continue;
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
    }
    return parts.join('&');
  }

  async function send(name, args) {
    const ip = getIp();
    if (!ip) throw new Error('no device selected');
    const tok = getToken();
    const url = `http://${ip}/api/cmd?${buildQuery(name, args)}`;
    const res = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      headers: tok ? { 'X-Auth-Token': tok } : {},
    });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok) {
      const err = body && body.error ? body.error : `HTTP ${res.status}`;
      throw new Error(err);
    }
    return body;
  }

  // -- DOM wiring ---------------------------------------------------------

  let log = null;
  let pinEl = null;
  let valEl = null;
  let advNameEl = null;
  let advArgsEl = null;

  function reportOK(msg) {
    if (!log) return;
    log.textContent = msg;
    log.style.color = 'var(--green)';
  }
  function reportErr(msg) {
    if (!log) return;
    log.textContent = msg;
    log.style.color = 'var(--red)';
  }

  function pin() { return Number(pinEl && pinEl.value) || 0; }

  async function safeSend(name, args, label) {
    try {
      const body = await send(name, args);
      reportOK(`${label}: ${JSON.stringify(body.result || body)}`);
    } catch (e) {
      reportErr(`${label} failed: ${e.message || e}`);
    }
  }

  function parseAdvArgs(s) {
    const out = {};
    if (!s) return out;
    for (const pair of s.split(/[,&]/)) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return out;
  }

  function init() {
    log = document.getElementById('ide-cmd-log');
    pinEl = document.getElementById('ide-cmd-pin');
    valEl = document.getElementById('ide-cmd-val');
    advNameEl = document.getElementById('ide-cmd-adv-name');
    advArgsEl = document.getElementById('ide-cmd-adv-args');

    const wire = (id, fn) => {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', fn);
    };

    wire('ide-cmd-init-out',  () => safeSend('gpio_init',   { pin: pin(), dir: 'out' }, `gpio_init pin=${pin()} out`));
    wire('ide-cmd-init-in',   () => safeSend('gpio_init',   { pin: pin(), dir: 'in'  }, `gpio_init pin=${pin()} in`));
    wire('ide-cmd-write-1',   () => safeSend('gpio_write',  { pin: pin(), value: 1 }, `gpio_write pin=${pin()}=1`));
    wire('ide-cmd-write-0',   () => safeSend('gpio_write',  { pin: pin(), value: 0 }, `gpio_write pin=${pin()}=0`));
    wire('ide-cmd-toggle',    () => safeSend('gpio_toggle', { pin: pin() },           `gpio_toggle pin=${pin()}`));
    wire('ide-cmd-read',      () => safeSend('gpio_read',   { pin: pin() },           `gpio_read pin=${pin()}`));
    wire('ide-cmd-adv-send',  () => {
      const n = (advNameEl && advNameEl.value || '').trim();
      if (!n) { reportErr('command name required'); return; }
      safeSend(n, parseAdvArgs(advArgsEl && advArgsEl.value), n);
    });

    window.PicoPoE = window.PicoPoE || {};
    window.PicoPoE.cmd = { send };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
