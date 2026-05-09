// upload.js — OTA client that implements the full firmware/OTA.md flow:
//
//   1. GET /api/status       → remember v_pre, require partition ∈ {A, B}.
//   2. POST /api/upload      → chunked, ≤ 8 KiB per chunk.
//                               first chunk sets X-OTA-Start, last chunk
//                               sets X-OTA-Finish. Last chunk's response is
//                               typically unreadable (device reboots mid-
//                               response); treat connection reset as success.
//   3. wait for status       → poll until device returns /api/status.
//   4. verify version moved  → v_post.version != v_pre.version; if not,
//                               the new image hit a silent TBYB rollback.
//   5. POST /api/commit      → only when v_post.tbyb_pending is true.
//                               Idempotent; safe to always call, but
//                               OTA.md recommends gating on tbyb_pending.
//
// All functions are DOM-agnostic so they work in browser, Node tests, and
// from either the Devices tab or the IDE tab.

(function () {
  'use strict';

  // Keep in lockstep with the firmware's RX ring size. 8 KiB is safe in
  // testing; anything larger risks hanging the RMII NCE driver per
  // firmware/OTA.md.
  const OTA_CHUNK_SIZE = 8 * 1024;

  // Convert any accepted payload type to a Blob so `.slice()` works uniformly.
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

  // Core chunked upload. Per OTA.md:
  //   opts.ip          - device IP
  //   opts.token       - auth token (X-Auth-Token header)
  //   opts.data        - UF2 bytes/Blob
  //   opts.chunkSize   - override (default 8192)
  //   opts.onProgress  - ({ loaded, total, pct }) => void
  //   opts.onComplete  - () => void   (called when last chunk is sent)
  //   opts.onError     - ({ status, message }) => void
  // Returns { abort() } to cancel mid-upload.
  function uploadFirmware(opts) {
    const { ip, token, onProgress, onComplete, onError } = opts;
    const chunkSize = opts.chunkSize || OTA_CHUNK_SIZE;

    let aborted = false;
    const controller = new AbortController();

    (async () => {
      let blob;
      try {
        blob = await toBlob(opts.data);
      } catch (e) {
        onError && onError({ status: 0, message: `cannot read payload: ${e.message || e}` });
        return;
      }

      const total = blob.size;
      const nChunks = Math.max(1, Math.ceil(total / chunkSize));
      const url = window.Conduit.deviceUrlForIp(ip, '/api/upload');

      for (let i = 0; i < nChunks; i++) {
        if (aborted) return;

        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, total);
        const chunk = blob.slice(start, end);
        const isFirst = i === 0;
        const isLast = i === nChunks - 1;

        const headers = {
          'Content-Type': 'application/octet-stream',
          'X-Auth-Token': token,
        };
        if (isFirst) headers['X-OTA-Start'] = '1';
        if (isLast)  headers['X-OTA-Finish'] = '1';

        try {
          const res = await fetch(url, {
            method: 'POST',
            mode: 'cors',
            headers,
            body: chunk,
            signal: controller.signal,
          });
          if (!res.ok) {
            let msg = `chunk ${i + 1}/${nChunks}: HTTP ${res.status}`;
            try {
              const body = await res.json();
              if (body && body.error) msg += `: ${body.error}`;
            } catch (_) {}
            onError && onError({ status: res.status, message: msg });
            return;
          }
          // Drain the body; intermediate chunks return JSON, the last one
          // may fail to yield a response because the device reboots mid-send.
          try { await res.json(); } catch (_) {}
        } catch (e) {
          if (isLast && isRebootCloseError(e)) {
            // Expected — the device rebooted; fall through to onComplete.
          } else {
            onError && onError({ status: 0, message: `chunk ${i + 1}/${nChunks}: ${e.message || e}` });
            return;
          }
        }

        if (onProgress) {
          onProgress({ loaded: end, total, pct: (end / total) * 100 });
        }
      }

      onComplete && onComplete({});
    })();

    return { abort() { aborted = true; controller.abort(); } };
  }

  async function getStatus(ip, timeoutMs = 2000) {
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
  window.Conduit.OTA_CHUNK_SIZE = OTA_CHUNK_SIZE;
})();
