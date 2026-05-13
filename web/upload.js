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
      // Auto-pick HTTP or HTTPS based on whether the user registered a
      // uniqueId in Hardware Manager. With single-POST + the device's
      // 16 KB MBEDTLS_SSL_IN_CONTENT_LEN matching what browsers send,
      // HTTPS uploads sustain a long stream without RECORD_OVERFLOW.
      const url = window.Conduit.deviceUrlForIp(ip, '/api/upload');

      // Use XMLHttpRequest instead of fetch() solely for upload-side
      // progress events. fetch() doesn't expose request-body progress
      // in any portable way; XHR's upload.onprogress is the only thing
      // that ships everywhere. Note: the progress shown is CLIENT-SIDE
      // bytes-sent, not device-side bytes-flashed, so it can run ahead
      // of the actual flash write (TCP buffers absorb a few KB).
      xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Auth-Token', token);
      xhr.setRequestHeader('X-OTA-Start', '1');
      xhr.setRequestHeader('X-OTA-Finish', '1');

      // Track whether the request body was fully sent, so xhr.onerror
      // can distinguish "device rebooted mid-response" (success) from
      // "upload stalled / TLS RST mid-stream" (real failure).
      let bytesSent = 0;
      let allBytesSent = false;

      if (onProgress) {
        xhr.upload.onprogress = (ev) => {
          if (!ev.lengthComputable) return;
          bytesSent = ev.loaded;
          onProgress({
            loaded: ev.loaded,
            total: ev.total || total,
            pct: ((ev.loaded / (ev.total || total)) * 100),
          });
        };
        // Some browsers don't fire a final 100% event when the request
        // succeeds — guarantee one when load completes.
        xhr.upload.onload = () => {
          allBytesSent = true;
          bytesSent = total;
          onProgress({ loaded: total, total, pct: 100 });
        };
      } else {
        xhr.upload.onload = () => { allBytesSent = true; bytesSent = total; };
        xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) bytesSent = ev.loaded; };
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
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
      // Treat "bytes reached total" the same as "upload.onload fired".
      // Over HTTPS the device's RST arrives before the browser dispatches
      // upload.onload in some races — bytesSent === total at that point
      // means the body was fully on the wire even if onload never ran.
      const fullySent = () => allBytesSent || bytesSent >= total;

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
          onComplete && onComplete({});
        } else {
          const pct = ((bytesSent / total) * 100).toFixed(1);
          onError && onError({
            status: 0,
            message: `upload stalled at ${bytesSent}/${total} bytes (${pct}%) — TLS/TCP connection dropped mid-stream`,
          });
        }
      };
      xhr.onabort = () => {
        if (aborted) return;  // user-initiated abort, no callback expected
        if (fullySent()) {
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
  async function getStatus(ip, timeoutMs = 6000) {
    const res = await fetch(window.Conduit.deviceUrlForIp(ip, '/api/status'), {
      mode: 'cors',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`GET /api/status → HTTP ${res.status}`);
    return res.json();
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
  async function waitForDevice(ip, opts) {
    const { interval = 2000, maxAttempts = 30, onAttempt, preUptime = null } = opts || {};
    await new Promise((r) => setTimeout(r, 1500));
    const STRICT_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const status = await getStatus(ip);
        if (attempt <= STRICT_ATTEMPTS && preUptime != null
            && typeof status.uptime === 'number'
            && status.uptime >= preUptime
            && status.uptime - preUptime < 8) {
          // Almost certainly pre-reboot (uptime is within a few seconds
          // of the pre value). Keep polling to catch the real reboot.
        } else {
          return status;
        }
      } catch (_) {}
      if (onAttempt) onAttempt(attempt, maxAttempts);
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, interval));
    }
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
    const { ip, token, data, chunkSize, onStage, onProgress } = opts;
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
  window.Conduit.getStatus = getStatus;
  window.Conduit.waitForDevice = waitForDevice;
  window.Conduit.updateFirmware = updateFirmware;
})();
