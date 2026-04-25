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
  const RECONNECT_ERR_MS   = 2000;
  const IP_CHECK_MS        = 1000;
  const MAX_BUFFER_CHARS   = 200_000;
  const PENDING_MAX_CHARS  = 100_000;
  const PERSIST_BATCH_MAX  = 50;     // flush to IndexedDB after N records or…
  const PERSIST_BATCH_MS   = 250;    // …after M ms idle, whichever hits first.
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
  let paused = false;
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
    stateEl.style.color = cls === 'err' ? 'var(--red)'
                       : cls === 'ok'  ? 'var(--green)'
                       : '';
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
      pauseBtn.textContent = paused
        ? (pendingBuf.length > 0 ? `Resume (${pendingBuf.length} B)` : 'Resume')
        : 'Pause';
    }
    if (!stateEl) return;
    if (paused) {
      stateEl.textContent = 'paused';
      stateEl.style.color = '';
    } else {
      stateEl.textContent = lastStateText;
      stateEl.style.color = lastStateCls === 'err' ? 'var(--red)'
                         : lastStateCls === 'ok'  ? 'var(--green)'
                         : '';
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

    // First record of a run: anchor wall-clock and open the run metadata.
    if (!currentRun) {
      const anchor = (wallMsAnchor != null) ? wallMsAnchor : Date.now();
      const offset = anchor - (uptimeUs / 1000);
      const store = window.PicoPoE && window.PicoPoE.logStore;
      const streamEpoch = store
        ? await store.startRun({
            deviceIp: knownIp || '',
            wallMsAnchor: anchor,
            uptimeUsAnchor: uptimeUs,
            wallMsOffset: offset,
          }).catch(() => Date.now())
        : Date.now();
      currentRun = { streamEpoch, wallMsOffset: offset, lastUptimeUs: uptimeUs };
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
    const res = await fetch(url, { mode: 'cors', cache: 'no-store', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const startHdr = res.headers.get('X-Log-Cursor');
    const startCursor = startHdr === null ? 0 : Number(startHdr);
    cursor = Number.isFinite(startCursor) ? startCursor : 0;

    if (consoleEl.textContent.startsWith('── connecting')) {
      consoleEl.textContent = '';
    }
    setState('connected', 'ok');

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
    if (pauseBtn) pauseBtn.addEventListener('click', () => setPaused(!paused));
    if (tsToggleBtn) {
      tsToggleBtn.addEventListener('click', () => {
        showTimestamps = !showTimestamps;
        tsToggleBtn.textContent = showTimestamps ? 'Hide times' : 'Show times';
        tsToggleBtn.setAttribute('aria-pressed', showTimestamps ? 'true' : 'false');
      });
      tsToggleBtn.textContent = showTimestamps ? 'Hide times' : 'Show times';
    }
    if (downloadBtn) downloadBtn.addEventListener('click', async () => {
      const exporter = window.PicoPoE && window.PicoPoE.logExport;
      if (!exporter) {
        alert('log exporter not loaded');
        return;
      }
      try {
        downloadBtn.disabled = true;
        downloadBtn.textContent = 'Preparing…';
        // Flush in-flight batch so nothing pending is missing from the file.
        persistFlush();
        await exporter.downloadHdf5();
      } catch (e) {
        console.error('[console] HDF5 export failed:', e);
        alert(`HDF5 export failed: ${e.message || e}`);
      } finally {
        downloadBtn.disabled = false;
        downloadBtn.textContent = 'Download';
      }
    });

    watchIp();
    streamLoop();

    window.PicoPoE = window.PicoPoE || {};
    window.PicoPoE.console = {
      clear() { consoleEl.textContent = ''; pendingBuf = ''; updatePauseState(); },
      resetCursor() {
        cursor = null;
        if (activeAbort) activeAbort.abort();
      },
      stop() {
        stopped = true;
        persistFlush();
        if (activeAbort) activeAbort.abort();
        if (ipWatchHandle) { clearInterval(ipWatchHandle); ipWatchHandle = null; }
      },
      setPaused,
      isPaused() { return paused; },
      setShowTimestamps(v) {
        showTimestamps = !!v;
        if (tsToggleBtn) {
          tsToggleBtn.textContent = showTimestamps ? 'Hide times' : 'Show times';
          tsToggleBtn.setAttribute('aria-pressed', showTimestamps ? 'true' : 'false');
        }
      },
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
