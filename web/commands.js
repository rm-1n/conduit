// commands.js — POST /api/cmd?name=...&k=v... client + telemetry-pane
// command strip wiring. Reuses the topbar token and device IP.
//
// Public:
//   await window.Conduit.cmd.send(name, args)
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

  // Expose pure helpers up-front so unit tests can grab them without
  // also booting the DOM-bound init() path. The full surface (send +
  // preset CRUD) is added in init() once the DOM is ready.
  window.Conduit = window.Conduit || {};
  window.Conduit.cmd = window.Conduit.cmd || {};
  window.Conduit.cmd.buildQuery = buildQuery;

  async function send(name, args) {
    if (!getIp()) throw new Error('no device selected');
    const stream = window.Conduit && window.Conduit.stream;
    if (!stream) throw new Error('stream transport unavailable');
    if (!stream.isConnected()) throw new Error('stream not connected — wait for the device, then retry');
    // stream.cmd resolves with {seq, ok: true, result: ...} on success,
    // rejects with Error(<server error>) on ok=false. The reply shape
    // matches what the old HTTP path produced so existing call sites
    // (safeSend / reportOK / firePreset) don't need changes.
    return await stream.cmd(name, args);
  }

  // -- DOM wiring ---------------------------------------------------------

  let advNameEl = null;
  let advArgsEl = null;

  // Command outcomes go to the telemetry console. The previous inline
  // single-line cmd-log strip was redundant once the telemetry console
  // landed at the bottom of the same pane.
  function reportOK(msg) {
    const nc = window.Conduit && window.Conduit.netcon;
    if (nc) nc.ok(msg);
  }
  function reportErr(msg) {
    const nc = window.Conduit && window.Conduit.netcon;
    if (nc) nc.err(msg);
  }

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
    const trimmed = s.trim();
    // Bare-value shortcut for typed cmds — `0.1` becomes `value=0.1`.
    // The on_command() dispatcher always reads from the `value` query
    // key, so this is the natural one-arg case. Without this fold, the
    // firmware's conduit_cmd_arg_* falls back to 0/0.0 and the cmd silently
    // does the opposite of what the user typed.
    if (trimmed && !/[=,&]/.test(trimmed)) {
      return { value: trimmed };
    }
    for (const pair of s.split(/[,&]/)) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return out;
  }
  window.Conduit.cmd.parseAdvArgs = parseAdvArgs;

  // -- Editable persistent command presets ---------------------------
  //
  // Stored in localStorage as conduit.cmdPresets — an array of
  // { label, name, args } objects. `args` is the raw query-string
  // fragment a user would type into the cmd-strip's args field
  // (e.g. "0.1" or "value=0.5,k=v"); we run it through parseAdvArgs
  // when firing so the same shortcuts (bare value etc.) apply.
  //
  // Presets are global (not per-device) on purpose: most users have
  // one device they're iterating against, and per-device storage just
  // means re-creating the same buttons after every reflash. If we
  // need per-device later, key on (board_id, label) instead.

  const PRESETS_KEY = 'conduit.cmdPresets';
  let presetsEl = null;

  function loadPresets() {
    try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]'); }
    catch (_) { return []; }
  }
  function savePresets(arr) {
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(arr)); }
    catch (_) {}
  }

  function renderPresets() {
    if (!presetsEl) return;
    const icons = window.Conduit && window.Conduit.icons;
    const presets = loadPresets();
    presetsEl.innerHTML = '';
    presets.forEach((p, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'cmd-preset';
      wrap.dataset.idx = String(idx);

      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'cmd-preset-send';
      sendBtn.textContent = p.label || p.name;
      sendBtn.title = `Send ${p.name}${p.args ? ' ' + p.args : ''}`;
      sendBtn.addEventListener('click', () => firePreset(p));

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'cmd-preset-edit btn-icon';
      editBtn.title = 'Edit preset';
      editBtn.setAttribute('aria-label', 'Edit preset');
      if (icons) editBtn.innerHTML = icons.svg('edit', { size: 12 });
      editBtn.addEventListener('click', () => beginEdit(idx));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'cmd-preset-delete btn-icon';
      delBtn.title = 'Delete preset';
      delBtn.setAttribute('aria-label', 'Delete preset');
      if (icons) delBtn.innerHTML = icons.svg('delete', { size: 12 });
      delBtn.addEventListener('click', () => {
        const arr = loadPresets();
        arr.splice(idx, 1);
        savePresets(arr);
        renderPresets();
      });

      wrap.appendChild(sendBtn);
      wrap.appendChild(editBtn);
      wrap.appendChild(delBtn);
      presetsEl.appendChild(wrap);
    });

    // "+" — add a new preset (opens an inline form pre-filled from
    // whatever's currently typed in the cmd row, so the workflow is
    // "test the cmd, then save it").
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn-ghost btn-mini cmd-preset-add btn-icon';
    addBtn.title = 'Add preset from current Cmd fields';
    addBtn.setAttribute('aria-label', 'Add command preset');
    if (icons) addBtn.innerHTML = icons.svg('add', { size: 14 });
    addBtn.addEventListener('click', () => {
      const name = (advNameEl && advNameEl.value || '').trim();
      const args = (advArgsEl && advArgsEl.value || '').trim();
      beginAdd({ label: name || 'preset', name, args });
    });
    presetsEl.appendChild(addBtn);
  }

  function firePreset(p) {
    if (!p || !p.name) { reportErr('preset has no name'); return; }
    safeSend(p.name, parseAdvArgs(p.args || ''), p.label || p.name);
  }

  function beginEdit(idx) { openForm(idx, loadPresets()[idx]); }
  function beginAdd(seed) { openForm(-1,  seed || { label: '', name: '', args: '' }); }

  // Inline editor — replaces the preset chip (or the + button) with a
  // small form. Save updates the array; cancel re-renders untouched.
  function openForm(idx, preset) {
    if (!presetsEl) return;
    const icons = window.Conduit && window.Conduit.icons;
    const wrap = document.createElement('div');
    wrap.className = 'cmd-preset editing';
    wrap.innerHTML = `
      <input type="text" class="preset-label" placeholder="label" value="${escapeAttr(preset.label || '')}" style="width:6em">
      <input type="text" class="preset-name"  placeholder="cmd name" value="${escapeAttr(preset.name || '')}" style="width:8em">
      <input type="text" class="preset-args"  placeholder="args (0.1 or k=v,k=v)" value="${escapeAttr(preset.args || '')}" style="width:11em">
    `;
    const ok     = document.createElement('button');
    ok.type = 'button'; ok.className = 'btn-icon'; ok.title = 'Save';
    ok.setAttribute('aria-label', 'Save preset');
    if (icons) ok.innerHTML = icons.svg('check', { size: 12 });
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn-icon'; cancel.title = 'Cancel';
    cancel.setAttribute('aria-label', 'Cancel');
    if (icons) cancel.innerHTML = icons.svg('close', { size: 12 });
    wrap.appendChild(ok);
    wrap.appendChild(cancel);

    // Replace the existing chip (if editing) or insert before the +
    // button (if adding a new one).
    const all = presetsEl.querySelectorAll('.cmd-preset, .cmd-preset-add');
    if (idx >= 0 && all[idx]) {
      presetsEl.replaceChild(wrap, all[idx]);
    } else {
      const addBtn = presetsEl.querySelector('.cmd-preset-add');
      presetsEl.insertBefore(wrap, addBtn);
    }
    wrap.querySelector('.preset-label').focus();

    const commit = () => {
      const next = {
        label: wrap.querySelector('.preset-label').value.trim(),
        name:  wrap.querySelector('.preset-name').value.trim(),
        args:  wrap.querySelector('.preset-args').value.trim(),
      };
      if (!next.name) { reportErr('preset needs a cmd name'); return; }
      const arr = loadPresets();
      if (idx >= 0) arr[idx] = next;
      else arr.push(next);
      savePresets(arr);
      renderPresets();
    };
    ok.addEventListener('click', commit);
    cancel.addEventListener('click', renderPresets);
    // Enter on any input commits; Escape cancels.
    wrap.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { ev.preventDefault(); renderPresets(); }
      });
    });
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function init() {
    advNameEl = document.getElementById('ide-cmd-adv-name');
    advArgsEl = document.getElementById('ide-cmd-adv-args');
    presetsEl = document.getElementById('ide-cmd-presets');

    const sendBtn = document.getElementById('ide-cmd-adv-send');
    if (sendBtn) sendBtn.addEventListener('click', () => {
      const n = (advNameEl && advNameEl.value || '').trim();
      if (!n) { reportErr('command name required'); return; }
      safeSend(n, parseAdvArgs(advArgsEl && advArgsEl.value), n);
    });

    renderPresets();

    window.Conduit = window.Conduit || {};
    // Extend (don't replace) — the early-exposed pure helpers
    // (buildQuery, parseAdvArgs) must survive init() so unit/test
    // harnesses can reach them.
    Object.assign(window.Conduit.cmd = window.Conduit.cmd || {}, {
      send,
      // Programmatic surface for adding presets from elsewhere (test
      // harness, future "save current cmd" hotkey, etc.).
      addPreset(p) {
        const arr = loadPresets();
        arr.push({ label: String(p.label || p.name || ''),
                   name:  String(p.name || ''),
                   args:  String(p.args || '') });
        savePresets(arr);
        renderPresets();
      },
      listPresets: loadPresets,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
