// app.js — Single-host device probe shared with ide.js + hardware.js.
//
// Devices announce themselves over UDP multicast (see firmware/app/
// discovery.c) so the conduit CLI's `discover` subcommand finds them
// without scanning a subnet. The browser can't join multicast groups,
// so the web IDE flow is: user gets the IP via `conduit discover` (or
// the device label) and types it into Hardware Manager. This file
// confirms the IP belongs to a CONDUIT device and caches it in
// localStorage.
//
// Two modes:
//   - HTTP only (default): probe http://<ip>/api/status. Works for
//     uncommissioned / self-hosted boards. Mixed-content blocks this
//     when the IDE itself is served from https://, so this mode is
//     for users running the IDE locally (file://, http://localhost).
//   - HTTPS via wildcard hostname (when uniqueId is set): probe
//     https://<dash-ip>.<uniqueId>.devices.rm1n.com/api/status.
//     The dash-encoded IP is decoded by a stateless DNS server that
//     resolves it to the original v4 address; the unique-id selects
//     the per-device cert. Devices commissioned via the (private)
//     `commission` tool get this for free.
//
// Exposed on window.Conduit:
//   probeDevice({ip, uniqueId}, opts)  — probe one host, returns status JSON or null
//   probeHost(ip, timeoutMs)           — back-compat wrapper, HTTP only
//   probeAndRemember(input, opts)      — probe + cache on success.
//                                        input is {ip, uniqueId?, name?} or a plain IP string.
//   getKnownDevices()                  — read the cached list
//   updateKnownDevice(ip, patch)       — patch a cached entry's fields
//   removeKnownDevice(ip)              — drop one entry from the cache
//   deviceUrl(ip, uniqueId, path)      — URL builder used by the rest of the IDE
//   dispatch event 'conduit:devices-updated' whenever the cache changes

// Per-probe timeout. Generous because the HTTPS path (per-device LE
// cert) costs ~3 s on a fresh handshake on Cortex-M33; 5 s used to
// time out borderline-slow handshakes on a busy device. 10 s is plenty
// over either transport — a reachable LAN device on plain HTTP still
// replies in tens of ms; an empty IP fails fast either way.
const PROBE_TIMEOUT_MS = 10000;

// Default DNS zone for per-device wildcard certs. Only used when the
// caller passes a uniqueId — otherwise we don't construct an HTTPS URL
// at all. Override at runtime via Conduit.deviceTlsZone if you self-host
// the DNS+CA stack.
const DEFAULT_DEVICE_TLS_ZONE = 'devices.rm1n.com';

function tlsZone() {
  return (window.Conduit && window.Conduit.deviceTlsZone) || DEFAULT_DEVICE_TLS_ZONE;
}

function deviceUrl(ip, uniqueId, path) {
  if (!path) path = '/';
  if (uniqueId) {
    const dashIp = String(ip).replaceAll('.', '-');
    return `https://${dashIp}.${uniqueId}.${tlsZone()}${path}`;
  }
  return `http://${ip}${path}`;
}

// Build a device URL given just an IP, looking up uniqueId from the
// localStorage entry the user registered in Hardware Manager. Every
// /api/* fetch in the rest of the IDE goes through this so HTTP-only
// devices and HTTPS-via-wildcard devices share one code path.
function deviceUrlForIp(ip, path) {
  const entry = getKnownDevices().find((d) => d.ip === ip);
  return deviceUrl(ip, entry && entry.uniqueId, path);
}

// `cache: 'no-store'` keeps a stale cached response (or a queued
// revalidation that races the abort) from masking a healthy device —
// without it, /api/status responses with no explicit Cache-Control
// could be served from disk cache and a subsequent reachability dip
// would look like a hard failure.
async function probeDevice(input, opts) {
  const params = normalizeProbeInput(input);
  if (!params || !params.ip) return null;
  const { ip, uniqueId } = params;
  const timeoutMs = (opts && opts.timeoutMs) || PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(deviceUrl(ip, uniqueId, '/api/status'), {
      signal: controller.signal,
      mode: 'cors',
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.device !== 'conduit') return null;
    data._ip = ip;
    if (uniqueId) data._uniqueId = uniqueId;
    return data;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// Back-compat wrapper. The IDE has callers like
// `Conduit.probeHost(ip)` that pass an IP string; keep them working.
async function probeHost(ip, timeoutMs) {
  return probeDevice({ ip }, { timeoutMs });
}

function normalizeProbeInput(input) {
  if (typeof input === 'string') return { ip: input.trim() };
  if (input && typeof input === 'object') {
    const ip = (input.ip || '').toString().trim();
    if (!ip) return null;
    const out = { ip };
    if (input.uniqueId) out.uniqueId = String(input.uniqueId).trim().toLowerCase();
    if (input.name)     out.name     = String(input.name).trim();
    return out;
  }
  return null;
}

function getKnownDevices() {
  try {
    const s = JSON.parse(localStorage.getItem('conduit') || '{}');
    return Array.isArray(s.knownDevices) ? s.knownDevices : [];
  } catch (_) { return []; }
}

function _writeKnownDevices(next) {
  try {
    const s = JSON.parse(localStorage.getItem('conduit') || '{}');
    s.knownDevices = next;
    s.knownDevicesTs = Date.now();
    localStorage.setItem('conduit', JSON.stringify(s));
  } catch (_) { return; }
  window.dispatchEvent(new CustomEvent('conduit:devices-updated'));
}

async function probeAndRemember(input, opts) {
  const params = normalizeProbeInput(input);
  if (!params) return null;
  // Adopt the cached uniqueId / name when the caller passed only an IP.
  // The IDE's quick-connect + auto-reconnect call us with bare IPs but
  // the device may have been registered with a uniqueId via Hardware
  // Manager, in which case the probe needs to hit the HTTPS hostname.
  const existing = getKnownDevices();
  const previous = existing.find((d) => d.ip === params.ip) || {};
  if (!params.uniqueId && previous.uniqueId) params.uniqueId = previous.uniqueId;
  if (!params.name     && previous.name)     params.name     = previous.name;

  const result = await probeDevice(params, opts);
  if (!result) return null;
  const merged = existing.filter((d) => d.ip !== params.ip);
  const entry = {
    ip: params.ip,
    version: result.version,
    partition: result.partition,
    mac: result.mac,
    board_id: result.board_id,
  };
  if (params.uniqueId) entry.uniqueId = params.uniqueId;
  if (params.name)     entry.name     = params.name;
  merged.unshift(entry);
  _writeKnownDevices(merged);
  return result;
}

// Patch a single field-set into the cached entry for `ip`. Used after
// /api/upload + commit to reflect the new version + partition without
// re-probing. Adds the device if it's not in the list yet (rare —
// typically the dropdown already knows about it since you just OTA'd it).
function updateKnownDevice(ip, patch) {
  if (!ip || !patch) return;
  const existing = getKnownDevices();
  let found = false;
  const next = existing.map((d) => {
    if (d.ip !== ip) return d;
    found = true;
    return { ...d, ...patch };
  });
  if (!found) next.unshift({ ip, ...patch });
  _writeKnownDevices(next);
}

function removeKnownDevice(ip) {
  if (!ip) return;
  const next = getKnownDevices().filter((d) => d.ip !== ip);
  _writeKnownDevices(next);
}

window.Conduit = window.Conduit || {};
window.Conduit.deviceUrl        = deviceUrl;
window.Conduit.deviceUrlForIp   = deviceUrlForIp;
window.Conduit.probeDevice      = probeDevice;
window.Conduit.probeHost        = probeHost;
window.Conduit.getKnownDevices  = getKnownDevices;
window.Conduit.probeAndRemember = probeAndRemember;
window.Conduit.updateKnownDevice = updateKnownDevice;
window.Conduit.removeKnownDevice = removeKnownDevice;
