// upload.js — OTA client that implements the full firmware/OTA.md flow:
//
//   1. GET /api/status       → remember v_pre, require partition ∈ {A, B}.
//   2. POST /api/upload      → SINGLE request, full UF2 in body, both
//                               X-OTA-Start and X-OTA-Finish set. Last
//                               response is typically unreadable
//                               (device reboots mid-response); treat
//                               connection reset as success.
//   3. wait for status       → poll until device returns /api/status.
//   4. verify version moved  → v_post.version != v_pre.version; if not,
//                               the new image hit a silent TBYB rollback.
//   5. POST /api/commit      → only when v_post.tbyb_pending is true.
//                               Idempotent; safe to always call, but
//                               OTA.md recommends gating on tbyb_pending.
//
// Single-POST design: the previous chunked design (47 × 8 KB) was a
// workaround for "single large POST hangs RMII RX ring" but with the
// current TCP_WND ≈ 17 KB tuning that concern no longer holds — TCP
// already throttles in-flight bytes regardless of HTTP body size, and
// the device's handle_upload_data accumulates body bytes from however
// many TCP packets lwIP delivers. Net: one TCP handshake, no PCB
// churn, OTA completes in ~10 s.
//
// HTTP path only (deviceUrl(ip, null, ...) ignores any cached uniqueId).
// mbedtls can't sustain a long incoming TLS stream yet, and the OTA
// payload is a signed UF2 (bootrom hash check provides integrity).
// Caveat: an HTTPS-served IDE (e.g. github.io) can't fetch http:// due
// to mixed-content blocking. For now, OTA from the deployed IDE
// requires running it locally. Tracked as a follow-up.
//
// All functions are DOM-agnostic so they work in browser, Node tests, and
// from either the Devices tab or the IDE tab.

(function () {
  'use strict';

  // ---- Stage descriptor table -----------------------------------------------
  //
  // Single source of truth for what the OTA progress UI shows during each
  // phase. The IDE (ide.js onStage handler) looks up entries here via
  // stageDescriptor() — adding a new stage to updateFirmware below means
  // adding a row HERE, not in ide.js. The unit test in
  // tests/unit/upload_stages.test.mjs parses this file and asserts every
  // stage(...) emission has a matching STAGES entry, so the "added an
  // emission but forgot the renderer" bug class fails CI loudly.
  //
  // pct values are the OVERALL bar position (0..100). ide.js owns 0..50
  // (Building phase); updateFirmware owns 50..100 (upload + verify + commit).
  const STAGES = {
    precheck:  { pct: 50, label: 'Checking device…' },
    uploading: { pct: 55, label: 'Uploading firmware…' },
    waiting:   { pct: 95, label: 'Waiting for reboot…' },
    verifying: { pct: 97, label: 'Verifying…' },
    commit:    { pct: 99, label: 'Committing (TBYB)…' },
  };

  // Format a stage's human label, splicing in the `detail` argument where
  // a stage uses it. Most stages ignore `detail`; only `waiting` formats
  // it (as "N/M" attempt counts from the post-OTA poll loop). Keeping
  // this as code rather than a per-row template lets each stage decide
  // independently and stays readable as the table grows.
  function formatStageLabel(stage, detail) {
    const base = STAGES[stage];
    if (!base) return null;
    if (stage === 'waiting' && typeof detail === 'string' && detail) {
      return `${base.label} ${detail}`;
    }
    return base.label;
  }

  // Lookup a stage by name. Returns { stage, pct, label, detail } or null
  // if the stage isn't in the table. The IDE's onStage handler renders
  // null as a neutral spinner-style label rather than leaving the
  // previous stage's text in place — keeps the UI honest when an
  // emitter ships a name without updating STAGES.
  function stageDescriptor(stage, detail) {
    const base = STAGES[stage];
    if (!base) return null;
    return { stage, pct: base.pct, label: formatStageLabel(stage, detail), detail };
  }

  // Convert any accepted payload type to a Blob so we can pass it to fetch.
  async function toBlob(data) {
    if (data instanceof Blob) return data;
    if (data instanceof ArrayBuffer) return new Blob([data]);
    if (ArrayBuffer.isView(data)) return new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)]);
    if (typeof data === 'string') return new Blob([data]);
    throw new Error('unsupported payload type');
  }

  // Return true if the fetch() error looks like "connection reset because the
  // device rebooted". These are the expected errors the final OTA chunk
  // triggers: the device calls reboot() inside its HTTP response and the TCP
  // connection drops before the client finishes reading.
  function isRebootCloseError(e) {
    if (!e) return false;
    const msg = String(e.message || e);
    return e.name === 'TypeError' ||
           e.name === 'AbortError' ||
           /network|load failed|fetch|connection|aborted|terminated/i.test(msg);
  }

  // Core single-POST upload. Per OTA.md (single-POST variant):
  //   opts.ip          - device IP
  //   opts.token       - auth token (X-Auth-Token header)
  //   opts.data        - UF2 bytes/Blob
  //   opts.onProgress  - ({ loaded, total, pct }) => void, fires
  //                       continuously as the request body bytes are
  //                       sent. Driven by XHR upload.onprogress (fetch
  //                       can't do request-side progress portably).
  //   opts.onComplete  - () => void   (called when device acks or RSTs from reboot)
  //   opts.onError     - ({ status, message }) => void
  // Returns { abort() } to cancel.
  function uploadFirmware(opts) {
    const { ip, token, onProgress, onComplete, onError } = opts;

    let xhr;
    let aborted = false;

    (async () => {
      let blob;
      try {
        blob = await toBlob(opts.data);
      } catch (e) {
        onError && onError({ status: 0, message: `cannot read payload: ${e.message || e}` });
        return;
      }
      if (aborted) return;

      const total = blob.size;
      // Single source of truth: deviceUrlForIp picks HTTPS when a
      // uniqueId is registered for this device (rm1n hostname +
      // per-device LE cert), HTTP otherwise. The MVP is HTTPS-based,
      // so the user's device picker entries will have uniqueIds.
      const url = window.Conduit.deviceUrlForIp(ip, '/api/upload');

      // Use XMLHttpRequest instead of fetch() solely for upload-side
      // progress events. fetch() doesn't expose request-body progress
      // in any portable way; XHR's upload.onprogress is the only thing
      // that ships everywhere. Note: the progress shown is CLIENT-SIDE
      // bytes-sent, not device-side bytes-flashed, so it can run ahead
      // of the actual flash write (TCP buffers absorb a few KB).
      xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      // Fail-fast timeout. Without this, a wedged device leaves the
      // browser's XHR pending indefinitely (the default xhr.timeout
      // is 0 = no timeout). Measured: a healthy HTTPS OTA completes
      // in ~20 s for a 384 KB image; the worst slow-but-progressing
      // run we've observed was ~90 s. 180 s = 2× that worst case so
      // a network blip doesn't false-timeout, but a truly wedged
      // device still surfaces an actionable error in under 3 minutes.
      xhr.timeout = 180000;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Auth-Token', token);
      xhr.setRequestHeader('X-OTA-Start', '1');
      xhr.setRequestHeader('X-OTA-Finish', '1');

      // Track whether the request body was fully sent, so xhr.onerror
      // can distinguish "device rebooted mid-response" (success) from
      // "upload stalled / TLS RST mid-stream" (real failure). bytesSent
      // here is OS-TCP-send-buffer-fill, NOT on-the-wire bytes — modern
      // OS socket buffers absorb the first ~100-200 KB instantly. So
      // the displayed % jumps to ~30 % within ms, sits flat for ~15 s
      // while TCP drains the OS buffer onto the wire and the device
      // flashes blocks, then climbs to 100 % as the buffer empties.
      //
      // Reported anyway because the user explicitly asked for a number
      // over a generic spinner. The label is annotated "(client-side
      // bytes-sent)" so users understand it's not device-truth — the
      // honest device-truth source (polling /api/status ota_bytes_written)
      // was tried in v=130-v=132 and caused wedges, since each poll
      // is an HTTPS request that competes with the upload's mbedtls
      // cycles. The OS-buffer number is at least free and monotonic.
      let bytesSent = 0;
      let allBytesSent = false;
      xhr.upload.onload = () => {
        allBytesSent = true;
        bytesSent = total;
        if (onProgress) onProgress({ loaded: total, total, pct: 100 });
      };
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        bytesSent = ev.loaded;
        if (onProgress) {
          onProgress({
            loaded: ev.loaded,
            total: ev.total || total,
            pct: (ev.loaded / (ev.total || total)) * 100,
          });
        }
      };

      // Treat "bytes reached total" the same as "upload.onload fired".
      // Over HTTPS the device's RST arrives before the browser dispatches
      // upload.onload in some races — bytesSent === total at that point
      // means the body was fully on the wire even if onload never ran.
      const fullySent = () => allBytesSent || bytesSent >= total;

      // Snap displayed progress to 100% on success-detected terminal
      // paths. The IDE's onProgress callback maps pct=100 to a fixed
      // 95 % position with a "Uploading 100%" label, then the
      // updateFirmware orchestrator transitions stage() through
      // waiting / verifying / commit. Without the explicit pct=100
      // snap, the bar would sit at whatever fixed "Uploading…" value
      // the caller set before invoking us.
      const snapDone = () => {
        if (onProgress) onProgress({ loaded: total, total, pct: 100 });
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          snapDone();
          onComplete && onComplete({});
        } else {
          let msg = `HTTP ${xhr.status}`;
          try {
            const body = JSON.parse(xhr.responseText);
            if (body && body.error) msg += `: ${body.error}`;
          } catch (_) {}
          onError && onError({ status: xhr.status, message: msg });
        }
      };

      xhr.onerror = () => {
        // Two cases collapse into XHR's `error` event, distinguished
        // only by how far the request body got:
        //   - 100% on the wire → device almost certainly received the
        //     full UF2, called ota_finish(), and rebooted INSIDE its
        //     200 OK response. The TCP/TLS drop is expected. Success.
        //   - bytes < 100% → upload stalled and the connection dropped
        //     mid-stream. Real failure; surface it so the caller doesn't
        //     fall through to an "unreachable" misdiagnosis when the
        //     device never even rebooted.
        if (fullySent()) {
          snapDone();
          onComplete && onComplete({});
        } else {
          const pct = ((bytesSent / total) * 100).toFixed(1);
          onError && onError({
            status: 0,
            message: `upload stalled at ${bytesSent}/${total} bytes (${pct}%) — TLS/TCP connection dropped mid-stream`,
          });
        }
      };
      xhr.ontimeout = () => {
        // xhr.timeout fired. Like onerror: if all bytes were on the
        // wire, the device almost certainly received them and rebooted
        // (RST just didn't surface); treat as success. Otherwise the
        // upload genuinely stalled — surface the byte count so the
        // user knows where it stopped.
        if (fullySent()) {
          snapDone();
          onComplete && onComplete({});
        } else {
          const pct = ((bytesSent / total) * 100).toFixed(1);
          onError && onError({
            status: 0,
            message: `upload timed out at ${bytesSent}/${total} bytes (${pct}%) after ${xhr.timeout / 1000}s — device may be wedged`,
          });
        }
      };
      xhr.onabort = () => {
        if (aborted) return;        // user-initiated abort
        if (fullySent()) {
          snapDone();
          onComplete && onComplete({});
        } else {
          onError && onError({
            status: 0,
            message: `upload aborted at ${bytesSent}/${total} bytes`,
          });
        }
      };

      try {
        xhr.send(blob);
      } catch (e) {
        onError && onError({ status: 0, message: `xhr.send: ${e.message || e}` });
      }
    })();

    return {
      abort() {
        aborted = true;
        if (xhr) try { xhr.abort(); } catch (_) {}
      },
    };
  }

  // Default 6 s — covers a fresh TLS handshake (~1-2 s on Cortex-M33)
  // plus the trivial GET, with margin. The previous 2 s default was
  // OK for plain HTTP but timed out before the TLS handshake finished
  // when called via the HTTPS path, causing post-OTA polling to fail
  // with "Device did not respond" even though the device was healthy.
  //
  // Fast path: if the WS stream has already received a STATUS frame
  // (same JSON shape, pushed by the firmware on auth — see
  // ws_server.c::ws_push_status), we return THAT directly and skip
  // the HTTPS fetch entirely. This is critical because Chrome doesn't
  // share TLS session state between fetch() and WebSocket()
  // connection pools, so a "warm WS + cold fetch" still pays a full
  // ~3-9 s cold ECDHE+ECDSA handshake on the Cortex-M33 — and that
  // was the regression that turned the upload precheck into a
  // perceived spinner-forever. The precheck only reads `.partition`
  // and `.ota_in_progress`; both change only on reboot/OTA, which
  // themselves trigger a fresh STATUS push, so the WS-cached copy
  // is fresh enough for the precheck's needs.
  //
  // The `allowCached` knob is true for the precheck and the post-OTA
  // waitForDevice early-exit; false for the polling loop inside
  // waitForDevice (which needs to detect the device coming back over
  // a NEW connection, so it MUST do a real HTTPS fetch).
  async function getStatus(ip, timeoutMs = 6000, { allowCached = true } = {}) {
    if (allowCached) {
      const s = window.Conduit && window.Conduit.stream;
      const cached = s && typeof s.lastStatus === 'function' ? s.lastStatus() : null;
      if (cached) return cached;
    }
    const res = await fetch(window.Conduit.deviceUrlForIp(ip, '/api/status'), {
      mode: 'cors',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`GET /api/status → HTTP ${res.status}`);
    // Tolerate a truncated/malformed body. Older firmwares (or any
    // firmware whose status-builder added fields past its fixed
    // response buffer) can return 200 OK with a body cut mid-string,
    // which would otherwise throw inside res.json() and stall
    // waitForDevice — the loop's catch swallows the throw and the
    // device looks unreachable even though it's responding. Salvage
    // the small subset of fields the rest of the upload flow actually
    // reads (version / partition / uptime / tbyb_pending) via regex
    // on the raw text. Those all appear early in the JSON, so they're
    // present even when the tail is gone.
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      const pick = (re, conv) => {
        const m = text.match(re); return m ? conv(m[1]) : undefined;
      };
      const salvaged = {
        version:       pick(/"version":"([^"]*)"/,       (v) => v),
        binary_version: pick(/"binary_version":"([^"]*)"/, (v) => v),
        partition:     pick(/"partition":"([^"]*)"/,     (v) => v),
        ip:            pick(/"ip":"([^"]*)"/,            (v) => v),
        uptime:        pick(/"uptime":(\d+)/,            (v) => parseInt(v, 10)),
        link:          pick(/"link":(true|false)/,       (v) => v === 'true'),
        ota_in_progress: pick(/"ota_in_progress":(true|false)/, (v) => v === 'true'),
        tbyb_pending:  pick(/"tbyb_pending":(true|false)/, (v) => v === 'true'),
        _truncated:    true,
      };
      // Need at least version + partition to be useful downstream.
      if (salvaged.version && salvaged.partition) return salvaged;
      throw new Error(`GET /api/status: malformed body (${text.length} B)`);
    }
  }

  // Poll /api/status repeatedly until the device responds or the overall
  // timeout expires. Returns the parsed status JSON or null on timeout.
  //
  // If `preUptime` is given, we additionally try to avoid returning stale
  // pre-reboot state. The firmware delays 100 ms between sending the last
  // OTA response and actually rebooting; a poll that lands in that window
  // gets old data. We give it a 1.5 s head start and, for the FIRST FEW
  // polls only, reject obvious pre-reboot uptimes. After that we stop
  // second-guessing — the device's uptime counter has been observed to
  // jump forward oddly across reboots (non-monotonic), so the correct
  // behavior is to trust the status once the device is clearly responsive.
  //
  // `fastReady` is an optional Promise — if it resolves before the poll
  // loop finds the device, we short-circuit with a single /api/status
  // fetch instead of waiting for the next 2 s tick. The stream modules
  // (telemetry/console) feed this from their onNextConnect listeners,
  // so a post-OTA reboot is detected the moment the auto-reconnecting
  // stream lands its first response — typically several seconds before
  // the next scheduled poll would have. If `fastReady` rejects or never
  // resolves, the loop falls back to plain polling.
  async function waitForDevice(ip, opts) {
    const { interval = 2000, maxAttempts = 30, onAttempt, preUptime = null,
            fastReady = null } = opts || {};

    // Race the poll loop against fastReady. Whichever flags "device is
    // back" first wins. Both paths converge on a single getStatus() so
    // the returned shape is the same.
    let resolved = false;
    let fastWinner = null;
    const fastPromise = (fastReady && typeof fastReady.then === 'function')
      ? fastReady.then(async () => {
          if (resolved) return null;
          // The stream told us a transport is alive — confirm with one
          // /api/status fetch so we get the post-reboot uptime + partition
          // that the caller needs (and that lets the strict-uptime branch
          // below stay coherent). Force a live HTTPS fetch
          // (allowCached: false) here: the WS-cached STATUS is from BEFORE
          // the reboot we just survived; using it would tell us the old
          // partition/uptime and break the strict-uptime advance below.
          try {
            const s = await getStatus(ip, 6000, { allowCached: false });
            if (resolved) return null;
            fastWinner = s;
            return s;
          } catch (_) {
            return null;
          }
        }).catch(() => null)
      : new Promise(() => {});  // never resolves
    // Pre-sleep before the first status poll. Was 1500 ms (chosen
    // when the firmware's send-then-reboot delay was the main risk
    // of catching pre-reboot state). With STRICT_ATTEMPTS=3 below
    // guarding correctness — any status with uptime ≥ preUptime
    // within 8 s of preUptime is rejected — the pre-sleep just
    // determines how soon the first poll fires. 800 ms is well over
    // the firmware's 100 ms send-then-reboot pause and cuts dead
    // time off the post-OTA LED transition.
    // Allow fastReady to short-circuit during the initial 800 ms head
    // start. Promise.race resolves as soon as either side fires; the
    // poll loop continues if it lost.
    const headStart = new Promise((r) => setTimeout(r, 800));
    const headStartWinner = await Promise.race([headStart, fastPromise]);
    if (fastWinner) { resolved = true; return fastWinner; }

    const STRICT_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Did the stream signal land between the previous tick and now?
      if (fastWinner) { resolved = true; return fastWinner; }
      try {
        // Same reasoning as the fastReady-confirm fetch above: this is
        // the post-OTA polling loop, so the WS-cached STATUS is from
        // BEFORE the reboot we're waiting on. Force a live HTTPS fetch.
        const status = await getStatus(ip, 6000, { allowCached: false });
        if (attempt <= STRICT_ATTEMPTS && preUptime != null
            && typeof status.uptime === 'number'
            && status.uptime >= preUptime
            && status.uptime - preUptime < 8) {
          // Almost certainly pre-reboot (uptime is within a few seconds
          // of the pre value). Keep polling to catch the real reboot.
        } else {
          // Reachable post-reboot status.
          resolved = true;
          return status;
        }
      } catch (_) {}
      if (fastWinner) { resolved = true; return fastWinner; }
      if (onAttempt) onAttempt(attempt, maxAttempts);
      if (attempt < maxAttempts) {
        // Race the wait against fastReady so a mid-interval stream
        // reconnect doesn't have to wait the full 2 s before we
        // return.
        await Promise.race([
          new Promise((r) => setTimeout(r, interval)),
          fastPromise,
        ]);
      }
    }
    resolved = true;
    return null;
  }

  // POST /api/commit — flips a TBYB image from "on probation" to permanent.
  // Idempotent (returns committed:false if there's nothing to commit).
  async function commitFirmware(ip, token) {
    const res = await fetch(window.Conduit.deviceUrlForIp(ip, '/api/commit'), {
      method: 'POST',
      mode: 'cors',
      headers: { 'X-Auth-Token': token, 'Content-Length': '0' },
    });
    if (!res.ok) throw new Error(`POST /api/commit → HTTP ${res.status}`);
    return res.json();
  }

  // POST /api/reboot — soft-reboot the device. Used when an OTA times
  // out and the device looks wedged: a network reboot is faster and
  // less intrusive than yanking the cable and BOOTSEL-recovering.
  //
  // HTTPS only. We used to try plain HTTP first as a mbedtls-bypass
  // safety net, but the IDE-wide HTTP fallback is now disabled (see
  // app.js deviceUrl) so we don't quietly mask HTTPS bugs by reaching
  // the device over plaintext. If mbedtls is the wedge, this throws
  // and the caller suggests BOOTSEL recovery as the next step.
  //
  // Returns { ok: true } on success. Throws on failure.
  async function rebootDevice(ip, token) {
    const headers = { 'X-Auth-Token': token, 'Content-Length': '0' };
    try {
      const url = window.Conduit.deviceUrlForIp(ip, '/api/reboot');
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, {
        method: 'POST', mode: 'cors', headers, signal: ctrl.signal,
      });
      clearTimeout(to);
      // Device usually RSTs the response as it reboots; any 2xx OR a
      // connection-reset-after-headers counts as success here.
      if (res.ok) return { ok: true, via: 'https' };
    } catch (e) {
      // Connection-reset / abort can fire AFTER the server queued the
      // 200 OK but BEFORE it transmitted the body, because rom_reboot
      // tears down the TCP connection from inside the response handler.
      if (/abort|aborted|reset|network|load failed|fetch/i.test(String(e))) {
        return { ok: true, via: 'https-reset' };
      }
      throw e;
    }
    throw new Error('reboot request returned non-2xx');
  }

  // Full OTA orchestration matching firmware/OTA.md "End-to-end integration
  // flow". Returns a richly-typed result describing which branch we took:
  //
  //   { outcome: 'committed', pre, post, commit }  — success + TBYB committed
  //   { outcome: 'rebooted',  pre, post }          — success, no TBYB to commit
  //   { outcome: 'rollback',  pre, post }          — came back on old version
  //   { outcome: 'unreachable', pre }              — device never responded
  //   { outcome: 'error',     pre, error }         — upload error
  //
  // Hooks:
  //   opts.onStage    (stage, detail?) — 'precheck' | 'uploading' |
  //                                      'waiting' | 'verifying' | 'commit'
  //   opts.onProgress (see uploadFirmware)
  async function updateFirmware(opts) {
    const { ip, token, data, chunkSize, onStage, onProgress,
            fastReady = null } = opts;
    const stage = (s, d) => onStage && onStage(s, d);

    stage('precheck');
    const pre = await getStatus(ip).catch(() => null);
    if (!pre) return { outcome: 'unreachable', pre: null };
    if (!['A', 'B'].includes(pre.partition)) {
      return {
        outcome: 'error',
        pre,
        error: new Error(`device partition is "${pre.partition}"; must be A or B. Reflash via BOOTSEL.`),
      };
    }
    if (pre.ota_in_progress) {
      // OTA state from a prior aborted upload. X-OTA-Start will reset it.
      stage('precheck', 'prior ota in progress — will be reset');
    }

    stage('uploading');
    const uploadErr = await new Promise((resolve) => {
      uploadFirmware({
        ip, token, data, chunkSize,
        onProgress,
        onComplete: () => resolve(null),
        onError: (err) => resolve(err),
      });
    });
    if (uploadErr) return { outcome: 'error', pre, error: uploadErr };

    stage('waiting');
    const post = await waitForDevice(ip, {
      interval: 2000,
      maxAttempts: 30,
      preUptime: typeof pre.uptime === 'number' ? pre.uptime : null,
      onAttempt: (a, m) => stage('waiting', `${a}/${m}`),
      fastReady,
    });
    if (!post) return { outcome: 'unreachable', pre };

    stage('verifying', post);
    if (post.version === pre.version && post.partition === pre.partition) {
      return { outcome: 'rollback', pre, post };
    }

    if (post.tbyb_pending) {
      stage('commit');
      try {
        const commit = await commitFirmware(ip, token);
        return { outcome: 'committed', pre, post, commit };
      } catch (e) {
        return { outcome: 'error', pre, post, error: e };
      }
    }

    // No TBYB bit set → device is already running the new image permanently.
    return { outcome: 'rebooted', pre, post };
  }

  window.Conduit = window.Conduit || {};
  window.Conduit.uploadFirmware = uploadFirmware;
  window.Conduit.commitFirmware = commitFirmware;
  window.Conduit.rebootDevice = rebootDevice;
  window.Conduit.getStatus = getStatus;
  window.Conduit.waitForDevice = waitForDevice;
  window.Conduit.updateFirmware = updateFirmware;
  // Stage descriptors exported so ide.js (and tests) can render the
  // OTA progress UI without duplicating the stage→{pct,label} mapping.
  window.Conduit.uploadStages = STAGES;
  window.Conduit.stageDescriptor = stageDescriptor;
})();
