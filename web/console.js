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

  // RECONNECT_OK_MS / RECONNECT_ERR_MS — see telemetry.js for the full
  // rationale. tl;dr: aggressive reconnect cadence on HTTPS wedges the
  // Cortex-M33 mbedtls stack by piling fresh handshakes on top of an
  // in-flight one. 2 s / 5 s gives the device time to actually serve
  // a stream instead of getting hammered.
  const RECONNECT_OK_MS    = 2000;
  const RECONNECT_ERR_MS   = 5000;
  const IP_CHECK_MS        = 1000;
  const MAX_BUFFER_CHARS   = 200_000;
  const PENDING_MAX_CHARS  = 100_000;
  const PERSIST_BATCH_MAX  = 50;     // flush to IndexedDB after N records or…
  const PERSIST_BATCH_MS   = 250;    // …after M ms idle, whichever hits first.
  // Connect-phase timeout — same pattern as telemetry.js. Firmware emits
  // a `\n` keepalive every ~500 ms when the log ring is empty (see
  // http_poll). 4 s covers a fresh ChaCha20-Poly1305 handshake (~1.5-2 s
  // on Cortex-M33 in firmware v10.41+) plus a keepalive + jitter. Was
  // 8 s when ECDHE-ECDSA-AES-GCM was the negotiated cipher.
  // CONNECT_TIMEOUT_MS — see telemetry.js. 15 s covers the cold first
  // HTTPS handshake on Cortex-M33 (PNA preflight + full TLS, ~5–8 s).
  // STALL_MS — bumped 1 s → 10 s; under HTTPS load a 1 s silent window
  // can mean "device is busy serving the OTHER stream", not "stream is
  // dead". Aborting and reconnecting just makes it worse.
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
  function setStage(stage) {
    currentStage = stage;
    stageEnteredAt = performance.now();
    renderStage();
  }
  function renderStage() {
    let text, cls;
    switch (currentStage) {
      case 'connected':
        text = 'connected'; cls = 'ok'; break;
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
    stateEl.textContent = text;
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

  // --- Streaming loop --------------------------------------------------

  async function runStream(ip, signal) {
    const since = cursor === null ? 0 : cursor;
    const url = `${window.Conduit.deviceUrlForIp(ip, '/api/log')}?since=${since}&stream=1`;
    wallMsAnchor = Date.now();  // consumed by the first record of this run
    console.log('[con] runStream.open', { url, cursor });

    // Track first-byte arrival so the connect-timeout below can decide
    // whether to abort. Logs may be silent for long periods after the
    // connect lands — we ONLY want the timeout to fire if the response
    // never started, not if the device is just quiet.
    let firstByteSeen = false;
    const connectTimer = setTimeout(() => {
      if (!firstByteSeen && activeAbort && !signal.aborted) {
        console.log('[con] runStream.connectTimeout');
        try { activeAbort.abort(); } catch (_) {}
      }
    }, CONNECT_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(url, { mode: 'cors', cache: 'no-store', signal });
    } catch (e) {
      clearTimeout(connectTimer);
      console.log('[con] runStream.fetchError', String(e && e.message || e));
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
    const cursorBefore = cursor;
    if (startHdr !== null) {
      const startCursor = Number(startHdr);
      if (Number.isFinite(startCursor)) cursor = startCursor;
    } else if (cursor == null) {
      cursor = 0;
    }
    console.log('[con] runStream.headers', { sentSince: since, xLogCursor: startHdr, cursorBefore, cursorAfter: cursor });

    if (consoleEl.textContent.startsWith('── connecting')) {
      consoleEl.textContent = '';
    }
    setStage('connected');
    firstByteSeen = true;
    clearTimeout(connectTimer);
    lastByteMs = performance.now();

    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8', { fatal: false });
    try {
      let chunkCount = 0;
      let bytesThisStream = 0;
      const streamStartedAt = performance.now();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          console.log('[con] runStream.eof', { chunkCount, bytesThisStream,
                       cursorEnd: cursor, streamMs: Math.round(performance.now() - streamStartedAt) });
          break;
        }
        if (value && value.byteLength) {
          lastByteMs = performance.now();
          cursor += value.byteLength;
          bytesThisStream += value.byteLength;
          // Log every chunk in the first 5 s after a fresh connect; after
          // that, every 50 chunks (or any chunk > 200 bytes — which would
          // be a backlog drain after a reconnect).
          const ageMs = performance.now() - streamStartedAt;
          if (ageMs < 5000 || chunkCount % 50 === 0 || value.byteLength > 200) {
            console.log('[con] runStream.chunk#' + chunkCount,
                        { bytes: value.byteLength, cursorAfter: cursor,
                          firstFew: new TextDecoder().decode(value.slice(0, 60)) });
          }
          chunkCount++;
          await ingestChunk(dec.decode(value, { stream: true }));
        }
      }
      const tail = dec.decode();
      if (tail) await ingestChunk(tail);
    } finally {
      try { reader.cancel(); } catch (_) {}
      lastByteMs = 0;
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
      // Fresh "reconnecting" stage on every attempt so the elapsed
      // counter resets and the user can see we're actively retrying.
      if (currentStage !== 'connected' && currentStage !== 'updating…' &&
          currentStage !== 'no device') {
        setStage('reconnecting');
      }
      try {
        await runStream(ip, activeAbort.signal);
        await sleep(RECONNECT_OK_MS);
      } catch (e) {
        if (e && e.name === 'AbortError') continue;
        setStage('reconnecting');
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

  // Stall watchdog. Now that the firmware emits a `\n` keepalive every
  // ~500 ms when the log ring is silent (see http_poll
  // STREAM_KEEPALIVE_MS), a quiet stream is no longer indistinguishable
  // from a wedged TCP — STALL_MS of true silence means the connection
  // is dead. Aborts the active fetch so streamLoop reconnects.
  function watchStall() {
    if (stallHandle) return;
    stallHandle = setInterval(() => {
      if (stopped || streamPaused || !activeAbort) return;
      if (lastByteMs === 0) return;
      if (performance.now() - lastByteMs > STALL_MS) {
        setStage('no data');
        try { activeAbort.abort(); } catch (_) {}
      }
    }, STALL_CHECK_MS);
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
    watchStall();
    // Start the stream PAUSED. ide.js's reconnect() resumes us once the
    // initial status probe has succeeded — this prevents 2 streams +
    // probe from doing 3 simultaneous TLS handshakes against a single-
    // threaded mbedtls (~3 s per handshake) on page load. Without this
    // gate, the third handshake never fits in CONNECT_TIMEOUT_MS and
    // the panes get stuck in NS_BINDING_ABORTED retry loops.
    streamPaused = true;
    streamLoop();

    window.Conduit = window.Conduit || {};
    window.Conduit.console = {
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
        if (stallHandle)   { clearInterval(stallHandle);   stallHandle   = null; }
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
