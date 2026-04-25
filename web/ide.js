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
#include "pico_poe_user.h"   // log(), transmit(), poe_command_register()

#define LED_PIN 25

// Runs once after boot. Wire up your pins + peripherals here.
void pico_poe_setup(void) {
    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);
    log("hello from pico_poe_setup()\\n");
}

// Runs at 1 kHz on core 0. Keep it fast — heavy work starves the network
// stack running on core 1.
//
// log() prints to the runtime console pane.
// transmit() streams numeric data to the live chart pane (and IndexedDB).
// Names are UPPER_SNAKE_CASE and auto-register on first call.
void pico_poe_loop(void) {
    static uint32_t ticks = 0;
    static bool led_on = false;
    ticks++;

    // Blink: toggle the LED every ~500 ms.
    if (ticks % 500 == 0) {
        led_on = !led_on;
        gpio_put(LED_PIN, led_on);
        log("tick=%u, led=%s\\n", ticks, led_on ? "on" : "off");
    }

    // Stream a sine wave to the chart pane — one F32 sample per tick.
    F32 sin_val;
    sin_val[0] = sinf((float)ticks * 0.01f);
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
  const SOURCE_STORAGE_KEY = 'picopoe_source_v2';
  const TEMPLATE_VERSION = 3;

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
    if (window.PicoPoE && window.PicoPoE.editor && window.PicoPoE.editor.setSource) {
      window.PicoPoE.editor.setSource(BLINK_TEMPLATE);
    }
    persistSource(BLINK_TEMPLATE);
    logLine('Editor reset to default template.');
  }

  async function ensureEditor() {
    if (editorMounted) return;
    editorMounted = true;
    const api = window.PicoPoE && window.PicoPoE.editor;
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

  function initIde() {
    console.log('[ide.js] demo polish; v=' +
                (window.PICOPOE_ASSET_VERSION || 'unknown'));

    const deviceSelect = document.getElementById('ide-device-select');
    const rescanBtn = document.getElementById('ide-rescan-btn');
    const token = document.getElementById('ide-auth-token');

    // Restore persisted token + device selection.
    try {
      const s = JSON.parse(localStorage.getItem('picopoe') || '{}');
      if (s.token) token.value = s.token;
    } catch (_) {}

    const persist = () => {
      try {
        const s = JSON.parse(localStorage.getItem('picopoe') || '{}');
        s.ide_ip = deviceSelect.value;
        s.token = token.value;
        localStorage.setItem('picopoe', JSON.stringify(s));
      } catch (_) {}
    };
    deviceSelect.addEventListener('change', () => {
      persist();
      // Let the console tear down its cursor so the next poll gets the
      // current-cursor reset of the newly-selected device.
      if (window.PicoPoE && window.PicoPoE.console) {
        window.PicoPoE.console.resetCursor();
        window.PicoPoE.console.clear();
      }
    });
    token.addEventListener('change', persist);

    // Populate the dropdown from the last scan's results.
    function refreshDeviceList() {
      const prevValue = deviceSelect.value || (() => {
        try { return JSON.parse(localStorage.getItem('picopoe') || '{}').ide_ip || ''; }
        catch (_) { return ''; }
      })();
      const known = (window.PicoPoE && typeof window.PicoPoE.getKnownDevices === 'function')
        ? window.PicoPoE.getKnownDevices() : [];
      deviceSelect.innerHTML = '';
      if (known.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(no device — Add or Scan)';
        deviceSelect.appendChild(opt);
      } else {
        for (const d of known) {
          const opt = document.createElement('option');
          opt.value = d.ip;
          const parts = [d.ip];
          if (d.version) parts.push(`v${d.version}`);
          if (d.partition) parts.push(d.partition);
          opt.textContent = parts.join(' — ');
          deviceSelect.appendChild(opt);
        }
        const match = Array.from(deviceSelect.options).find((o) => o.value === prevValue);
        deviceSelect.value = match ? prevValue : known[0].ip;
      }
    }
    refreshDeviceList();
    window.addEventListener('picopoe:devices-updated', refreshDeviceList);

    // Rescan button: scan the /24 of the currently-known or quick IP.
    rescanBtn.addEventListener('click', async () => {
      let subnet = document.getElementById('subnet').value.trim();
      if (!subnet) {
        const quick = document.getElementById('ide-quick-ip').value.trim();
        const known = window.PicoPoE.getKnownDevices();
        if (quick && quick.split('.').length >= 3) {
          subnet = quick.split('.').slice(0, 3).join('.');
        } else if (known.length && known[0].ip) {
          subnet = known[0].ip.split('.').slice(0, 3).join('.');
        } else {
          subnet = window.prompt('Subnet to scan (e.g. 192.168.178):', '192.168.1') || '';
          if (!subnet) return;
        }
        document.getElementById('subnet').value = subnet;
      }
      rescanBtn.disabled = true;
      setStatus(`Scanning ${subnet}.0/24…`);
      try {
        const found = await window.PicoPoE.startScan({ subnet });
        setStatus(`${found.length} device(s)`);
      } catch (e) {
        setStatus(`scan error: ${e.message || e}`, 'err');
      } finally {
        rescanBtn.disabled = false;
        refreshDeviceList();
      }
    });

    // Add-by-IP button: probe a single host. Faster than /24 scan.
    const quickBtn = document.getElementById('ide-quick-connect');
    const quickInput = document.getElementById('ide-quick-ip');
    quickBtn.addEventListener('click', async () => {
      const ip = quickInput.value.trim();
      if (!ip) { setStatus('enter an IP first', 'err'); return; }
      quickBtn.disabled = true;
      setStatus(`Probing ${ip}…`);
      try {
        const result = await window.PicoPoE.probeAndRemember(ip);
        if (result) {
          setStatus(`Added ${ip} (v${result.version}, ${result.partition})`);
          deviceSelect.value = ip;
          persist();
        } else {
          setStatus(`no response from ${ip}`, 'err');
        }
      } catch (e) {
        setStatus(`error: ${e.message || e}`, 'err');
      } finally {
        quickBtn.disabled = false;
        refreshDeviceList();
      }
    });

    document.getElementById('ide-btn-build').addEventListener('click', onBuild);
    document.getElementById('ide-btn-build-upload').addEventListener('click', onBuildUpload);

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
    if (window.PicoPoE && window.PicoPoE.editor && window.PicoPoE.editor.onChange) {
      window.PicoPoE.editor.onChange(() => {
        clearTimeout(persistSrcTimer);
        persistSrcTimer = setTimeout(() => {
          try {
            const src = window.PicoPoE.editor.getSource();
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
    const api = window.PicoPoE || {};
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
    setStatus('Building…');
    try {
      const uf2 = await buildUf2({ version: nextStampedVersion() });
      const blob = new Blob([uf2], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'pico_poe_app.uf2';
      a.click();
      URL.revokeObjectURL(url);
      logLine(`built ${uf2.byteLength} bytes, ${uf2.byteLength / 512} UF2 blocks`);
      setStatus(`Built ${uf2.byteLength} B.`);
    } catch (e) {
      if (e.stderr) logLine(e.stderr.trim());
      logLine(`error: ${e.message}`);
      setStatus(`Build failed`, 'err');
    }
  }

  async function onBuildUpload() {
    const ip = document.getElementById('ide-device-select').value.trim();
    const token = document.getElementById('ide-auth-token').value;
    if (!ip) {
      setStatus('Pick a device (Add or Scan).', 'err');
      return;
    }
    if (!token) {
      setStatus('Auth token is empty.', 'err');
      return;
    }

    clearLog();
    setStatus('Building…');

    const stampVer = nextStampedVersion();
    try {
      const pre = await window.PicoPoE.getStatus(ip);
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
      setStatus('Build failed', 'err');
      return;
    }
    logLine(`built ${uf2.byteLength} bytes`);

    const statusDiv = document.getElementById('ide-upload-status');
    const bar = document.getElementById('ide-upload-bar');
    const msg = document.getElementById('ide-upload-msg');
    statusDiv.classList.remove('hidden');
    bar.style.width = '0%';
    bar.style.background = '';
    msg.style.color = '';
    msg.textContent = 'Uploading…';
    setStatus('Uploading…');

    const result = await window.PicoPoE.updateFirmware({
      ip, token, data: uf2,
      onProgress: ({ pct, loaded, total }) => {
        bar.style.width = `${pct}%`;
        msg.textContent = `Uploading… ${Math.round(pct)}% (${loaded}/${total} B)`;
      },
      onStage: (stage, detail) => {
        logLine(detail && typeof detail === 'string' ? `[${stage}] ${detail}` : `[${stage}]`);
        if (stage === 'precheck') msg.textContent = 'Checking device…';
        else if (stage === 'waiting') msg.textContent = `Waiting for reboot… ${typeof detail === 'string' ? detail : ''}`;
        else if (stage === 'verifying') msg.textContent = 'Verifying…';
        else if (stage === 'commit') msg.textContent = 'Committing (TBYB)…';
      },
    });

    // After a reboot the device's log cursor resets, so tell the console
    // to forget its cursor and re-seed to "now" on the next poll.
    if (window.PicoPoE && window.PicoPoE.console) {
      window.PicoPoE.console.resetCursor();
    }

    switch (result.outcome) {
      case 'committed':
        bar.style.width = '100%'; bar.style.background = 'var(--green)'; msg.style.color = 'var(--green)';
        msg.textContent = `Committed ✓ v${result.post.version} on partition ${result.post.partition}`;
        logLine(`commit OK; running v${result.post.version} on ${result.post.partition}`);
        setStatus('Committed.');
        break;
      case 'rebooted':
        bar.style.width = '100%'; bar.style.background = 'var(--green)'; msg.style.color = 'var(--green)';
        msg.textContent = `Running v${result.post.version} on ${result.post.partition}`;
        logLine(`image now running at v${result.post.version}, ${result.post.partition}`);
        setStatus('Done.');
        break;
      case 'rollback':
        bar.style.background = 'var(--orange)'; msg.style.color = 'var(--orange)';
        msg.textContent = `Rolled back — still on ${result.pre.partition}. The new image booted but didn't commit (probably crashed in setup/loop).`;
        logLine('Image was written and briefly booted but reset before commit.');
        logLine('Most likely your code crashed early. Try the "Reset template" button or simplify your code.');
        setStatus('Rolled back', 'err');
        break;
      case 'unreachable':
        bar.style.background = 'var(--orange)'; msg.style.color = 'var(--orange)';
        msg.textContent = 'Device did not respond; power-cycle to roll back.';
        logLine('device did not come back — wedged or slow reboot');
        setStatus('Unreachable', 'err');
        break;
      case 'error':
        bar.style.background = 'var(--red)'; msg.style.color = 'var(--red)';
        msg.textContent = `Error: ${result.error.message || result.error}`;
        logLine(`error: ${result.error.message || result.error}`);
        setStatus('Upload failed', 'err');
        break;
    }
  }

  function setStatus(text, kind) {
    const el = document.getElementById('ide-status');
    el.textContent = text;
    el.style.color = kind === 'err' ? 'var(--red)'
                   : kind === 'ok'  ? 'var(--green)'
                   : '';
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
