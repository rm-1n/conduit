// console.js — tails /api/log from the selected device, parses on-device
// timestamps, renders the messages into #ide-console, and persists the
// stream into IndexedDB (see web/log_store.js) for later HDF5 export.
//
// Transport: persistent stream (see firmware/app/http_server.c handle_log):
//   GET /api/log?since=N&stream=1   → server holds the TCP connection open
//                                     and writes new bytes as poe_log()
//                                     produces them. One request per run.
//
// Wire record: each poe_log() call emits "[<uptime_us>]\t<message>\n".
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

  const RECONNECT_OK_MS    = 100;
  // Sleep between failed reconnect attempts. Matched to telemetry.js —
  // both streams share the same device, so retry cadence should agree.
  // Was 2 s; 750 ms makes cable replug recover in ≤1 s.
  const RECONNECT_ERR_MS   = 750;
  const IP_CHECK_MS        = 1000;
  const MAX_BUFFER_CHARS   = 200_000;
  const PENDING_MAX_CHARS  = 100_000;
  const PERSIST_BATCH_MAX  = 50;     // flush to IndexedDB after N records or…
  const PERSIST_BATCH_MS   = 250;    // …after M ms idle, whichever hits first.
  // Connect-phase timeout — same pattern as telemetry.js. A freshly
  // rebooted device that accepts the TCP but doesn't reply would
  // otherwise leave runStream stuck on `await fetch(...)` indefinitely
  // (the log stream may legitimately be silent for minutes once
  // connected, so we DON'T add a stall watchdog post-headers).
  // Was 5 s; 2.5 s is plenty for LAN handshake + first byte and keeps
  // the stale-state window short after a cable cut.
  const CONNECT_TIMEOUT_MS = 2500;
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
  let pendingBuf = '';          // incoming display text while paused
  let lastStateText = '';
  let lastStateCls = '';
  let activeAbort = null;
  let ipWatchHandle = null;

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
    const store = window.PicoPoE && window.PicoPoE.logStore;
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

  function setState(text, cls) {
    lastStateText = text;
    lastStateCls = cls || '';
    if (!stateEl) return;
    if (paused) return;
    stateEl.textContent = text;
    stateEl.setAttribute('data-state',
      cls === 'ok' ? 'ok' : cls === 'err' ? 'err' : 'off');
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
      const icons = window.PicoPoE && window.PicoPoE.icons;
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
    const m = line.match(PREFIX_RE);
    let uptimeUs, msg;
    if (m) {
      uptimeUs = Number(m[1]);
      msg = m[2];
      // Reboot detection: a strictly-smaller uptime means the device
      // rebooted. Flush any in-flight batch to the OLD run before we flip.
      if (currentRun && lastUptimeUs !== null && uptimeUs + 1_000_000 < lastUptimeUs) {
        persistFlush();
        currentRun = null;
      }
      lastUptimeUs = uptimeUs;
    } else {
      // Continuation (rare — poe_log callers generally end with "\n"). Drop
      // if we have no anchor yet (e.g. started mid-record after a ring
      // fast-forward); otherwise inherit the last record's uptime.
      if (lastUptimeUs === null) return;
      uptimeUs = lastUptimeUs;
      msg = line;
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
      const store = window.PicoPoE && window.PicoPoE.logStore;
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
      renderAppend(m ? `${msg}\n` : `${line}\n`);
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

  // --- Streaming loop --------------------------------------------------

  async function runStream(ip, signal) {
    const since = cursor === null ? 0 : cursor;
    const url = `http://${ip}/api/log?since=${since}&stream=1`;
    wallMsAnchor = Date.now();  // consumed by the first record of this run

    // Track first-byte arrival so the connect-timeout below can decide
    // whether to abort. Logs may be silent for long periods after the
    // connect lands — we ONLY want the timeout to fire if the response
    // never started, not if the device is just quiet.
    let firstByteSeen = false;
    const connectTimer = setTimeout(() => {
      if (!firstByteSeen && activeAbort && !signal.aborted) {
        try { activeAbort.abort(); } catch (_) {}
      }
    }, CONNECT_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(url, { mode: 'cors', cache: 'no-store', signal });
    } catch (e) {
      clearTimeout(connectTimer);
      throw e;
    }
    if (!res.ok) { clearTimeout(connectTimer); throw new Error(`HTTP ${res.status}`); }

    // Same defensive cursor handling as telemetry.js: only adopt the
    // server-reported cursor when the header is actually exposed.
    // If absent (CORS quirk on an error response, etc), keep the
    // existing cursor — falling back to 0 would make the next
    // &since= request too low and the device would replay already-
    // received bytes.
    const startHdr = res.headers.get('X-Log-Cursor');
    if (startHdr !== null) {
      const startCursor = Number(startHdr);
      if (Number.isFinite(startCursor)) cursor = startCursor;
    } else if (cursor == null) {
      cursor = 0;
    }

    if (consoleEl.textContent.startsWith('── connecting')) {
      consoleEl.textContent = '';
    }
    setState('connected', 'ok');
    firstByteSeen = true;
    clearTimeout(connectTimer);

    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8', { fatal: false });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength) {
          cursor += value.byteLength;
          await ingestChunk(dec.decode(value, { stream: true }));
        }
      }
      const tail = dec.decode();
      if (tail) await ingestChunk(tail);
    } finally {
      try { reader.cancel(); } catch (_) {}
      persistFlush();
    }
  }

  async function streamLoop() {
    while (!stopped) {
      // External pause (OTA flow). Block here until resume() — the
      // alternative was leaving the /api/log fetch open across the
      // device's reboot, which keeps the LED green even though the
      // device is unreachable for ~10 s. Distinct from `paused` (the
      // user "Pause output" button), which only freezes the display.
      if (streamPaused) {
        setState('updating…', '');
        await new Promise((r) => { streamPauseWaiter = r; });
        streamPauseWaiter = null;
        if (stopped) break;
        continue;
      }
      const ip = getIp();
      if (ip !== knownIp) {
        knownIp = ip;
        if (ip) reset(`connecting to ${ip}…`);
        else reset('no device selected');
        // Device change → close the run. Fresh anchor on next connect.
        persistFlush();
        currentRun = null;
        lastUptimeUs = null;
      }
      if (!ip) {
        setState('no device', '');
        await sleep(RECONNECT_ERR_MS);
        continue;
      }

      activeAbort = new AbortController();
      try {
        await runStream(ip, activeAbort.signal);
        await sleep(RECONNECT_OK_MS);
      } catch (e) {
        if (e && e.name === 'AbortError') continue;
        setState('disconnected', 'err');
        await sleep(RECONNECT_ERR_MS);
      } finally {
        activeAbort = null;
      }
    }
  }

  function watchIp() {
    if (ipWatchHandle) return;
    ipWatchHandle = setInterval(() => {
      if (stopped) return;
      const ip = getIp();
      if (ip !== knownIp && activeAbort) activeAbort.abort();
    }, IP_CHECK_MS);
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

    watchIp();
    streamLoop();

    window.PicoPoE = window.PicoPoE || {};
    window.PicoPoE.console = {
      clear() { consoleEl.textContent = ''; pendingBuf = ''; updatePauseState(); },
      resetCursor() {
        cursor = null;
        if (activeAbort) activeAbort.abort();
      },
      // Wake the stream loop when an external observer (telemetry's
      // stall watchdog, the user's Refresh button) decides this stream
      // is stale. Without this, a half-dead TCP that's silent post-
      // headers would sit in `await reader.read()` forever — there's
      // no stall watchdog here because logs may legitimately be silent
      // for minutes. Aborting forces streamLoop to retry, which either
      // succeeds (firmware reachable) or trips its own connect timeout.
      kick() {
        if (activeAbort) {
          try { activeAbort.abort(); } catch (_) {}
          setState('reconnecting…', 'err');
        }
      },
      // Inject a browser-side note (connection events, refresh outcomes,
      // etc.) into the runtime console pane. Tagged so the user can tell
      // it apart from device-emitted log lines, and routed through the
      // same renderAppend path so it respects pause + scroll-to-bottom.
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
        if (activeAbort) activeAbort.abort();
        if (streamPauseWaiter) { streamPauseWaiter(); streamPauseWaiter = null; }
        if (ipWatchHandle) { clearInterval(ipWatchHandle); ipWatchHandle = null; }
      },
      // External "pause the whole stream" for OTA flows. ide.js calls
      // pauseStream() before kicking the upload so the LED flips to
      // 'updating…' (off color) instead of staying green through the
      // device's reboot. resumeStream() drops the cursor (the new
      // firmware's log byte-counter starts at 0) and wakes streamLoop;
      // the next loop iteration reconnects, runStream's setState on
      // header receive flips the LED back to green — or, if the device
      // never came back, the catch path in streamLoop sets red.
      pauseStream() {
        if (streamPaused) return;
        streamPaused = true;
        if (activeAbort) activeAbort.abort();
        persistFlush();
      },
      resumeStream() {
        if (!streamPaused) return;
        streamPaused = false;
        cursor = null;
        currentRun = null;
        lastUptimeUs = null;
        if (streamPauseWaiter) { streamPauseWaiter(); streamPauseWaiter = null; }
      },
      setPaused,
      isPaused() { return paused; },
      setShowTimestamps(v) {
        showTimestamps = !!v;
        if (tsToggleBtn) {
          tsToggleBtn.setAttribute('aria-pressed', showTimestamps ? 'true' : 'false');
        }
      },
      // Used by the relocated Download flow — flush in-flight batches
      // so the on-disk HDF5 includes the freshest console bytes.
      flushPersist() { persistFlush(); },
    };
  }

  function bootstrap() {
    init({
      getIp: () => {
        try {
          const sel = document.getElementById('ide-device-select');
          if (sel && sel.value) return sel.value;
          const fallback = document.getElementById('ide-quick-ip');
          return fallback && fallback.value.trim() ? fallback.value.trim() : null;
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
