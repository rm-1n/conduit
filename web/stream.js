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

  const RECONNECT_OK_MS    = 500;
  const RECONNECT_ERR_MS   = 1500;
  const CONNECT_TIMEOUT_MS = 10000;
  const STALL_MS           = 5000;
  const STALL_CHECK_MS     = 500;
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
  let lastByteMs    = 0;
  let stallHandle   = null;
  let ipWatchHandle = null;
  let connectTimer  = null;

  let streamConnected = false;
  let lastUrl         = null;

  let nextSeq = 1;
  const pendingCmds = new Map();    // seq -> {resolve, reject, timer, label}

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

  function dispatchStatus(jsonText) {
    let obj;
    try { obj = JSON.parse(jsonText); } catch (_) { return; }
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
    lastByteMs = performance.now();
    if (typeof ev.data === 'string') {
      if (ev.data.length === 0) return;
      const ch = ev.data.charCodeAt(0);
      const body = ev.data.slice(1);
      switch (ch) {
        case CH_LOG:    dispatchLog(body);    break;
        case CH_CMD:    dispatchCmd(body);    break;
        case CH_STATUS: dispatchStatus(body); break;
        case CH_NOTICE: dispatchNotice(body); break;
        default:        /* drop unknown text channel */ break;
      }
    } else if (ev.data instanceof ArrayBuffer) {
      const u8 = new Uint8Array(ev.data);
      if (u8.byteLength === 0) return;
      if (u8[0] === CH_DATA) dispatchData(u8);
    } else if (ev.data && ev.data.arrayBuffer) {
      ev.data.arrayBuffer().then((buf) => {
        const u8 = new Uint8Array(buf);
        if (u8.byteLength > 0 && u8[0] === CH_DATA) dispatchData(u8);
      });
    }
  }

  // -- Connection lifecycle ----------------------------------------

  function clearConnectTimer() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  }

  function teardown(reason) {
    const wasConnected = streamConnected;
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
    lastByteMs = 0;
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

    const sock = new WebSocket(url);
    sock.binaryType = 'arraybuffer';
    ws = sock;

    return new Promise((resolve, reject) => {
      let settled = false;
      const onStatusOnce = () => {
        if (settled) return;
        settled = true;
        statusSubs.delete(onStatusOnce);
        dlog('ready (got STATUS frame)');
        streamConnected = true;
        lastByteMs = performance.now();
        clearConnectTimer();
        fireConnect();
        resolve();
      };
      statusSubs.add(onStatusOnce);

      sock.onopen = () => {
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
        // onclose right after will carry the real story.
        if (!settled) console.warn(TAG, 'socket error before ready');
      };
      sock.onclose = (ev) => {
        if (settled) {
          dlog('closed (post-ready):', ev.code, ev.reason || '');
          // Outer connectLoop's Promise-wrap picks this up.
          return;
        }
        settled = true;
        statusSubs.delete(onStatusOnce);
        console.warn(TAG, 'closed BEFORE ready:', ev.code, ev.reason || '');
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

  async function connectLoop() {
    dlog('connectLoop started');
    while (!stopped) {
      if (paused) {
        await new Promise((r) => { pauseWaiter = r; });
        pauseWaiter = null;
        if (stopped) break;
        continue;
      }
      const ip = getIp();
      if (ip !== knownIp) {
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
        await new Promise((resolve) => {
          if (!ws || ws.readyState === WebSocket.CLOSED) { resolve(); return; }
          const prev = ws.onclose;
          ws.onclose = (ev) => {
            try { if (prev) prev(ev); } catch (_) {}
            resolve();
          };
        });
        teardown('eof');
        await sleep(RECONNECT_OK_MS);
      } catch (e) {
        teardown(String(e && e.message || e));
        await sleep(RECONNECT_ERR_MS);
      }
    }
    dlog('connectLoop exited');
  }

  function watchIp() {
    if (ipWatchHandle) return;
    ipWatchHandle = setInterval(() => {
      if (stopped) return;
      const ip = getIp();
      if (ip !== knownIp && ws) {
        try { ws.close(); } catch (_) {}
      }
    }, IP_CHECK_MS);
  }

  function watchStall() {
    if (stallHandle) return;
    stallHandle = setInterval(() => {
      if (stopped || paused || !ws) return;
      if (lastByteMs === 0) return;
      if (performance.now() - lastByteMs > STALL_MS) {
        console.warn(TAG, 'stall detected; closing for reconnect');
        try { ws.close(); } catch (_) {}
      }
    }, STALL_CHECK_MS);
  }

  function onVisibilityWake() {
    if (stopped || paused || !ws) return;
    if (lastByteMs > 0 && performance.now() - lastByteMs < 1000) return;
    try { ws.close(); } catch (_) {}
  }

  // -- Init / public API -------------------------------------------

  function init(opts) {
    if (opts && opts.getIp)    getIp    = opts.getIp;
    if (opts && opts.getToken) getToken = opts.getToken;
    dlog('init; ip:', getIp(), 'origin:', window.location && window.location.origin);
    watchIp();
    watchStall();
    window.addEventListener('online', onVisibilityWake);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) onVisibilityWake();
    });
    connectLoop();
  }

  function defaultGetIp() {
    try {
      const sel = document.getElementById('ide-device-select');
      if (sel && sel.value) return sel.value;
      const fallback = document.getElementById('ide-quick-ip');
      return fallback && fallback.value.trim() ? fallback.value.trim() : null;
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
    isConnected() { return streamConnected; },
    currentUrl()  { return lastUrl; },
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
      // External pause (OTA flow). Just stop new connect attempts —
      // don't tear down the live WS. Closing the WS at the moment ide.js
      // opens a fresh TLS for /api/upload triggers Firefox to wedge the
      // OPTIONS preflight on connection-reuse races, showing as
      // "CORS request did not succeed. Status code: (null)". The WS
      // dies naturally a second later when the device reboots into
      // the new firmware, and connectLoop picks it back up via the
      // browser's onclose. The mbedtls slab has plenty of room for
      // one WS + one OTA session concurrently (sized for the old
      // four-conn design). Subscribers (console.js/telemetry.js)
      // already ignore inbound traffic while their local
      // streamPaused/paused flag is set, so no UI churn either.
      if (paused) return;
      paused = true;
      dlog('paused (external) — keeping WS alive for OTA-side TLS');
    },
    resume() {
      if (!paused) return;
      paused = false;
      dlog('resumed');
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
