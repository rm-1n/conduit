// app.js — Device discovery helpers shared with ide.js.
//
// This file used to drive the Devices tab (scanner table, device detail,
// drop-zone upload). That whole tab is gone now; what's left is the core
// "scan a /24 for PICO-POE boards" logic, still useful from the IDE's
// device picker. No DOM rendering is done here — results are returned and
// also cached in localStorage so the IDE dropdown can pick them up.
//
// Exposed on window.PicoPoE:
//   scanHost(ip, timeoutMs)        — probe one host, returns status JSON or null
//   probeAndRemember(ip, opts)     — probe + cache on success
//   startScan({ subnet })          — probe /24, returns array of hits
//   getKnownDevices()              — read the cached list
//   dispatch event 'picopoe:devices-updated' whenever the cache changes

const SCAN_TIMEOUT_MS = 1500;

// Probe one host. The abort timer starts right as we kick off fetch — per
// a prior bug where the timer could fire before the fetch got a turn at
// the browser's per-origin connection limit, we now ensure the caller uses
// runWithConcurrency to keep the in-flight count low enough that no probe
// queues behind its own deadline.
async function scanHost(ip, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || SCAN_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${ip}/api/status`, {
      signal: controller.signal,
      mode: 'cors',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.device !== 'pico-poe') return null;
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
// list of reachable pico-poe devices and mirrors them into localStorage so
// the IDE's <select> can read them back without rescanning.
async function startScan(opts) {
  const subnet = (opts && opts.subnet) || '';
  if (!subnet) return [];
  const parts = subnet.replace(/\/\d+$/, '').split('.');
  const base = parts.slice(0, 3).join('.');
  const ips = [];
  for (let i = 1; i <= 254; i++) ips.push(`${base}.${i}`);

  const hits = [];
  await runWithConcurrency(ips, 24, (ip) => scanHost(ip, SCAN_TIMEOUT_MS),
    (ip, result) => {
      if (result) hits.push(result);
      if (opts && opts.onProgress) opts.onProgress({ ip, ok: !!result });
    },
  );

  try {
    const s = JSON.parse(localStorage.getItem('picopoe') || '{}');
    s.knownDevices = hits.map((d) => ({
      ip: d._ip, version: d.version, partition: d.partition,
      mac: d.mac, board_id: d.board_id,
    }));
    s.knownDevicesTs = Date.now();
    localStorage.setItem('picopoe', JSON.stringify(s));
  } catch (_) {}
  window.dispatchEvent(new CustomEvent('picopoe:devices-updated', { detail: hits }));
  return hits;
}

function getKnownDevices() {
  try {
    const s = JSON.parse(localStorage.getItem('picopoe') || '{}');
    return Array.isArray(s.knownDevices) ? s.knownDevices : [];
  } catch (_) { return []; }
}

async function probeAndRemember(ip, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 4000;
  const result = await scanHost(ip, timeoutMs);
  if (!result) return null;
  try {
    const s = JSON.parse(localStorage.getItem('picopoe') || '{}');
    const existing = Array.isArray(s.knownDevices) ? s.knownDevices : [];
    const merged = existing.filter((d) => d.ip !== ip);
    merged.unshift({
      ip, version: result.version, partition: result.partition,
      mac: result.mac, board_id: result.board_id,
    });
    s.knownDevices = merged;
    s.knownDevicesTs = Date.now();
    localStorage.setItem('picopoe', JSON.stringify(s));
  } catch (_) {}
  window.dispatchEvent(new CustomEvent('picopoe:devices-updated'));
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
    const s = JSON.parse(localStorage.getItem('picopoe') || '{}');
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
    localStorage.setItem('picopoe', JSON.stringify(s));
  } catch (_) { return; }
  window.dispatchEvent(new CustomEvent('picopoe:devices-updated'));
}

window.PicoPoE = window.PicoPoE || {};
window.PicoPoE.scanHost = scanHost;
window.PicoPoE.startScan = startScan;
window.PicoPoE.getKnownDevices = getKnownDevices;
window.PicoPoE.probeAndRemember = probeAndRemember;
window.PicoPoE.updateKnownDevice = updateKnownDevice;
