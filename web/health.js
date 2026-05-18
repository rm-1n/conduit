// health.js — device reachability LED.
//
// Independently polls /api/status to drive the device-connectivity LED
// (`#ide-device-led`), decoupled from telemetry/console stream state.
// Rationale: the LED previously mirrored `#ide-telemetry-state`, which
// is "stream is currently delivering bytes" — strictly tighter than
// "device responds to HTTP". After a reboot the device may answer
// /api/status in ~300 ms while the telemetry stream takes seconds to
// re-handshake; the user saw 8-10 s of false-red. This module's signal
// is the cheap one and drives the LED on its own cadence.
//
// State machine + LED `data-state` mapping:
//   ok    — last probe within HEALTHY_MS, returned 200          → green
//   warn  — last probe in flight or last ok 8-15 s old           → amber
//   err   — last probe failed (timeout, connection, non-200)     → red
//   off   — no IP or pause()d                                     → off
//
// Cadence: PROBE_INTERVAL_OK_MS while healthy, PROBE_INTERVAL_ERR_MS
// while degraded (fast recovery). One probe in flight at a time —
// the `inflight` guard means a slow probe doesn't pile up requests.
//
// Pause/resume: ide.js calls health.pause() / health.resume() around the
// OTA upload window — same discipline as telemetry/console — so this
// module isn't competing with the upload for the device's mbedtls
// cycles during the busy phase. upload.js's waitForDevice() also calls
// health.notifyReachable() the moment the device starts answering
// post-reboot, which short-circuits the LED to green without waiting
// for our own probe interval.

(function () {
  'use strict';

  // Steady-state cadence when the device is healthy. 5 s keeps the
  // LED responsive to a cable yank without flooding the device.
  const PROBE_INTERVAL_OK_MS  = 5000;
  // Recovery cadence after a failure. 750 ms means red→green within
  // one cycle of the device coming back, while still leaving room for
  // a 2.5 s probe-timeout-bounded retry without piling up.
  const PROBE_INTERVAL_ERR_MS = 750;
  // Per-probe timeout. Smaller than upload.js's 6 s `getStatus`
  // because this is a UI-driving signal — we want fast failure on a
  // dead device, not patient retries.
  const PROBE_TIMEOUT_MS      = 2500;
  // After this long since the last 200, transition ok → warn even if
  // a probe is in flight. The LED briefly amber before going green
  // again (probe success) or red (probe fail).
  const HEALTHY_MS            = 8000;

  let stopped = false;
  let paused = false;
  let getIp = () => null;
  let ledEl = null;
  let probeHandle = null;          // setTimeout id (we re-schedule, not setInterval)
  let inflight = false;            // single-probe coalesce guard
  let lastOkMs = 0;                // performance.now() of last 200 response
  let lastState = 'off';
  let currentAbort = null;

  function setLedState(state) {
    if (state === lastState) return;
    lastState = state;
    if (ledEl) ledEl.setAttribute('data-state', state);
  }

  // Decide the LED state from current values. Pure function of the
  // probe result + freshness — gives the caller a single place to
  // edit the policy.
  function deriveState(result) {
    if (paused || stopped) return 'off';
    if (!getIp()) return 'off';
    if (result === 'ok') return 'ok';
    if (result === 'err') return 'err';
    // result === 'pending' — no fresh observation yet
    const age = performance.now() - lastOkMs;
    if (lastOkMs === 0) return 'err';     // never been healthy
    if (age < HEALTHY_MS) return 'ok';
    return 'warn';
  }

  async function probe() {
    if (inflight || stopped || paused) return;
    const ip = getIp();
    if (!ip) { setLedState('off'); return; }
    inflight = true;
    setLedState(deriveState('pending'));
    const ctrl = new AbortController();
    currentAbort = ctrl;
    const to = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const url = (window.Conduit && window.Conduit.deviceUrlForIp)
        ? window.Conduit.deviceUrlForIp(ip, '/api/status')
        : `http://${ip}/api/status`;
      const res = await fetch(url, {
        mode: 'cors', cache: 'no-store', signal: ctrl.signal,
      });
      clearTimeout(to);
      if (res.ok) {
        lastOkMs = performance.now();
        setLedState(deriveState('ok'));
        schedule(PROBE_INTERVAL_OK_MS);
      } else {
        setLedState(deriveState('err'));
        schedule(PROBE_INTERVAL_ERR_MS);
      }
    } catch (_) {
      clearTimeout(to);
      setLedState(deriveState('err'));
      schedule(PROBE_INTERVAL_ERR_MS);
    } finally {
      inflight = false;
      currentAbort = null;
    }
  }

  function schedule(ms) {
    if (probeHandle) clearTimeout(probeHandle);
    if (stopped || paused) return;
    probeHandle = setTimeout(probe, ms);
  }

  function init(opts) {
    ledEl = document.getElementById('ide-device-led');
    getIp = (opts && opts.getIp) || (() => null);
    setLedState('off');
    // Probe immediately on init so the LED reflects state without
    // waiting for the first interval — useful when the IDE loads with
    // an IP already in the picker (from localStorage).
    probe();
  }

  window.Conduit = window.Conduit || {};
  window.Conduit.health = {
    // Lifecycle hooks called by ide.js around the OTA upload window
    // so we stop probing while the device is busy with the upload's
    // TLS handshake/decrypt work — mirrors tlm.pause/resume on
    // telemetry.js and con.pauseStream/resumeStream on console.js.
    pause() {
      if (paused) return;
      paused = true;
      if (currentAbort) { try { currentAbort.abort(); } catch (_) {} }
      if (probeHandle) { clearTimeout(probeHandle); probeHandle = null; }
      setLedState('off');
    },
    // True iff a probe's fetch is currently in flight. ide.js polls
    // this after pause() to wait for the abort to actually propagate
    // through the browser's network stack — `inflight` flips to false
    // in the probe()'s finally block, which only runs once the abort
    // has settled.
    isInflight() { return inflight; },
    resume() {
      if (!paused) return;
      paused = false;
      // Reset the freshness clock so we don't immediately claim 'ok'
      // from a stale lastOkMs that predates the pause window.
      lastOkMs = 0;
      // Probe right away so the LED gets a fresh datapoint instead of
      // waiting up to PROBE_INTERVAL_ERR_MS.
      probe();
    },
    // upload.js calls this from waitForDevice the moment the device
    // starts answering status post-reboot — short-circuit the LED to
    // green without waiting for our own probe cycle. Idempotent.
    notifyReachable() {
      if (stopped) return;
      lastOkMs = performance.now();
      // Only override the LED if we're not paused (during the upload
      // window) — notifyReachable can fire from inside waitForDevice
      // before health.resume() runs.
      if (!paused) setLedState(deriveState('ok'));
    },
    stop() {
      stopped = true;
      if (currentAbort) { try { currentAbort.abort(); } catch (_) {} }
      if (probeHandle) { clearTimeout(probeHandle); probeHandle = null; }
    },
  };

  function bootstrap() {
    init({
      getIp: () => {
        try {
          const sel = document.getElementById('ide-device-select');
          return sel && sel.value ? sel.value : null;
        } catch (_) { return null; }
      },
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
