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

// Per-probe timeout for the manual "Add device" button. Was 10 s when
// the negotiated cipher was ECDHE-ECDSA-AES-GCM and the handshake on
// Cortex-M33 ran ~3 s on a fresh connection. With ChaCha20-Poly1305
// (firmware v10.41+) handshake completes in ~1.5-2 s, so 6 s is plenty
// — a reachable LAN device on plain HTTP still replies in tens of ms,
// and an unreachable IP fails fast either way.
// 12 s — generous enough for the cold-cache first HTTPS handshake from a
// public-origin page to the device. Chromium's Private Network Access
// preflight adds ~1 full TLS round trip on top of the regular GET, and on
// Cortex-M33 software ChaCha20 each handshake is ~1.5–2 s. 6 s was too
// tight: real browsers occasionally timed out on the very first probe
// (subsequent fetches reuse the connection and finish in ~2 s). Keep
// this knob in sync with hardware.js's hint message — if a probe times
// out at this value the device really is unreachable, not just slow.
const PROBE_TIMEOUT_MS = 12000;

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
  // HTTP fallback for devices without a uniqueId (uncommissioned /
  // self-hosted / local-dev boards). Was disabled when mbedtls heap
  // fragmentation made HTTPS unreliable and we needed the failures
  // surfaced loudly — keeping plaintext available let "looks like it
  // works" ship over HTTP while HTTPS quietly bricked the device.
  // The mbedtls slab fix (firmware/app/mbedtls_slab.{c,h}) closed that
  // gap, so HTTP is safe to re-enable as the natural fallback when no
  // per-device TLS identity is registered.
  //
  // Opt back out at runtime with `window.Conduit.allowHttpFallback = false`
  // before any module reads a URL — useful if you want to assert that
  // every flow is using the per-device cert.
  if (window.Conduit && window.Conduit.allowHttpFallback === false) {
    throw new Error(
      `deviceUrl: no uniqueId for ${ip} and HTTP fallback is disabled. ` +
      `Re-add the device in Hardware Manager with its Board ID (see ` +
      `\`conduit status -d ${ip}\`) as the uniqueId.`,
    );
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
  // Surface the actual fetch failure (CORS, PNA preflight reject,
  // TLS error, timeout, etc.) so callers like hardware.js can show a
  // useful error instead of the generic "No response". The previous
  // pattern (console.warn only) hid the diagnosis behind DevTools,
  // which led to a whole debug cycle blaming the wrong layer.
  window.Conduit = window.Conduit || {};
  window.Conduit._lastProbeError = null;
  let url;
  try {
    url = deviceUrl(ip, uniqueId, '/api/status');
  } catch (e) {
    clearTimeout(timer);
    window.Conduit._lastProbeError = { kind: 'url', message: String(e.message || e) };
    console.warn('[probeDevice]', e.message || e);
    return null;
  }
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      mode: 'cors',
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) {
      window.Conduit._lastProbeError = { kind: 'http', status: res.status, message: `HTTP ${res.status}`, url };
      return null;
    }
    const data = await res.json();
    if (data && data.device !== 'conduit') {
      window.Conduit._lastProbeError = { kind: 'wrong-device', message: `device field is "${data.device}", expected "conduit"`, url };
      return null;
    }
    data._ip = ip;
    if (uniqueId) data._uniqueId = uniqueId;
    return data;
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && e.name === 'AbortError';
    window.Conduit._lastProbeError = {
      kind: aborted ? 'timeout' : 'fetch',
      message: aborted
        ? `timed out after ${timeoutMs} ms (first HTTPS handshake to a cold device can take a few seconds — try again, or check that port 443 is reachable)`
        : String(e.message || e),
      url,
    };
    if (!aborted) console.warn('[probeDevice]', e.message || e);
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

// Persisted opt-in for telemetry/console stream auto-resume. Default
// FALSE on HTTPS because two concurrent stream handshakes wedge the
// Cortex-M33 mbedtls. Users who want live charts/console output can
// flip this once from DevTools:
//   localStorage.setItem('conduit_streams_auto', 'true'); location.reload();
// and it sticks across reloads. Setting it back to 'false' (or
// clearing site data) returns to the safe default.
try {
  window.Conduit.streamsAutoResume =
    localStorage.getItem('conduit_streams_auto') === 'true';
} catch (_) {
  window.Conduit.streamsAutoResume = false;
}
