// app.js — Single-host device probe shared with ide.js.
//
// Devices announce themselves over UDP multicast (see firmware/app/
// discovery.c) so the conduit CLI's `discover` subcommand finds them
// without scanning a subnet. The browser can't join multicast groups,
// so the web IDE flow is: user gets the IP via `conduit discover` (or
// the device label) and types it into Add. This file just confirms
// the IP belongs to a CONDUIT device and caches it in localStorage.
//
// The /24-scan code that used to live here is gone — multicast
// discovery replaces it cleanly. See web/index.html / ide.js for the
// matching UI cleanup.
//
// Exposed on window.Conduit:
//   probeHost(ip, timeoutMs)       — probe one host, returns status JSON or null
//   probeAndRemember(ip, opts)     — probe + cache on success
//   getKnownDevices()              — read the cached list
//   updateKnownDevice(ip, patch)   — patch a cached entry's fields
//   dispatch event 'conduit:devices-updated' whenever the cache changes

// Per-probe timeout. Single-host probes don't queue behind a flooded
// socket pool the way the old /24 scan did, so 5 s is plenty: a
// reachable LAN device replies in tens of ms, an empty IP fails fast.
// Hardcoded — the prior user-facing "Scan timeout" knob existed only
// to tune the /24 sweep and went away with it.
const PROBE_TIMEOUT_MS = 5000;

// `cache: 'no-store'` keeps a stale cached response (or a queued
// revalidation that races the abort) from masking a healthy device —
// without it, /api/status responses with no explicit Cache-Control
// could be served from disk cache and a subsequent reachability dip
// would look like a hard failure.
async function probeHost(ip, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || PROBE_TIMEOUT_MS);
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

function getKnownDevices() {
  try {
    const s = JSON.parse(localStorage.getItem('conduit') || '{}');
    return Array.isArray(s.knownDevices) ? s.knownDevices : [];
  } catch (_) { return []; }
}

async function probeAndRemember(ip, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || PROBE_TIMEOUT_MS;
  const result = await probeHost(ip, timeoutMs);
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
// re-probing. Adds the device if it's not in the list yet (rare —
// typically the dropdown already knows about it since you just OTA'd it).
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
window.Conduit.probeHost = probeHost;
window.Conduit.getKnownDevices = getKnownDevices;
window.Conduit.probeAndRemember = probeAndRemember;
window.Conduit.updateKnownDevice = updateKnownDevice;
