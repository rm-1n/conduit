// console.js — tails /api/log from the selected device, parses on-device
// timestamps, renders the messages into #ide-console, and persists the
// stream into IndexedDB (see web/log_store.js) for later HDF5 export.
//
// Transport: persistent stream (see firmware/app/http_server.c handle_log):
//   GET /api/log?since=N&stream=1   → server holds the TCP connection open
//                                     and writes new bytes as conduit_log()
//                                     produces them. One request per run.
//
// Wire record: each conduit_log() call emits "[<uptime_us>]\t<message>\n".
// The timestamp prefix is assigned on-device at format time so the record's
// `uptime_us` is not distorted by stream/network/browser delay.
//
// Parser: we accumulate bytes across chunk boundaries and only process
// complete "\n"-terminated lines. A line that starts with the prefix
// regex is a new record; a line that doesn't is a continuation of the
// previous record (inherits its uptime). The FIRST record of a connection
// anchors wall-clock: we pair Date.now() at stream open with its uptime_us
// to compute `wall_ms_offset`, which is then applied to every record for
// the session.
//
// Runs: a "run" is a contiguous span of monotonic uptime. If uptime goes
// backwards across a reconnect, the device rebooted — we open a new run
// with a fresh stream_epoch (and fresh wall-clock anchor).

(function () {
  'use strict';

  // RECONNECT_OK_MS / RECONNECT_ERR_MS / CONNECT_TIMEOUT_MS / STALL_MS
  // — see telemetry.js for rationale. Tightened now that the firmware-
  // side malloc-panic deadlock is fixed.
  const RECONNECT_OK_MS    = 500;
  const RECONNECT_ERR_MS   = 1500;
  const IP_CHECK_MS        = 1000;
  const MAX_BUFFER_CHARS   = 200_000;
  const PENDING_MAX_CHARS  = 100_000;
  const PERSIST_BATCH_MAX  = 50;     // flush to IndexedDB after N records or…
  const PERSIST_BATCH_MS   = 250;    // …after M ms idle, whichever hits first.
  const CONNECT_TIMEOUT_MS = 15000;
  const STALL_MS           = 10000;
  const STALL_CHECK_MS     = 500;
  // Prefix regex: "[<digits>]\t<msg>". The greedy `(.*)$` captures the entire
  // rest of the line, including any literal "[...]\t" the user may have
  // written inside their format string.
  const PREFIX_RE = /^\[(\d+)\]\t(.*)$/;

  let consoleEl = null;
  let stateEl = null;
  let clearBtn = null;
  let pauseBtn = null;
  let tsToggleBtn = null;
  let downloadBtn = null;
  let getIp = () => null;

  let cursor = null;            // firmware byte-cursor; persists across reconnects
  let knownIp = null;
  let stopped = false;
  let paused = false;           // user "Pause output" toggle — display-only
  let streamPaused = false;     // external OTA pause — stops the fetch entirely
  let streamPauseWaiter = null; // promise resolver to wake streamLoop on resume
  // Tracks "we're inside an active runStream past the headers" — set
  // when setStage('connected') fires, cleared on stream end or pause.
  // Exposed via isStreamConnected() so telemetry.js can stagger its
  // own connect attempts behind a confirmed console connect (user
  // pref: console first, then chart, so log lines surface before the
  // chart pane fights for mbedtls slab time).
  let streamConnected = false;
  let pendingBuf = '';          // incoming display text while paused
  let lastStateText = '';
  let lastStateCls = '';
  let activeAbort = null;
  let ipWatchHandle = null;
  // Last time bytes (real or keepalive `\n`) arrived on the active
  // stream. 0 while connecting / between streams. Drives the stall
  // watchdog below; firmware emits a keepalive every ~500 ms so any
  // value > STALL_MS means the underlying TCP is dead even though
  // fetch() hasn't surfaced an error.
  let lastByteMs = 0;
  let stallHandle = null;

  // One-shot "next successful runStream open" listeners. Used by
  // ide.js's onBuildUpload to detect "device is back" the instant the
  // stream's auto-reconnect lands a fresh response post-reboot — no
  // /api/status polling required. Each listener fires AT MOST ONCE
  // and is removed; this is intentionally not a sticky event since
  // every consumer we have just wants the next post-trigger connect.
  let connectListeners = [];
  function fireConnect() {
    if (!connectListeners.length) return;
    const pending = connectListeners;
    connectListeners = [];
    for (const cb of pending) { try { cb(); } catch (_) {} }
  }

  let showTimestamps = false;

  // --- Parser + persistence state --------------------------------------

  // `currentRun` is null until the first record of the session arrives.
  // On reboot detection we replace it and its stream_epoch changes.
  let currentRun = null;        // { streamEpoch, wallMsOffset, lastUptimeUs }
  let pendingLine = '';         // bytes split across chunks
  let lastUptimeUs = null;      // last uptime seen; used for reboot detection
  let wallMsAnchor = null;      // Date.now() at fetch open, consumed by first record
  let persistBatch = [];        // records waiting to be flushed
  let persistTimer = null;

  function persistFlush() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (persistBatch.length === 0) return;
    const batch = persistBatch;
    persistBatch = [];
    const store = window.Conduit && window.Conduit.logStore;
    if (!store) return;
    store.append(batch).catch((e) => {
      // Non-fatal — display keeps working even if storage fails.
      // Surface once so the user can debug quota / permission issues.
      if (!persistFlush._warned) {
        persistFlush._warned = true;
        console.warn('[console] log_store.append failed:', e);
      }
    });
  }

  function enqueuePersist(rec) {
    persistBatch.push(rec);
    if (persistBatch.length >= PERSIST_BATCH_MAX) {
      persistFlush();
    } else if (!persistTimer) {
      persistTimer = setTimeout(persistFlush, PERSIST_BATCH_MS);
    }
  }

  // --- UI helpers ------------------------------------------------------

  // Discriminated state machine — same shape as telemetry.js.
  //   'connected' | 'no data' | 'reconnecting' | 'paused' | 'no device'
  //   | 'disconnected' | 'updating…'
  let currentStage = 'disconnected';
  let stageEnteredAt = 0;
  // Braille spinner used to animate the 'connecting' label so the
  // user can see the IDE is actively trying to come up (vs frozen).
  // Frames cycle through the 10 standard "loading" braille glyphs.
  // The fallback chain in --font-mono (Menlo / Consolas / etc.) all
  // have braille (U+28xx) coverage so the glyph renders cleanly even
  // though Roboto Mono itself is Latin-only.
  const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const SPINNER_INTERVAL_MS = 80;
  let spinnerHandle = null;
  let spinnerIdx = 0;
  function startSpinner() {
    if (spinnerHandle) return;
    spinnerIdx = 0;
    if (stateEl) stateEl.textContent = `connecting ${SPINNER_FRAMES[0]}`;
    spinnerHandle = setInterval(() => {
      if (!stateEl || currentStage !== 'connecting' || paused) return;
      spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
      stateEl.textContent = `connecting ${SPINNER_FRAMES[spinnerIdx]}`;
    }, SPINNER_INTERVAL_MS);
  }
  function stopSpinner() {
    if (spinnerHandle) { clearInterval(spinnerHandle); spinnerHandle = null; }
  }
  function setStage(stage) {
    currentStage = stage;
    stageEnteredAt = performance.now();
    streamConnected = (stage === 'connected');
    renderStage();
  }
  function renderStage() {
    let text, cls;
    switch (currentStage) {
      case 'connected':
        text = 'connected'; cls = 'ok'; break;
      case 'connecting':
        text = 'connecting'; cls = ''; break;
      case 'no data':
        text = 'no data'; cls = 'err'; break;
      case 'reconnecting':
        text = 'reconnecting…'; cls = 'err'; break;
      case 'paused':       text = 'paused';       cls = '';    break;
      case 'no device':    text = 'no device';    cls = '';    break;
      case 'updating…':    text = 'updating…';    cls = '';    break;
      case 'disconnected': text = 'disconnected'; cls = '';    break;
      default:             text = currentStage;   cls = '';    break;
    }
    lastStateText = text;
    lastStateCls = cls;
    if (!stateEl) return;
    if (paused) return;
    if (currentStage === 'connecting') {
      startSpinner();             // spinner owns textContent
    } else {
      stopSpinner();
      stateEl.textContent = text;
    }
    stateEl.setAttribute('data-state',
      cls === 'ok' ? 'ok' : cls === 'err' ? 'err' : 'off');
  }
  // Back-compat shim for legacy call sites in this file.
  function setState(text, cls) {
    if (text === 'connected')         setStage('connected');
    else if (text === 'paused')       setStage('paused');
    else if (text === 'no device')    setStage('no device');
    else if (text === 'updating…')    setStage('updating…');
    else if (text === 'reconnecting…' || text === 'reconnecting') setStage('reconnecting');
    else setStage('disconnected');
  }

  // Low-level render: append text to the DOM console, respect pause,
  // bound scrollback, preserve scroll-locked-to-bottom behaviour.
  function renderAppend(text) {
    if (!text) return;
    if (paused) {
      pendingBuf += text;
      if (pendingBuf.length > PENDING_MAX_CHARS) {
        pendingBuf = pendingBuf.slice(pendingBuf.length - PENDING_MAX_CHARS);
      }
      updatePauseState();
      return;
    }
    const existing = consoleEl.textContent;
    let next = existing + text;
    if (next.length > MAX_BUFFER_CHARS) {
      next = next.slice(next.length - MAX_BUFFER_CHARS);
    }
    const atBottom =
      consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 8;
    consoleEl.textContent = next;
    if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function updatePauseState() {
    if (pauseBtn) {
      // Pause toggle uses an icon-only button now; the play_arrow
      // glyph means "click to resume", pause means "click to pause".
      // Pending-byte count goes in the title since there's no label.
      const icons = window.Conduit && window.Conduit.icons;
      if (icons) icons.set(pauseBtn, paused ? 'play_arrow' : 'pause', { size: 14 });
      const baseTitle = paused ? 'Resume' : 'Pause';
      pauseBtn.title = paused && pendingBuf.length > 0
        ? `${baseTitle} (${pendingBuf.length} B buffered)`
        : baseTitle;
      pauseBtn.setAttribute('aria-label', baseTitle);
      pauseBtn.classList.toggle('is-active', paused);
    }
    if (!stateEl) return;
    if (paused) {
      stateEl.textContent = 'paused';
      stateEl.setAttribute('data-state', 'off');
    } else {
      stateEl.textContent = lastStateText;
      stateEl.setAttribute('data-state',
        lastStateCls === 'ok' ? 'ok' : lastStateCls === 'err' ? 'err' : 'off');
    }
  }

  function setPaused(next) {
    if (paused === next) return;
    paused = next;
    if (!paused && pendingBuf.length > 0) {
      const flush = pendingBuf;
      pendingBuf = '';
      renderAppend(flush);
    }
    updatePauseState();
  }

  function reset(reason) {
    consoleEl.textContent = reason ? `── ${reason} ──\n` : '';
    cursor = null;
    pendingLine = '';
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // --- Record handling -------------------------------------------------

  // Called once per wire line. `line` does NOT include its trailing "\n".
  // Decides whether it's a new record (prefix match) or a continuation of
  // the previous record (inherits lastUptimeUs); computes wall-clock;
  // commits to IndexedDB and the visible console.
  async function processLine(line) {
    // Drop pure-empty lines: they're emitted as keepalives by
    // firmware http_poll when the log ring is silent (see
    // STREAM_KEEPALIVE_MS). The byte still feeds our stall watchdog
    // via lastByteMs at the chunk level — we just don't render or
    // persist a blank line.
    if (line === '') return;
    const m = line.match(PREFIX_RE);
    let uptimeUs, msg;
    if (m) {
      uptimeUs = Number(m[1]);
      msg = m[2];
      // Strip a stray "<digits>]\t" tail from the front of msg. After a
      // cable cycle the byte stream occasionally repeats the prior
      // prefix's bytes around the boundary, leaving the corrupted form
      // "[<ts1>]\t<partial-ts2>]\t<real-msg>". The first ts is real;
      // <partial-ts2>]\t is debris and would render as ugly noise.
      const dup = msg.match(/^\d+\]\t(.*)$/);
      if (dup) msg = dup[1];
      // Reboot detection: a strictly-smaller uptime means the device
      // rebooted. Flush any in-flight batch to the OLD run before we flip.
      if (currentRun && lastUptimeUs !== null && uptimeUs + 1_000_000 < lastUptimeUs) {
        persistFlush();
        currentRun = null;
      }
      lastUptimeUs = uptimeUs;
    } else {
      // Continuation (rare — conduit_log callers generally end with "\n"),
      // OR a real record whose leading "[" got eaten at a chunk boundary
      // and arrived as "<digits>]\t<msg>" with no anchor. Strip that
      // debris too — same reasoning as the dup-strip in the matched
      // branch above; without it, the raw "<digits>]\t" renders as a
      // garbage prefix on an otherwise-clean line.
      if (lastUptimeUs === null) return;
      uptimeUs = lastUptimeUs;
      const orphan = line.match(/^\d+\]\t(.*)$/);
      msg = orphan ? orphan[1] : line;
    }

    // First record of a run: anchor wall-clock and open the run
    // metadata. Don't await IDB on the hot path — Firefox's IDB has
    // been observed to hang startRun() indefinitely (no resolve, no
    // reject), wedging the entire console. Mint streamEpoch from
    // Date.now() and persist run metadata in the background. See the
    // matching comment in telemetry.js drain() for the full story.
    if (!currentRun) {
      const anchor = (wallMsAnchor != null) ? wallMsAnchor : Date.now();
      const offset = anchor - (uptimeUs / 1000);
      const streamEpoch = Date.now();
      currentRun = { streamEpoch, wallMsOffset: offset, lastUptimeUs: uptimeUs };
      const store = window.Conduit && window.Conduit.logStore;
      if (store && store.startRun) {
        store.startRun({
          streamEpoch,
          deviceIp: knownIp || '',
          wallMsAnchor: anchor,
          uptimeUsAnchor: uptimeUs,
          wallMsOffset: offset,
        }).catch(() => { /* non-fatal — run-index entry is for export only */ });
      }
    }

    const wallMs = currentRun.wallMsOffset + (uptimeUs / 1000);
    enqueuePersist({
      stream_epoch: currentRun.streamEpoch,
      uptime_us: uptimeUs,
      wall_ms: wallMs,
      msg,
    });

    if (showTimestamps) {
      renderAppend(`[${uptimeUs}]\t${msg}\n`);
    } else {
      renderAppend(`${msg}\n`);
    }
  }

  // Incoming chunk → split on "\n" → processLine per complete line.
  // Bytes after the last "\n" are held in pendingLine.
  async function ingestChunk(text) {
    pendingLine += text;
    let nl;
    while ((nl = pendingLine.indexOf('\n')) !== -1) {
      const line = pendingLine.slice(0, nl);
      pendingLine = pendingLine.slice(nl + 1);
      // Process lines sequentially so startRun()'s awaited IndexedDB
      // open completes before subsequent records are enqueued.
      await processLine(line);
    }
  }

  // The HTTP /api/log fetch path has been retired. stream.js (the
  // unified WebSocket transport) is now the SOLE data source — see
  // attachToStream() below for the subscription. Reconnect, stall
  // detection, and IP-change handling live entirely in stream.js;
  // this module is a thin renderer + parser.

  // --- stream.js bridge -----------------------------------------------

  function attachToStream() {
    const s = window.Conduit && window.Conduit.stream;
    if (!s) {
      console.warn('[console] window.Conduit.stream missing — log pane will be inert');
      return;
    }

    s.onLog((text) => {
      if (stopped || streamPaused) return;
      // The pre-stability drop gate that used to live here (`if
      // (!s.isStable()) return;`) was a workaround for the Firefox
      // page-load 2.8 s WS-abort cycle: it would suppress the
      // "first 2.5 s of data" that would otherwise flash on screen
      // and then disappear when the WS got killed. Now that TLS
      // session tickets are on, the reconnect cycle is ~50 ms — way
      // below the threshold of visible flicker — and the legacy 5 s
      // suppression was driving the "10/10 dis/reconnects in <2 s"
      // metric to fail outright (data never showed for the first 5 s
      // of every session). Drop it; deliver every log line as it
      // arrives. The LED still gates "green" on `isStreaming()` —
      // see the indicator state-machine below.
      //
      // Also nudge the LED green RIGHT NOW (the indicator
      // setInterval below would otherwise lag up to 500 ms). The
      // arrival of a real log frame is itself proof of streaming;
      // we don't need the indicator's next poll tick to discover it.
      if (currentStage !== 'connected' && !paused && !streamPaused) {
        setStage('connected');
      }
      ingestChunk(text).catch(() => {});
    });

    s.onNextConnect(() => fireConnect());

    // Console pane state machine — driven entirely by stream.js now
    // that the legacy /api/log fetch path is gone. Six stages:
    //   'paused'       — user toggle (display only)
    //   'updating…'    — OTA pause (ide.js called pauseStream)
    //   'no device'    — getIp() returns null
    //   'connected'    — stream.isStreaming() — WS open AND data flowing
    //   'no data'      — stream.isConnected() but no recent frames
    //   'reconnecting' — WS closed or never opened yet
    // Note: green ('connected') requires actively-flowing data, not
    // just an open socket. A briefly-open WS that cycles before any
    // bytes arrive (e.g. the recent watchIp false-positive close)
    // never reaches 'connected' — the indicator stays honest.
    setInterval(() => {
      if (stopped) return;
      if (paused) return;                         // user pause owns the indicator
      if (streamPaused) { setStage('updating…'); return; }
      if (!getIp()) { setStage('no device'); return; }
      // Binary indicator: green-'connected' as soon as we're seeing
      // recent frames (`isStreaming()` — WS open AND data within the
      // last DATA_RECENT_MS); spinner-'connecting' otherwise.
      // Previously also required `isStable()` (5 s of continuous
      // connect time) to suppress flicker through the Firefox 2.8 s
      // WS-abort cycle on page load — but with session tickets the
      // reconnect cycle is ~50 ms and the LED-up budget can no
      // longer absorb the extra 5 s. `isStreaming()` alone is
      // self-throttling (any genuine outage stops data within
      // DATA_RECENT_MS and the LED reverts to spinner) so the
      // resulting transitions are still calm.
      if (s.isStreaming()) {
        if (currentStage !== 'connected') setStage('connected');
      } else if (currentStage !== 'connecting') {
        setStage('connecting');
      }
    }, 500);
  }

  // --- Init / public API -----------------------------------------------

  function init(opts) {
    consoleEl = document.getElementById('ide-console');
    stateEl = document.getElementById('ide-console-state');
    clearBtn = document.getElementById('ide-console-clear');
    pauseBtn = document.getElementById('ide-console-pause');
    tsToggleBtn = document.getElementById('ide-console-ts');
    downloadBtn = document.getElementById('ide-console-download');
    if (!consoleEl) return;
    getIp = opts.getIp || (() => null);

    reset(null);
    setState('disconnected', '');

    if (clearBtn) clearBtn.addEventListener('click', () => {
      consoleEl.textContent = '';
      pendingBuf = '';
      updatePauseState();
    });
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => setPaused(!paused));
      // Paint the initial glyph — updatePauseState normally only runs
      // on toggle, so without this the button starts visually empty
      // (no icon, just a thin frame) until the user first clicks it.
      updatePauseState();
    }
    if (tsToggleBtn) {
      // Icon-only button — aria-pressed drives the visual highlight via
      // CSS; the glyph (clock) doesn't change between states.
      tsToggleBtn.addEventListener('click', () => {
        showTimestamps = !showTimestamps;
        tsToggleBtn.setAttribute('aria-pressed', showTimestamps ? 'true' : 'false');
        tsToggleBtn.title = showTimestamps ? 'Hide on-device timestamps'
                                           : 'Show on-device timestamps';
      });
      tsToggleBtn.setAttribute('aria-pressed', showTimestamps ? 'true' : 'false');
    }
    // Download button moved to the telemetry pane (ide-telemetry-download)
    // so it can produce a single bundle covering BOTH telemetry and the
    // runtime log. Wired in ide.js, which calls into our flushPersist()
    // before invoking the exporter.

    attachToStream();

    window.Conduit = window.Conduit || {};
    window.Conduit.console = {
      clear() { consoleEl.textContent = ''; pendingBuf = ''; updatePauseState(); },
      // No-op kept for caller compatibility — there is no cursor to
      // reset when stream.js is the data source (it always live-tails).
      resetCursor() {},
      // Force a stream reconnect — used by external observers (e.g.
      // telemetry's connectivity hooks) that want to nudge a half-dead
      // connection back to life. Delegated to stream.js's pause+resume
      // which cycles the WS cleanly.
      kick() {
        const s = window.Conduit && window.Conduit.stream;
        if (!s) return;
        s.pause();
        setTimeout(() => s.resume(), 10);
      },
      // Inject a browser-side note (connection events, refresh outcomes,
      // etc.) into the runtime console pane. Tagged so the user can tell
      // it apart from device-emitted log lines.
      note(text, level) {
        if (!text) return;
        const tag = level === 'err'  ? '[err]'
                  : level === 'ok'   ? '[ok] '
                  :                    '[…] ';
        renderAppend(`${tag} ${text}\n`);
      },
      stop() {
        stopped = true;
        persistFlush();
      },
      // External "pause the data flow" for OTA flows. ide.js calls
      // pauseStream() before the upload so the WS is fully down for
      // the duration of the OTA — keeping mbedtls focused on the
      // upload's TLS session alone. resumeStream() reopens after the
      // device boots the new firmware. Delegates to stream.js.
      pauseStream() {
        if (streamPaused) return;
        streamPaused = true;
        persistFlush();
        currentRun = null;
        lastUptimeUs = null;
        const s = window.Conduit && window.Conduit.stream;
        if (s) s.pause();
      },
      resumeStream() {
        if (!streamPaused) return;
        streamPaused = false;
        currentRun = null;
        lastUptimeUs = null;
        const s = window.Conduit && window.Conduit.stream;
        if (s) s.resume();
      },
      setPaused,
      isPaused() { return paused; },
      // True when the WS stream is in the connected state. Used by
      // telemetry.js's legacy gating contract; with stream.js as the
      // single transport, both panes are in the same state at the
      // same time anyway, so the value matches stream.isConnected().
      isStreamConnected() {
        const s = window.Conduit && window.Conduit.stream;
        return !!(s && s.isConnected());
      },
      onNextConnect(cb) {
        if (typeof cb !== 'function') return () => {};
        connectListeners.push(cb);
        return () => {
          connectListeners = connectListeners.filter((x) => x !== cb);
        };
      },
      setShowTimestamps(v) {
        showTimestamps = !!v;
        if (tsToggleBtn) {
          tsToggleBtn.setAttribute('aria-pressed', showTimestamps ? 'true' : 'false');
        }
      },
      flushPersist() { persistFlush(); },
    };
  }

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
