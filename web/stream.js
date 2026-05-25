// stream.js — single bidirectional WebSocket-over-HTTPS transport.
//
// The IDE's only data path: log, telemetry, cmd, status all flow over
// one wss://<dev>/api/stream connection. The legacy /api/log,
// /api/data, /api/cmd, /api/status HTTP endpoints stay live on the
// firmware for the conduit Python CLI, but the browser doesn't use
// them — see ws_server.{c,h} for the protocol.
//
// Channel multiplex (1-byte tag at payload[0]):
//   'L' text   — log line  → onLog(text)
//   'D' binary — telemetry → onData(Uint8Array)  (16-byte-header records)
//   'C' text   — cmd       → cmd(name,args) → Promise; seq correlation
//   'S' text   — status    → onStatus(jsonObj)
//   'N' text   — notice    → onNotice({kind,detail})
//
// Auth: WebSocket cannot carry custom headers, so the first frame
// after open is always a CMD with name="auth" and token=<value>.
// The server keeps the stream gated until that frame validates.
//
// Diagnostics: console.warn/console.error fires on abnormal events
// (stall, handshake failure, close-before-ready, URL build error). The
// happy path (open / auth / ready / close-on-reboot) is silent so the
// DevTools console isn't noise during normal use. Enable verbose logs
// for debugging by setting `window.Conduit.streamDebug = true` BEFORE
// page load (e.g. via a `localStorage` flag or a DevTools snippet).

(function () {
  'use strict';

  const TAG = '[stream]';
  // Verbose logging — opt-in via `Conduit.streamDebug = true` before
  // page load. With it off (the default) we log only abnormal events.
  const debug = () => !!(window.Conduit && window.Conduit.streamDebug);
  const dlog  = (...args) => { if (debug()) console.log(TAG, ...args); };

  // -- Constants ----------------------------------------------------

  // 0 ms baseline between a clean session close and the next openOnce
  // so the IDE reconnects at the same speed as `conduit ws-probe`
  // (which paces at 0 in --repeat mode and lands ~15 ms per cycle on
  // a LAN device). The previous 500 ms was a precautionary throttle
  // that masked how fast the protocol actually is. The short-session
  // backoff below (consecutiveShortSessions × SHORT_BACKOFFS_MS)
  // remains the real safety mechanism if cycling becomes unhealthy.
  const RECONNECT_OK_MS    = 0;
  const RECONNECT_ERR_MS   = 1500;
  const CONNECT_TIMEOUT_MS = 10000;
  // Firmware sends an idle keepalive every WS_KEEPALIVE_MS (500 ms),
  // so 15 s is 30× the keepalive cadence — wide enough to absorb a
  // long main-thread blocker (WASM compile, large GC, a stutter on
  // pan/zoom) without churning a TLS reconnect. A genuinely dead
  // connection still surfaces in ≤15 s; tearing down sooner just
  // multiplies the outage (5 s stall + 5 s reconnect = the very
  // "10 s no-data" symptom this widened window prevents).
  const STALL_MS           = 15000;
  const STALL_CHECK_MS     = 1000;
  const IP_CHECK_MS        = 1000;
  const CMD_TIMEOUT_MS     = 8000;

  const CH_LOG     = 0x4C;
  const CH_DATA    = 0x44;
  const CH_CMD     = 0x43;
  const CH_STATUS  = 0x53;
  const CH_NOTICE  = 0x4E;

  // -- State --------------------------------------------------------

  let getIp    = () => null;
  let getToken = () => '';

  let ws            = null;
  let knownIp       = null;
  let stopped       = false;
  let paused        = false;
  let pauseWaiter   = null;
  let lastByteMs    = 0;       // any inbound frame (incl. STATUS, NOTICE)
  let lastDataMs    = 0;       // LOG or DATA frame only — the "real" streaming signal
  let stallHandle   = null;
  let ipWatchHandle = null;
  let connectTimer  = null;
  let txPingHandle  = null;

  let streamConnected = false;
  let lastUrl         = null;
  // Has THIS page-load ever successfully completed a WS open? Used to
  // silence the "closed BEFORE ready" / "socket error before ready"
  // warn on the very first connect attempt(s). Firefox routinely fails
  // the first WebSocket opened during document `loading` state with
  // "The connection... was interrupted while the page was loading";
  // the retry a second later succeeds. Logging it as warn each time
  // pollutes the console with noise that suggests an actual problem.
  // After the first successful open, the watchdog warns stay loud
  // because a real disconnect is worth seeing.
  let everConnected = false;
  // Counts consecutive failures before everConnected flips true. Drives
  // exponential backoff so the page-load WS-race burst doesn't spam
  // Firefox's "interrupted while the page was loading" warning. Reset
  // on the first successful clean session close.
  let consecutiveEarlyFails = 0;
  // Counts consecutive sessions that died within SHORT_SESSION_MS of
  // becoming streamConnected. When this climbs, retries back off
  // exponentially so we stop firehosing the device (and the console)
  // when something's making sessions die instantly. Reset by any
  // session that lasts longer than SHORT_SESSION_MS.
  let consecutiveShortSessions = 0;
  const SHORT_SESSION_MS = 5000;
  // Timestamp of streamConnected=true; used to measure session length
  // at teardown time and as the "stable since" clock for isStable().
  let connectedSinceMs = 0;
  // True iff at least one LOG or DATA frame arrived during the CURRENT
  // session. Used by the short-session-backoff gate so a healthy
  // session that happened to be brief (e.g. user manually closes
  // immediately after seeing data) doesn't escalate the backoff into
  // multi-second territory. Reset on every teardown.
  let gotDataInSession = false;

  // ws-probe-equivalent phase timings for the most recent openOnce().
  // Populated by openOnce(); read via Conduit.stream.lastTimings().
  //   t_open_ms         : performance.now() of WebSocket onopen relative to ctor
  //   t_auth_reply_ms   : moment we saw the CMD reply to seq=0 auth
  //   t_status_ms       : moment we saw the first STATUS frame (ready)
  //   total_ms          : same as t_status_ms — kept for parity with ws-probe's ProbeResult
  //   ok                : did we make it to STATUS?
  // The keys mirror the column names ws-probe prints so a side-by-side
  // diff is trivial.
  const lastTimings = {
    t_open_ms: 0,
    t_auth_reply_ms: 0,
    t_status_ms: 0,
    total_ms: 0,
    ok: false,
    at: 0,                       // performance.now() of the ctor for the last attempt
  };
  // Ring of the last N timings — small enough to inspect from DevTools
  // without a separate log scrape, large enough to cover the 10-cycle
  // budget the ws-probe harness uses.
  const TIMINGS_RING = 32;
  const timingsHistory = [];

  let nextSeq = 1;
  const pendingCmds = new Map();    // seq -> {resolve, reject, timer, label}

  // Per-channel byte/frame counters since last stats dump. Used by the
  // 30 s `[stream] stats` heartbeat (debug-flag gated) for steady-state
  // throughput visibility — useful when chasing "occasional stall"
  // reports that don't trip the watchdog.
  const stats = { logBytes: 0, dataBytes: 0, statusFrames: 0, noticeFrames: 0,
                  cmdReplies: 0, frames: 0, sinceMs: performance.now(),
                  // Per-message processing-time accumulators. We track
                  // the slowest individual dispatch (max), the count of
                  // dispatches that exceeded a "slow" threshold, and
                  // the second-bucket where the last zero-byte second
                  // landed — together these three numbers usually pin
                  // down which of the dropout causes in the plan is
                  // firing (slow dispatch = chart/log handler heavy;
                  // zero-byte second = WS RX paused; combinations = TCP
                  // backpressure).
                  maxDispatchMs: 0, slowDispatchCount: 0,
                  zeroByteSeconds: 0, lastNonzeroSecondBucket: 0 };

  // 1-second-bucket arrival rate. `bucketBytes` accumulates the byte
  // count for the current wall-clock second; whenever the second
  // changes we check whether the just-finished second saw any traffic
  // and warn (always-on; not gated) if it didn't AND we expected
  // traffic (i.e. we were connected past auth). This catches the
  // "dropout that didn't trip the 15 s watchdog" case where the
  // browser saw, say, 4 s of zero bytes.
  let bucketBytes = 0;
  let bucketStartMs = performance.now();
  const SLOW_DISPATCH_MS = 10;

  // "Streaming" threshold — how recently a frame must have arrived for
  // `isStreaming()` to return true. Firmware sends a keepalive every
  // 500 ms when idle, so 2 s gives a 4× safety margin while still
  // catching a stuck stream within a couple of polls of the consumer's
  // 500 ms indicator interval.
  const DATA_RECENT_MS = 2000;
  // Minimum continuous-streamConnected duration before the page-load
  // gate (`isStable`) flips true. Chosen ≥ SHORT_SESSION_MS so a
  // session that survives the short-session backoff trigger is also
  // the one that flips the UI to "connected".
  const STABLE_MS = 5000;
  function noteBytes(n) {
    const now = performance.now();
    if (now - bucketStartMs >= 1000) {
      if (streamConnected && bucketBytes === 0) {
        stats.zeroByteSeconds++;
        // Always log this — it's a real dropout signal, not a stat dump.
        // Firmware emits idle keepalive every 500 ms, so a zero-byte
        // second means inbound is genuinely paused.
        console.warn(TAG, `zero-byte second (no inbound for >1 s while connected)`);
      } else if (bucketBytes > 0) {
        stats.lastNonzeroSecondBucket = bucketBytes;
      }
      bucketBytes = 0;
      bucketStartMs = now;
    }
    bucketBytes += n;
  }

  const logSubs    = new Set();
  const dataSubs   = new Set();
  const statusSubs = new Set();
  const noticeSubs = new Set();
  let connectListeners = [];
  let disconnectListeners = [];

  function fireConnect() {
    if (!connectListeners.length) return;
    const pending = connectListeners;
    connectListeners = [];
    for (const cb of pending) { try { cb(); } catch (_) {} }
  }
  function fireDisconnect() {
    for (const cb of disconnectListeners) { try { cb(); } catch (_) {} }
  }

  // -- URL builder --------------------------------------------------

  // Build the wss:// (or ws://) URL for /api/stream. Tries
  // deviceUrlForIp first (commissioned devices route through the
  // wildcard DNS hostname with a per-device cert). Falls back to plain
  // ws://<ip>/api/stream when no uniqueId is registered AND
  // allowHttpFallback is set; that path only works from an http://
  // origin (mixed-content rules block ws:// from https://). Logs a
  // clear error if neither path is viable.
  function streamUrl(ip) {
    if (window.Conduit && typeof window.Conduit.deviceUrlForIp === 'function') {
      try {
        const url = window.Conduit.deviceUrlForIp(ip, '/api/stream');
        return url
          .replace(/^https:\/\//i, 'wss://')
          .replace(/^http:\/\//i,  'ws://');
      } catch (e) {
        // Fall through to the unsafe fallback below.
        console.warn(TAG, 'deviceUrlForIp threw; trying plain ws://', e.message || e);
      }
    }
    // Last-resort fallback. Will be blocked on https origin (mixed
    // content); user needs to commission the device or run the IDE
    // from http://localhost.
    if (window.location && window.location.protocol === 'https:') {
      throw new Error(
        'no uniqueId for ' + ip + ' and the IDE is on https origin — ' +
        'register the device in Hardware Manager (so wss:// can hit ' +
        'the per-device hostname), or run the IDE from http://localhost.'
      );
    }
    return 'ws://' + ip + '/api/stream';
  }

  // -- Frame encoding ----------------------------------------------

  function sendText(channel, text) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const payload = String.fromCharCode(channel) + text;
    try {
      ws.send(payload);
      return true;
    } catch (e) {
      console.warn(TAG, 'send failed:', e && e.message || e);
      return false;
    }
  }

  // -- Cmd channel --------------------------------------------------

  function buildArgsQS(args) {
    if (!args || typeof args !== 'object') return '';
    const parts = [];
    for (const k of Object.keys(args)) {
      const v = args[k];
      if (v == null) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    return parts.join('&');
  }

  function cmd(name, args) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('stream not connected'));
    }
    const seq = nextSeq++;
    if (nextSeq > 0xFFFFFFFF) nextSeq = 1;
    const argsQS = buildArgsQS(args);
    const payload = `seq=${seq}&name=${encodeURIComponent(name)}${argsQS ? '&' + argsQS : ''}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCmds.delete(seq);
        reject(new Error(`cmd '${name}' timed out`));
      }, CMD_TIMEOUT_MS);
      pendingCmds.set(seq, { resolve, reject, timer, name });
      if (!sendText(CH_CMD, payload)) {
        clearTimeout(timer);
        pendingCmds.delete(seq);
        reject(new Error('send failed'));
      }
    });
  }

  // -- Inbound dispatch --------------------------------------------

  function dispatchCmd(jsonText) {
    let obj;
    try { obj = JSON.parse(jsonText); } catch (_) { return; }
    if (!obj || typeof obj.seq !== 'number') return;
    const pending = pendingCmds.get(obj.seq);
    if (!pending) return;
    pendingCmds.delete(obj.seq);
    clearTimeout(pending.timer);
    if (obj.ok) pending.resolve(obj);
    else pending.reject(new Error(obj.error || 'cmd failed'));
  }

  // Latest STATUS object pushed by the device on auth (and on any
  // status_dirty event). Cached so upload.js's precheck can use the
  // already-received status instead of paying a cold ~3–9 s HTTPS
  // handshake just to ask `/api/status` for fields it already has on
  // the wire. The relevant precheck fields (partition, ota_in_progress)
  // change only on reboot / OTA — both of which trigger a fresh STATUS
  // push — so staleness within a session is bounded.
  let lastStatusObj   = null;
  let lastStatusAtMs  = 0;

  function dispatchStatus(jsonText) {
    let obj;
    try { obj = JSON.parse(jsonText); }
    catch (_) {
      // Truncated STATUS body — same root cause as the upload.js
      // getStatus salvage path: ws_push_status uses a fixed buffer
      // (`char body[N]` in ws_server.c), and adding fields to the
      // shared JSON builder will silently produce a body cut
      // mid-string. Dropping the frame silently here was breaking
      // two visible things:
      //   * the IDE's "[device] v… (binary …) · partition …" build-
      //     log line stops updating after OTA (onStatus callbacks
      //     never fire),
      //   * telemetry's schema map never gets the inlined
      //     data_schema, so the FIRST records of a fresh session
      //     come in as unknown-msgId and the chart starts cycling
      //     through the HTTPS /api/data_schema refresh path.
      // Salvage the same field set as upload.js's getStatus so
      // subscribers see the partial-but-correct head of the body.
      // No data_schema in the salvage — the splice lives at the END
      // of the body and is therefore the bytes most likely lost.
      // Telemetry's HTTPS-fetch fallback handles that case.
      const pick = (re, conv) => {
        const m = jsonText.match(re); return m ? conv(m[1]) : undefined;
      };
      const pickStr  = (k) => pick(new RegExp(`"${k}":"([^"]*)"`), (v) => v);
      const pickInt  = (k) => pick(new RegExp(`"${k}":(-?\\d+)`), (v) => parseInt(v, 10));
      const pickBool = (k) => pick(new RegExp(`"${k}":(true|false)`), (v) => v === 'true');
      obj = {
        version:         pickStr('version'),
        binary_version:  pickStr('binary_version'),
        ip:              pickStr('ip'),
        mac:             pickStr('mac'),
        uptime:          pickInt('uptime'),
        link:            pickBool('link'),
        partition:       pickStr('partition'),
        board_id:        pickStr('board_id'),
        ota_in_progress: pickBool('ota_in_progress'),
        tbyb_pending:    pickBool('tbyb_pending'),
        _truncated:      true,
      };
      // Close-cause buckets + key diag fields. These all appear in
      // the JSON BEFORE the data_schema splice (and before the new
      // mbedtls/MEMP block on most firmwares), so they're recoverable
      // from a 1023-byte truncated body. Required for the IDE's
      // "[device] stream-close: <bucket>=<n>" diff line — without
      // them every reconnect we get the warning but can't tell which
      // bucket moved, which is exactly the diagnostic the user needs
      // when the WS cycles unexplained.
      for (const k of [
        'streams_open', 'stream_last_close_err', 'stream_last_close_age_ms',
        'stream_close_recv_eof', 'stream_close_recv_err',
        'stream_close_err_rst', 'stream_close_err_abrt',
        'stream_close_err_clsd', 'stream_close_err_other',
        'stream_close_write_err', 'stream_close_ws_parse_fail',
        'stream_close_link_down',
        'core1_iter', 'http_poll_fires', 'http_accepts', 'http_streams_started',
        'data_ring_evictions', 'data_ring_evicted_bytes',
      ]) {
        const v = pickInt(k);
        if (v !== undefined) obj[k] = v;
      }
      // Need at least version + partition; otherwise the salvage is
      // not informative enough to broadcast — every subscriber would
      // treat the partial object as a real STATUS and overwrite
      // their last-good cache.
      if (!obj.version || !obj.partition) return;
    }
    lastStatusObj  = obj;
    lastStatusAtMs = performance.now();
    for (const cb of statusSubs) { try { cb(obj); } catch (_) {} }
  }

  function dispatchNotice(jsonText) {
    let obj;
    try { obj = JSON.parse(jsonText); } catch (_) { return; }
    for (const cb of noticeSubs) { try { cb(obj); } catch (_) {} }
  }

  function dispatchData(uint8) {
    if (uint8.byteLength <= 1) return;
    const body = uint8.subarray(1);
    for (const cb of dataSubs) { try { cb(body); } catch (_) {} }
  }

  function dispatchLog(text) {
    for (const cb of logSubs) { try { cb(text); } catch (_) {} }
  }

  function onMessage(ev) {
    const t0 = performance.now();
    lastByteMs = t0;
    stats.frames++;
    if (typeof ev.data === 'string') {
      if (ev.data.length === 0) return;
      const ch = ev.data.charCodeAt(0);
      const body = ev.data.slice(1);
      noteBytes(body.length + 1);
      switch (ch) {
        case CH_LOG:
          stats.logBytes += body.length; lastDataMs = t0;
          gotDataInSession = true;
          dispatchLog(body); break;
        case CH_CMD:
          stats.cmdReplies++;            dispatchCmd(body); break;
        case CH_STATUS:
          stats.statusFrames++;          dispatchStatus(body); break;
        case CH_NOTICE:
          stats.noticeFrames++;          dispatchNotice(body); break;
        default: /* drop unknown text channel */ break;
      }
    } else if (ev.data instanceof ArrayBuffer) {
      const u8 = new Uint8Array(ev.data);
      if (u8.byteLength === 0) return;
      gotDataInSession = true;
      noteBytes(u8.byteLength);
      if (u8[0] === CH_DATA) {
        stats.dataBytes += u8.byteLength - 1;
        lastDataMs = t0;
        dispatchData(u8);
      }
    } else if (ev.data && ev.data.arrayBuffer) {
      ev.data.arrayBuffer().then((buf) => {
        const u8 = new Uint8Array(buf);
        if (u8.byteLength === 0) return;
        gotDataInSession = true;
        noteBytes(u8.byteLength);
        if (u8[0] === CH_DATA) {
          stats.dataBytes += u8.byteLength - 1;
          lastDataMs = performance.now();
          dispatchData(u8);
        }
      });
    }
    const dispatchMs = performance.now() - t0;
    if (dispatchMs > stats.maxDispatchMs) stats.maxDispatchMs = dispatchMs;
    if (dispatchMs > SLOW_DISPATCH_MS) stats.slowDispatchCount++;
  }

  // 30 s steady-state heartbeat. Debug-flag gated so production stays
  // quiet; when investigating stalls, set Conduit.streamDebug=true and
  // the console shows e.g. `[stream] stats 30000ms: 5874f, 947KB data,
  // 0B log, 0 cmd, 1 status, 0 notice, ws=OPEN, quiet=4ms`. Trends
  // (a stream going from 5800f/30s to 0f/30s) make stalls obvious
  // even when they don't trip the watchdog.
  setInterval(() => {
    if (!debug()) return;
    const now = performance.now();
    const elapsed = Math.round(now - stats.sinceMs);
    const quietMs = lastByteMs > 0 ? Math.round(now - lastByteMs) : null;
    const rs = ws ? ws.readyState : null;
    const rsName = rs === 1 ? 'OPEN' : rs === 0 ? 'CONNECTING'
                 : rs === 2 ? 'CLOSING' : rs === 3 ? 'CLOSED' : 'none';
    const bufAmt = ws ? ws.bufferedAmount : 0;
    console.log(TAG, `stats ${elapsed}ms: ${stats.frames}f, ${(stats.dataBytes / 1024).toFixed(1)}KB data, ` +
                     `${stats.logBytes}B log, ${stats.cmdReplies} cmd, ${stats.statusFrames} status, ` +
                     `${stats.noticeFrames} notice, ws=${rsName}, bufOut=${bufAmt}` +
                     (quietMs != null ? `, quiet=${quietMs}ms` : '') +
                     `, maxDispatch=${stats.maxDispatchMs.toFixed(1)}ms` +
                     `, slowDispatch=${stats.slowDispatchCount}` +
                     `, zeroSec=${stats.zeroByteSeconds}`);
    stats.frames = stats.logBytes = stats.dataBytes = 0;
    stats.cmdReplies = stats.statusFrames = stats.noticeFrames = 0;
    stats.maxDispatchMs = 0; stats.slowDispatchCount = 0;
    stats.zeroByteSeconds = 0;
    stats.sinceMs = now;
  }, 30000);

  // -- Connection lifecycle ----------------------------------------

  function clearConnectTimer() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  }

  function teardown(reason, opts) {
    const isShort = !!(opts && opts.isShort);
    const wasConnected = streamConnected;
    // Always-on warn when we tear down a previously-working long
    // session — that's a real disconnect worth seeing ("who killed
    // my WS?"). Demoted to debug for short-session teardowns (the
    // unsolved page-load 2.8 s Firefox WS abort): the UI's spinner
    // gate already hides it, and the console doesn't need a loud
    // warn for every cycle. Never-connected teardowns stay quiet
    // — they happen during the normal page-load retry loop.
    if (wasConnected) {
      if (isShort) dlog(`teardown after short session: ${reason}`);
      else         console.warn(TAG, `teardown after connected: ${reason}`);
    } else {
      dlog(`teardown (never connected): ${reason}`);
    }
    streamConnected = false;
    clearConnectTimer();
    for (const [, p] of pendingCmds) {
      clearTimeout(p.timer);
      try { p.reject(new Error(`stream closed: ${reason}`)); } catch (_) {}
    }
    pendingCmds.clear();
    if (ws) {
      try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; } catch (_) {}
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    if (txPingHandle) { clearInterval(txPingHandle); txPingHandle = null; }
    lastByteMs = 0;
    lastDataMs = 0;
    gotDataInSession = false;
    if (wasConnected) fireDisconnect();
  }

  function openOnce(ip) {
    let url;
    try { url = streamUrl(ip); }
    catch (e) {
      console.error(TAG, 'cannot build URL:', e.message || e);
      throw e;
    }
    lastUrl = url;
    dlog('opening', url);

    // Phase-timing capture — mirrors ws-probe's ProbeResult so the two
    // can be diffed cycle-for-cycle. t0 is set BEFORE the WebSocket
    // constructor so it captures the TCP/TLS connect time same as
    // ws-probe's t_connect_ms. The browser doesn't expose connect/upgrade
    // boundaries separately (one onopen fires after both), so we
    // collapse them into t_open_ms; the auth-reply / STATUS phases match
    // ws-probe exactly.
    const t0 = performance.now();
    lastTimings.t_open_ms = 0;
    lastTimings.t_auth_reply_ms = 0;
    lastTimings.t_status_ms = 0;
    lastTimings.total_ms = 0;
    lastTimings.ok = false;
    lastTimings.at = t0;

    const sock = new WebSocket(url);
    sock.binaryType = 'arraybuffer';
    ws = sock;

    return new Promise((resolve, reject) => {
      let settled = false;
      // Watch for the auth (seq=0) reply so we can stamp t_auth_reply_ms.
      // The dispatchCmd path swallows the seq=0 reply (no entry in
      // pendingCmds, since auth is sent directly inside sock.onopen
      // without going through cmd()), so we add a transient subscriber
      // that peeks at every inbound message until it fires.
      const onMessagePeek = (ev) => {
        if (lastTimings.t_auth_reply_ms !== 0) return;
        if (typeof ev.data !== 'string' || ev.data.length === 0) return;
        if (ev.data.charCodeAt(0) !== CH_CMD) return;
        // Cheap substring check before JSON.parse — the reply we want
        // is the auth one, which is always `seq:0`.
        if (ev.data.indexOf('"seq":0') < 0) return;
        lastTimings.t_auth_reply_ms = +(performance.now() - t0).toFixed(2);
        sock.removeEventListener('message', onMessagePeek);
      };
      sock.addEventListener('message', onMessagePeek);
      const onStatusOnce = () => {
        if (settled) return;
        settled = true;
        statusSubs.delete(onStatusOnce);
        try { sock.removeEventListener('message', onMessagePeek); } catch (_) {}
        const nowMs = performance.now();
        lastTimings.t_status_ms = +(nowMs - t0).toFixed(2);
        lastTimings.total_ms    = lastTimings.t_status_ms;
        lastTimings.ok = true;
        // Push a shallow copy into the rolling history so the user can
        // pull recent cycles via Conduit.stream.timingsHistory() without
        // racing against the in-flight lastTimings struct.
        timingsHistory.push({ ...lastTimings });
        if (timingsHistory.length > TIMINGS_RING) timingsHistory.shift();
        dlog(`ready: open=${lastTimings.t_open_ms.toFixed(1)}ms ` +
             `auth=${lastTimings.t_auth_reply_ms.toFixed(1)}ms ` +
             `status=${lastTimings.t_status_ms.toFixed(1)}ms`);
        streamConnected = true;
        everConnected = true;
        connectedSinceMs = nowMs;
        lastByteMs = connectedSinceMs;
        clearConnectTimer();
        // Start the browser-side TX heartbeat. See TX_PING_MS comment
        // for why — without this, fresh WS sessions die at ~3 s on
        // page load even when the device is happily sending keepalive.
        if (txPingHandle) clearInterval(txPingHandle);
        txPingHandle = setInterval(() => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          try { ws.send(''); } catch (_) {}
        }, TX_PING_MS);
        fireConnect();
        resolve();
      };
      statusSubs.add(onStatusOnce);

      sock.onopen = () => {
        lastTimings.t_open_ms = +(performance.now() - t0).toFixed(2);
        dlog('socket open; sending auth frame');
        const tok = getToken();
        const payload = `seq=0&name=auth&token=${encodeURIComponent(tok)}`;
        try { sock.send(String.fromCharCode(CH_CMD) + payload); }
        catch (e) {
          console.warn(TAG, 'auth send failed:', e && e.message || e);
        }
      };
      sock.onmessage = onMessage;
      sock.onerror = () => {
        // The browser fires onerror without details (per spec); the
        // onclose right after will carry the real story. The first
        // attempt of a fresh page-load often hits "page-loading" race
        // and the warn would just be noise; demote to dlog until we've
        // succeeded at least once.
        if (!settled) {
          if (everConnected) console.warn(TAG, 'socket error before ready');
          else dlog('socket error before ready (first attempt — likely page-load race, will retry)');
        }
      };
      sock.onclose = (ev) => {
        if (settled) {
          dlog('closed (post-ready):', ev.code, ev.reason || '');
          // Outer connectLoop's Promise-wrap picks this up.
          return;
        }
        settled = true;
        statusSubs.delete(onStatusOnce);
        if (everConnected) {
          console.warn(TAG, 'closed BEFORE ready:', ev.code, ev.reason || '');
        } else {
          dlog('closed BEFORE ready (first attempt — likely page-load race, will retry):',
               ev.code, ev.reason || '');
        }
        reject(new Error(`closed before ready (code ${ev.code})`));
      };

      clearConnectTimer();
      connectTimer = setTimeout(() => {
        if (settled) return;
        console.warn(TAG, 'connect timeout after', CONNECT_TIMEOUT_MS, 'ms; closing');
        try { sock.close(); } catch (_) {}
      }, CONNECT_TIMEOUT_MS);
    });
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Resolves once the document is fully loaded and all CSS-declared
  // fonts are resolved. Historically also waited POST_LOAD_SETTLE_MS
  // (1 s) after that — a Firefox sub-resource-race workaround for
  // its "interrupted while the page was loading" abort. With session
  // tickets, any such abort recovers in ~50 ms via resumption — far
  // below the threshold of visible UI disruption. So the explicit
  // settle is now 0: as soon as `document.fonts.ready` resolves we
  // attempt to open. Keeping the document-complete + fonts-ready
  // waits because they're already met on the typical page-load
  // critical path and cost nothing.
  const POST_LOAD_SETTLE_MS = 0;
  // How often we send an EMPTY TEXT frame from browser → device to
  // keep the connection bidirectionally active. WebSocket.send('') is
  // a valid zero-length frame the firmware silently drops in
  // ws_handle_message (msg_buf_len < 1 → return). Without this the
  // browser only RECEIVES (device keepalive every 500ms), and some
  // browser/intermediary layer appears to drop "idle-incoming-only"
  // WSes after ~3s during page-load. With an outgoing tick every
  // 2s, the connection has TX activity that satisfies whatever
  // staleness check is killing fresh sessions.
  const TX_PING_MS = 2000;
  function awaitPageLoad() {
    const fontsReady = (document.fonts && document.fonts.ready)
      ? document.fonts.ready
      : Promise.resolve();
    const docComplete = (document.readyState === 'complete')
      ? Promise.resolve()
      : new Promise((r) => window.addEventListener('load', r, { once: true }));
    return Promise.all([docComplete, fontsReady])
      .then(() => new Promise((r) => setTimeout(r, POST_LOAD_SETTLE_MS)));
  }

  async function connectLoop() {
    dlog('connectLoop started');
    // Hold the very first WS open until the page is fully loaded.
    // Subsequent reconnects (after disconnect / device change) don't
    // gate on load — by then the page is settled and we want fast
    // recovery, not deferred reconnection.
    await awaitPageLoad();
    dlog('page loaded; proceeding to first connect');
    while (!stopped) {
      // Paused (typically by ide.js during OTA): the device is
      // intentionally offline; don't retry, don't generate console
      // noise. The existing WS may still be alive at pause time —
      // we keep it open until the device's reboot kills it. Once
      // resume() fires (ide.js after the OTA round-trip), the loop
      // wakes and tries one fresh connect against the new firmware.
      // fastReady no longer fires inside the OTA window — `/api/status`
      // polling handles "device is back" in upload.js's waitForDevice
      // — but the saved 1-3 s isn't worth the ~7 noisy retry attempts
      // Firefox prints during the device's reboot window.
      if (paused) {
        await new Promise((r) => { pauseWaiter = r; });
        pauseWaiter = null;
        if (stopped) break;
        continue;
      }
      const ip = getIp();
      // A transient null from defaultGetIp() (DOM-select re-render,
      // localStorage rehydrate, etc.) must NOT count as a device
      // change — that would tear down a perfectly good live WS. Treat
      // null as "no signal yet, hold current state". Only a non-null
      // change to a different IP is a real device switch.
      if (ip && ip !== knownIp) {
        if (knownIp) dlog('device changed:', knownIp, '→', ip);
        knownIp = ip;
        teardown('device changed');
      }
      if (!ip) {
        await sleep(RECONNECT_ERR_MS);
        continue;
      }
      try {
        await openOnce(ip);
        // Wait until the socket closes (sock.onclose post-ready hits this).
        // Capture the close `code` so teardown can surface what actually
        // killed the WS (1000=clean, 1006=abnormal/no-close-frame, etc.).
        // Without this the user just saw "eof" and the misleading Firefox
        // "interrupted while page was loading" message for the next
        // reconnect attempt — no way to tell whether the device went
        // away, the network blipped, or mbedtls failed.
        const closeInfo = await new Promise((resolve) => {
          if (!ws || ws.readyState === WebSocket.CLOSED) { resolve({ code: null, reason: 'already-closed' }); return; }
          const prev = ws.onclose;
          ws.onclose = (ev) => {
            try { if (prev) prev(ev); } catch (_) {}
            resolve({ code: ev && ev.code, reason: ev && ev.reason });
          };
        });
        const codeName =
          closeInfo.code === 1000 ? 'clean'
          : closeInfo.code === 1001 ? 'going-away'
          : closeInfo.code === 1006 ? 'abnormal (no close frame — TCP drop / device unreachable)'
          : closeInfo.code === 1011 ? 'server-error'
          : closeInfo.code == null ? closeInfo.reason
          : `code=${closeInfo.code}`;
        const sessionMs = connectedSinceMs > 0
          ? Math.round(performance.now() - connectedSinceMs)
          : 0;
        // "Short" only counts when the session never proved itself
        // useful (no log/data ever arrived) AND was brief. A session
        // that streamed data — even for 50 ms — is HEALTHY by
        // definition; killing it is the peer's problem, not ours,
        // and we should not punish the next reconnect with multi-
        // second backoff. The old `sessionMs < SHORT_SESSION_MS` rule
        // misfired on rapid forced-close test patterns AND on real
        // user flows where the user might disconnect/reconnect by
        // toggling devices.
        const isShort = sessionMs > 0
                        && sessionMs < SHORT_SESSION_MS
                        && !gotDataInSession;
        if (isShort) consecutiveShortSessions++; else consecutiveShortSessions = 0;
        connectedSinceMs = 0;
        // Pass isShort to teardown so the noisy "teardown after
        // connected" warn drops to debug-only for chronic-cycling
        // short sessions. Escalate back to warn once cycling
        // persists (consecutiveShortSessions >= 3) — that's where
        // it stops being the known wobble and becomes a real
        // problem worth seeing.
        const shortAndQuiet = isShort && consecutiveShortSessions < 3;
        teardown(`eof: ${codeName} (session lasted ${sessionMs}ms)`,
                 { isShort: shortAndQuiet });
        consecutiveEarlyFails = 0;
        // Short-session backoff: fast retry early (the typical case
        // is ONE short session followed by a stable one — waiting
        // seconds in between just delays the user's data). Escalate
        // only if cycling persists, which means the device is really
        // unreachable or in trouble, not the chronic 1-cycle wobble.
        // Sequence: 250 ms, 750 ms, 2 s, 5 s, 12 s, 30 s (cap).
        if (isShort) {
          const SHORT_BACKOFFS_MS = [250, 750, 2000, 5000, 12000, 30000];
          const idx = Math.min(consecutiveShortSessions - 1, SHORT_BACKOFFS_MS.length - 1);
          const backoff = SHORT_BACKOFFS_MS[idx];
          if (consecutiveShortSessions >= 3) {
            console.warn(TAG, `short session #${consecutiveShortSessions} (${sessionMs}ms) — backing off ${backoff}ms — sustained cycling, device may be unreachable`);
          } else {
            dlog(`short session #${consecutiveShortSessions} (${sessionMs}ms) — backing off ${backoff}ms`);
          }
          await sleep(backoff);
        } else {
          await sleep(RECONNECT_OK_MS);
        }
      } catch (e) {
        teardown(String(e && e.message || e));
        // Exponential backoff for the page-load-race burst: when we
        // haven't successfully connected yet AND attempts keep failing,
        // each retry within Firefox's post-load settle window prints
        // a fresh "interrupted while the page was loading" warning.
        // Backing off 1.5 → 3 → 6 → 10 s cuts the warning count from
        // ~5 to ~2 in the typical reload-and-recover case, without
        // adding meaningful latency once the device is actually live
        // (one success resets the counter to 0). Capped at 10 s so
        // we don't wait forever if the device truly is down.
        if (!everConnected) {
          consecutiveEarlyFails++;
          const backoff = Math.min(10000, RECONNECT_ERR_MS * Math.pow(2, consecutiveEarlyFails - 1));
          await sleep(backoff);
        } else {
          await sleep(RECONNECT_ERR_MS);
        }
      }
    }
    dlog('connectLoop exited');
  }

  function watchIp() {
    if (ipWatchHandle) return;
    ipWatchHandle = setInterval(() => {
      if (stopped) return;
      const ip = getIp();
      // Only close on a CHANGE to a different non-null IP. A transient
      // null (the device-select dropdown briefly losing its value
      // during ide.js's re-render, or hardware.js repopulating the
      // list) used to kill the live WS — manifested as repeating
      // connected → reconnecting → connected cycles, each carrying
      // only a brief burst of data before the next close. The user
      // can still explicitly clear the device (picks empty option in
      // the dropdown); that's reflected by knownIp staying at the old
      // value until they pick a new IP, at which point we'll re-target.
      if (ip && ip !== knownIp && ws) {
        console.warn(TAG, `watchIp closing WS — ip changed from ${JSON.stringify(knownIp)} to ${JSON.stringify(ip)}`);
        try { ws.close(); } catch (_) {}
      }
    }, IP_CHECK_MS);
  }

  function watchStall() {
    if (stallHandle) return;
    stallHandle = setInterval(() => {
      if (stopped || paused || !ws) return;
      if (lastByteMs === 0) return;
      const quietMs = Math.round(performance.now() - lastByteMs);
      if (quietMs > STALL_MS) {
        // Include readyState + quiet duration so a future report makes
        // it obvious whether the connection was actually dead
        // (readyState=CLOSING/CLOSED) or the main thread was just busy
        // (readyState=OPEN, quietMs only marginally past STALL_MS).
        const rs = ws.readyState;
        const rsName = rs === 0 ? 'CONNECTING' : rs === 1 ? 'OPEN'
                     : rs === 2 ? 'CLOSING'    : rs === 3 ? 'CLOSED'
                     : `?(${rs})`;
        console.warn(TAG, `stall detected (${quietMs} ms quiet, ws=${rsName}); closing for reconnect`);
        try { ws.close(); } catch (_) {}
      }
    }, STALL_CHECK_MS);
  }

  // Visibility/online wake check. The intent is to catch the case
  // where the browser threw out the WS while the tab was hidden,
  // hadn't surfaced the close yet, and we want to force-reconnect on
  // refocus. The danger: a backgrounded tab also DEFERS WS message
  // dispatch — lastByteMs looks stale (often 5-10 s) at the exact
  // moment of refocus even though queued messages are about to flush.
  // Closing immediately murders a healthy connection and triggers a
  // reconnect cycle.
  //
  // Mitigations here:
  //  1. lastByteMs === 0 → fresh WS, never closes (was a bug; would
  //     trip on a WS that just opened before its first byte arrived).
  //  2. After a wake event, defer the staleness check by 1.5 s so any
  //     deferred-dispatch messages get a chance to land and tick
  //     lastByteMs. If the connection is genuinely dead, lastByteMs
  //     will still be stale after 1.5 s and we close. If it was just
  //     queued-but-alive, lastByteMs gets fresh and we leave it alone.
  let visibilityWakePending = null;
  function scheduleVisibilityWake(source) {
    if (visibilityWakePending) clearTimeout(visibilityWakePending);
    visibilityWakePending = setTimeout(() => {
      visibilityWakePending = null;
      if (stopped || paused || !ws) return;
      if (lastByteMs === 0) return;          // fresh WS, no frames yet
      const age = performance.now() - lastByteMs;
      if (age < 2000) return;                // recently saw a frame; healthy
      console.warn(TAG, `${source} wake closing WS — lastByteMs age=${Math.round(age)}ms`);
      try { ws.close(); } catch (_) {}
    }, 1500);
  }

  // -- Init / public API -------------------------------------------

  function init(opts) {
    if (opts && opts.getIp)    getIp    = opts.getIp;
    if (opts && opts.getToken) getToken = opts.getToken;
    dlog('init; ip:', getIp(), 'origin:', window.location && window.location.origin);
    watchIp();
    watchStall();
    window.addEventListener('online', () => scheduleVisibilityWake('online'));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleVisibilityWake('visibility');
    });
    connectLoop();
  }

  function defaultGetIp() {
    try {
      const sel = document.getElementById('ide-device-select');
      return sel && sel.value ? sel.value : null;
    } catch (_) { return null; }
  }

  function defaultGetToken() {
    const el = document.getElementById('ide-auth-token');
    return el ? el.value || '' : '';
  }

  function bootstrap() {
    init({ getIp: defaultGetIp, getToken: defaultGetToken });
  }

  window.Conduit = window.Conduit || {};
  window.Conduit.stream = {
    // WS open + handshake + auth complete + initial STATUS frame
    // received. Use for "can I send a cmd?" decisions.
    isConnected() { return streamConnected; },
    // WS connected AND a LOG/DATA frame arrived within the last
    // DATA_RECENT_MS. This is the right signal for the UI "green LED"
    // indicator: STATUS and NOTICE frames don't count as "streaming"
    // — they're just the handshake bookkeeping. Without this
    // distinction the LED briefly painted green on every STATUS push
    // (every reconnect, every link-change notice) even if no real
    // telemetry / log followed. Keepalive DATA frames DO count —
    // they're the firmware's "I'm alive" heartbeat (every ~500 ms
    // when the data ring is otherwise idle).
    isStreaming() {
      return streamConnected
          && lastDataMs > 0
          && (performance.now() - lastDataMs) < DATA_RECENT_MS;
    },
    // Current-session stability. True iff the WS is connected AND
    // the current session has held streamConnected continuously for
    // at least STABLE_MS. Non-sticky on purpose: when the live link
    // dies (cable yank, device reboot, page-load WS cycle) this
    // immediately returns false, and the consumer UI returns to its
    // 'connecting' spinner instead of flickering through the brief
    // sessions of a reconnect cycle. A real momentary outage
    // produces a brief spinner; the underlying transport-layer
    // cycling never reaches the green LED at all.
    isStable() {
      return streamConnected
          && connectedSinceMs > 0
          && (performance.now() - connectedSinceMs) >= STABLE_MS;
    },
    currentUrl()  { return lastUrl; },
    // ws-probe-equivalent timings for the most recent openOnce().
    // {t_open_ms, t_auth_reply_ms, t_status_ms, total_ms, ok, at}.
    // .total_ms is the metric to diff against `conduit ws-probe`'s
    // total_ms; the IDE's cycle should land in the same ballpark
    // (~15 ms typical against a LAN device).
    lastTimings() { return { ...lastTimings }; },
    timingsHistory() { return timingsHistory.slice(); },
    // Latest STATUS frame the device pushed over the WS. Returns null
    // if no STATUS has landed yet this page-load. The returned object
    // is the same shape `fetch('/api/status')` produces — use it to
    // avoid the cold-TLS-handshake cost of a separate HTTPS GET when
    // the WS already has the data you'd be asking for.
    lastStatus() { return lastStatusObj ? { ...lastStatusObj } : null; },
    // Age in ms since the last STATUS frame was received (Infinity if
    // none yet). Useful for callers that want a "recent" status only.
    lastStatusAgeMs() {
      return lastStatusObj == null ? Infinity
                                   : (performance.now() - lastStatusAtMs);
    },
    // Test-only: returns the underlying live WebSocket so a harness can
    // ws.close() it to drive a reconnect cycle (matches the protocol-level
    // close ws-probe sends at the end of each cycle). Not for app code —
    // every other consumer should go through the cmd / onStatus / onData
    // surfaces above. Underscore prefix flags "internal".
    _socket() { return ws; },
    cmd,
    onLog(cb)    { if (typeof cb === 'function') logSubs.add(cb);    return () => logSubs.delete(cb); },
    onData(cb)   { if (typeof cb === 'function') dataSubs.add(cb);   return () => dataSubs.delete(cb); },
    onStatus(cb) { if (typeof cb === 'function') statusSubs.add(cb); return () => statusSubs.delete(cb); },
    onNotice(cb) { if (typeof cb === 'function') noticeSubs.add(cb); return () => noticeSubs.delete(cb); },
    onNextConnect(cb) {
      if (typeof cb !== 'function') return () => {};
      connectListeners.push(cb);
      return () => { connectListeners = connectListeners.filter((x) => x !== cb); };
    },
    onDisconnect(cb) {
      if (typeof cb !== 'function') return () => {};
      disconnectListeners.push(cb);
      return () => { disconnectListeners = disconnectListeners.filter((x) => x !== cb); };
    },
    pause() {
      // External pause (OTA flow). Keep the live WS alive (do NOT
      // close it — closing at OTA-upload time tripped Firefox's
      // connection-reuse on the OPTIONS preflight, showing as
      // "CORS request did not succeed. Status code: (null)"). But
      // ALSO stop the connectLoop from retrying once the existing
      // WS dies during the device's reboot. Without that block, the
      // loop hammers 4-7 retries against a down device in the ~10 s
      // reboot window — each one prints Firefox's "Firefox can't
      // establish a connection" + "interrupted while the page was
      // loading" pair to the console. Cleaner UX: silence during
      // expected offline, noisy on unexpected drops.
      // Subscribers (console.js/telemetry.js) gate their data on
      // their own paused flags, so no UI churn either way.
      if (paused) return;
      paused = true;
      dlog('paused (external) — WS stays alive; new connect attempts suppressed');
    },
    resume() {
      if (!paused) return;
      paused = false;
      dlog('resumed');
      // Wake the connectLoop if it was parked on pauseWaiter. It will
      // immediately try one connect against (hopefully) the device's
      // post-OTA firmware; the existing onNextConnect listener (set
      // by ide.js as fastReady) fires on the first STATUS frame.
      if (pauseWaiter) { pauseWaiter(); pauseWaiter = null; }
    },
    stop() {
      stopped = true;
      teardown('stopped');
      if (pauseWaiter) { pauseWaiter(); pauseWaiter = null; }
      if (stallHandle)   { clearInterval(stallHandle);   stallHandle = null; }
      if (ipWatchHandle) { clearInterval(ipWatchHandle); ipWatchHandle = null; }
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
