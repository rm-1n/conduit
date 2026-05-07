// app.js — Device discovery helpers shared with ide.js.
//
// This file used to drive the Devices tab (scanner table, device detail,
// drop-zone upload). That whole tab is gone now; what's left is the core
// "scan a /24 for CONDUIT boards" logic, still useful from the IDE's
// device picker. No DOM rendering is done here — results are returned and
// also cached in localStorage so the IDE dropdown can pick them up.
//
// Exposed on window.Conduit:
//   scanHost(ip, timeoutMs)        — probe one host, returns status JSON or null
//   probeAndRemember(ip, opts)     — probe + cache on success
//   startScan({ subnet })          — probe /24, returns array of hits
//   getKnownDevices()              — read the cached list
//   dispatch event 'conduit:devices-updated' whenever the cache changes

// Per-probe timeout default. Has to comfortably exceed the time it
// takes for a probe to (a) get a socket out of the browser's global
// pool when 254 are in flight at once, and (b) for the device to
// round-trip the GET. 10 s gives queued probes plenty of headroom;
// the prior 1500 ms was tight enough that a fetch queued behind 250
// timing-out fetches to unreachable hosts would abort BEFORE it got
// a turn at the socket pool. Worst-case /24 scan against a fully-
// empty subnet now takes ~10 s end-to-end (reachable LAN devices
// still respond in tens of ms).
//
// User-overridable via Settings → "Scan timeout" — value persists
// in localStorage `conduit.scanTimeoutMs`. configuredScanTimeoutMs()
// reads the override every call so the new value applies on the
// next scan without a reload.
const SCAN_TIMEOUT_MS = 10000;
function configuredScanTimeoutMs() {
  try {
    const s = JSON.parse(localStorage.getItem('conduit') || '{}');
    const v = Number(s.scanTimeoutMs);
    // Clamp to a sane range to keep a corrupt localStorage entry
    // from making the IDE feel unresponsive (or unbounded).
    if (Number.isFinite(v) && v >= 500 && v <= 60000) return v;
  } catch (_) {}
  return SCAN_TIMEOUT_MS;
}

// Probe one host. `cache: 'no-store'` keeps a stale cached response
// (or a queued revalidation that races the abort) from masking a
// healthy device — without it, /api/status responses with no
// explicit Cache-Control could be served from disk cache and a
// subsequent reachability dip would look like a hard failure.
async function scanHost(ip, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || configuredScanTimeoutMs());
  try {
    const res = await fetch(`http://${ip}/api/status`, {
      signal: controller.signal,
      mode: 'cors',
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.device !== 'conduit') return null;
    data._ip = ip;
    return data;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function runWithConcurrency(items, concurrency, probe, onResult) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      const item = items[i];
      const result = await probe(item);
      onResult(item, result, i);
    }
  }
  const workers = [];
  const n = Math.min(concurrency, items.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
}

// Scan `<subnet>.1` through `<subnet>.254` in bounded parallel. Returns the
// list of reachable conduit devices and mirrors them into localStorage so
// the IDE's <select> can read them back without rescanning.
async function startScan(opts) {
  const subnet = (opts && opts.subnet) || '';
  if (!subnet) return [];
  const parts = subnet.replace(/\/\d+$/, '').split('.');
  const base = parts.slice(0, 3).join('.');
  const ips = [];
  for (let i = 1; i <= 254; i++) ips.push(`${base}.${i}`);

  // Fire every probe simultaneously. Each .x.x.x.N targets a distinct
  // origin, so the browser's per-origin connection limit (~6) doesn't
  // throttle across IPs — the bottleneck the older 24-concurrency cap
  // was mitigating only applies to repeated requests to the SAME host
  // (see scanHost's comment about timer-vs-fetch ordering). Across 254
  // different origins we can blast all of them at once and rely on the
  // per-probe abort timer (configuredScanTimeoutMs) to bound the
  // total wait. Resolved once here so all probes in this scan share
  // the same value even if the user toggles the setting mid-scan.
  const timeoutMs = configuredScanTimeoutMs();
  const hits = [];
  await Promise.all(ips.map(async (ip) => {
    const result = await scanHost(ip, timeoutMs);
    if (result) hits.push(result);
    if (opts && opts.onProgress) opts.onProgress({ ip, ok: !!result });
  }));

  try {
    const s = JSON.parse(localStorage.getItem('conduit') || '{}');
    s.knownDevices = hits.map((d) => ({
      ip: d._ip, version: d.version, partition: d.partition,
      mac: d.mac, board_id: d.board_id,
    }));
    s.knownDevicesTs = Date.now();
    localStorage.setItem('conduit', JSON.stringify(s));
  } catch (_) {}
  window.dispatchEvent(new CustomEvent('conduit:devices-updated', { detail: hits }));
  return hits;
}

function getKnownDevices() {
  try {
    const s = JSON.parse(localStorage.getItem('conduit') || '{}');
    return Array.isArray(s.knownDevices) ? s.knownDevices : [];
  } catch (_) { return []; }
}

async function probeAndRemember(ip, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || configuredScanTimeoutMs();
  const result = await scanHost(ip, timeoutMs);
  if (!result) return null;
  try {
    const s = JSON.parse(localStorage.getItem('conduit') || '{}');
    const existing = Array.isArray(s.knownDevices) ? s.knownDevices : [];
    const merged = existing.filter((d) => d.ip !== ip);
    merged.unshift({
      ip, version: result.version, partition: result.partition,
      mac: result.mac, board_id: result.board_id,
    });
    s.knownDevices = merged;
    s.knownDevicesTs = Date.now();
    localStorage.setItem('conduit', JSON.stringify(s));
  } catch (_) {}
  window.dispatchEvent(new CustomEvent('conduit:devices-updated'));
  return result;
}

// Patch a single field-set into the cached entry for `ip`. Used after
// /api/upload + commit to reflect the new version + partition without
// waiting for the next periodic scan. Adds the device if it's not in
// the list yet (rare — typically the dropdown already knows about it
// since you just OTA'd it).
function updateKnownDevice(ip, patch) {
  if (!ip || !patch) return;
  try {
    const s = JSON.parse(localStorage.getItem('conduit') || '{}');
    const existing = Array.isArray(s.knownDevices) ? s.knownDevices : [];
    let found = false;
    const next = existing.map((d) => {
      if (d.ip !== ip) return d;
      found = true;
      return { ...d, ...patch };
    });
    if (!found) next.unshift({ ip, ...patch });
    s.knownDevices = next;
    s.knownDevicesTs = Date.now();
    localStorage.setItem('conduit', JSON.stringify(s));
  } catch (_) { return; }
  window.dispatchEvent(new CustomEvent('conduit:devices-updated'));
}

window.Conduit = window.Conduit || {};
window.Conduit.scanHost = scanHost;
window.Conduit.startScan = startScan;
window.Conduit.getKnownDevices = getKnownDevices;
window.Conduit.probeAndRemember = probeAndRemember;
window.Conduit.updateKnownDevice = updateKnownDevice;
