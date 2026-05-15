// hardware.js — wires the Hardware Manager view (#view-hardware).
//
// The Hardware Manager is the single place to register devices. The IDE
// itself just consumes the resulting list via Conduit.getKnownDevices().
//
// Flow:
//   1. User enters IP (required) + optional unique-id + optional name.
//   2. We call Conduit.probeAndRemember({ip, uniqueId, name}). If the
//      device responds, the entry lands in localStorage.
//   3. The list re-renders on the `conduit:devices-updated` event.
//
// HTTP vs HTTPS: app.js's deviceUrl() picks based on whether uniqueId
// is set. The user picks. The Hardware Manager is intentionally agnostic
// to which mode they're running.

(function () {
  function $(id) { return document.getElementById(id); }

  function setStatus(msg, kind) {
    const el = $('hardware-status');
    if (!el) return;
    el.textContent = msg || '';
    el.dataset.kind = kind || '';
  }

  function renderList() {
    const list = $('hardware-list');
    const empty = $('hardware-list-empty');
    if (!list) return;
    const known = (window.Conduit && typeof window.Conduit.getKnownDevices === 'function')
      ? window.Conduit.getKnownDevices() : [];
    // Drop everything except the empty-state placeholder, then re-add.
    list.querySelectorAll('.hardware-list__item').forEach((n) => n.remove());
    if (!known.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    for (const d of known) {
      list.appendChild(renderRow(d));
    }
  }

  function renderRow(d) {
    const li = document.createElement('li');
    li.className = 'hardware-list__item';
    li.dataset.ip = d.ip;

    const main = document.createElement('div');
    main.className = 'hardware-list__main';

    const name = document.createElement('span');
    name.className = 'hardware-list__name';
    name.textContent = d.name || d.uniqueId || d.ip;
    main.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'hardware-list__meta';
    const bits = [d.ip];
    if (d.uniqueId) bits.push(`id ${d.uniqueId}`);
    if (d.version)  bits.push(`v${d.version}`);
    if (d.partition) bits.push(d.partition);
    bits.push(d.uniqueId ? 'HTTPS' : 'HTTP');
    meta.textContent = bits.join(' · ');
    main.appendChild(meta);

    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'hardware-list__actions';

    const reBtn = document.createElement('button');
    reBtn.type = 'button';
    reBtn.className = 'hardware-list__btn';
    reBtn.textContent = 'Re-probe';
    reBtn.addEventListener('click', () => reprobe(d));
    actions.appendChild(reBtn);

    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'hardware-list__btn hardware-list__btn--danger';
    rmBtn.textContent = 'Remove';
    rmBtn.addEventListener('click', () => {
      window.Conduit.removeKnownDevice(d.ip);
    });
    actions.appendChild(rmBtn);

    li.appendChild(actions);
    return li;
  }

  async function reprobe(d) {
    setStatus(`Re-probing ${d.ip}…`, 'pending');
    const result = await window.Conduit.probeAndRemember({
      ip: d.ip, uniqueId: d.uniqueId, name: d.name,
    });
    if (result) {
      setStatus(`Re-probed ${d.ip} (v${result.version}, ${result.partition}).`, 'ok');
    } else {
      setStatus(`No response from ${d.ip}.`, 'err');
    }
  }

  function init() {
    const form = $('hardware-add-form');
    if (!form) return;

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const ip = $('hardware-ip').value.trim();
      const uid = $('hardware-uid').value.trim().toLowerCase();
      const name = $('hardware-name').value.trim();
      if (!ip) { setStatus('Enter an IP address.', 'err'); return; }
      // The browser also validates against the regex, but be defensive.
      if (uid && !/^[a-f0-9]{16}$/.test(uid)) {
        setStatus('Unique-id must be 16 hex characters (lowercase).', 'err');
        return;
      }

      const submit = $('hardware-add-btn');
      submit.disabled = true;
      setStatus(`Probing ${ip}${uid ? ' over HTTPS' : ' over HTTP'}…`, 'pending');
      // Pause the live streams BEFORE probing. ide.js's reconnect()
      // does this for its own probe path; without it here, the probe's
      // TLS handshake races telemetry's + console's handshakes, all
      // three pile onto Cortex-M33 mbedtls at once, and the device
      // wedges hard (`Host is down` even for HTTP fallback). On a fresh
      // page load this is the single biggest cause of "No response
      // from <ip>" in Hardware Manager. See memory
      // project_https_keepalive_cadence_wedge.md.
      const tlm = window.Conduit && window.Conduit.telemetry;
      const con = window.Conduit && window.Conduit.console;
      if (tlm && tlm.pause)       tlm.pause();
      if (con && con.pauseStream) con.pauseStream();
      // Give the browser a tick to actually send FIN on the aborted
      // stream fetches before we open a fresh connection.
      await new Promise((r) => setTimeout(r, 300));
      try {
        const result = await window.Conduit.probeAndRemember({
          ip, uniqueId: uid || undefined, name: name || undefined,
        });
        if (result) {
          setStatus(`Added ${name || uid || ip} (v${result.version}, ${result.partition}).`, 'ok');
          form.reset();
        } else {
          // probeDevice writes the real cause to window.Conduit._lastProbeError
          // before returning null — surface it directly so the user doesn't
          // have to open DevTools to find out whether this was a CORS reject,
          // a PNA preflight failure, a TLS handshake timeout, or a wrong-device
          // response. Falls back to the old generic message if the field is
          // missing (e.g. legacy app.js cached).
          const last = (window.Conduit && window.Conduit._lastProbeError) || null;
          const reason = last
            ? `${last.kind}: ${last.message}`
            : (uid ? 'Check the unique-id and that DNS for the wildcard zone resolves.' :
                     'Check the IP and that the IDE can reach the device (mixed-content blocks https→http).');
          setStatus(`No response from ${ip}. ${reason}`, 'err');
        }
      } catch (e) {
        setStatus(`Probe error: ${e && e.message ? e.message : e}`, 'err');
      } finally {
        submit.disabled = false;
        // Streams stay paused by default after the probe — matching
        // ide.js reconnect()'s new behavior. Auto-resuming them here
        // would re-create the wedge: two HTTPS streams + any next
        // action (another probe, an OTA, etc.) saturates Cortex-M33
        // mbedtls. Users opt in via window.Conduit.streamsAutoResume.
        if (window.Conduit && window.Conduit.streamsAutoResume) {
          if (tlm && tlm.resume) tlm.resume();
          setTimeout(() => {
            if (con && con.resumeStream) con.resumeStream();
          }, 1500);
        }
      }
    });

    renderList();
    window.addEventListener('conduit:devices-updated', renderList);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
