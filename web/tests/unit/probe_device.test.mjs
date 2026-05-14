// Unit tests for app.js — the device-URL builder + probe + cache flow.
//
// app.js is the entry point every other web module uses to talk to a
// CONDUIT board. As of the HTTPS-only switch the URL builder ONLY
// emits HTTPS hostnames (https://<dash-ip>.<uniqueId>.<tlsZone>) and
// hard-fails (throws) when a uniqueId is missing rather than quietly
// falling back to http://. Letting the IDE fall back to HTTP had been
// masking real HTTPS regressions — a cleared cookie or a fresh-tab
// re-add would drop the cached uniqueId and the IDE would just "look
// fine" on plaintext, hiding mbedtls saturation bugs that only show
// up at the TLS layer. The escape hatch is window.Conduit.allowHttp-
// Fallback = true, for local dev only.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadModule, makeWindow } from './_load.mjs';

function loadApp() {
  const win = makeWindow();
  loadModule('app.js', win);
  return win;
}

// app.js calls bare `fetch(...)`, which in the test harness resolves
// to globalThis.fetch (Node's built-in). Tests mock it by swapping
// globalThis.fetch and restoring afterwards via withFetch.
async function withFetch(fakeFetch, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---- deviceUrl: HTTPS-only, throws without uniqueId -----------------

test('deviceUrl: throws when uniqueId is missing (HTTP fallback disabled)', () => {
  const win = loadApp();
  assert.throws(
    () => win.Conduit.deviceUrl('192.168.178.200', null, '/api/status'),
    /no uniqueId.*HTTP fallback is disabled/i,
  );
});

test('deviceUrl: also throws when uniqueId is missing and path is omitted', () => {
  const win = loadApp();
  assert.throws(
    () => win.Conduit.deviceUrl('10.0.0.5', null),
    /no uniqueId/i,
  );
});

test('deviceUrl: opt-in escape hatch — allowHttpFallback=true restores HTTP', () => {
  // The hatch exists for local-only dev (e.g. running the IDE from
  // file://). Don't ship code that flips it.
  const win = loadApp();
  win.Conduit.allowHttpFallback = true;
  assert.equal(
    win.Conduit.deviceUrl('10.0.0.5', null, '/api/status'),
    'http://10.0.0.5/api/status',
  );
});

test('deviceUrl: https + dash-encoded ip when uniqueId is set', () => {
  const win = loadApp();
  const url = win.Conduit.deviceUrl(
    '192.168.178.200', '29166ac0e5917701', '/api/status',
  );
  assert.equal(url,
    'https://192-168-178-200.29166ac0e5917701.devices.rm1n.com/api/status');
});

test('deviceUrl: respects custom Conduit.deviceTlsZone for self-host', () => {
  const win = loadApp();
  win.Conduit.deviceTlsZone = 'lan.example.test';
  const url = win.Conduit.deviceUrl(
    '10.0.0.5', 'abcdef0123456789', '/api/status',
  );
  assert.equal(url,
    'https://10-0-0-5.abcdef0123456789.lan.example.test/api/status');
});

// ---- deviceUrlForIp: pulls uniqueId from the cache ------------------

test('deviceUrlForIp: throws for unknown / un-cached IPs', () => {
  const win = loadApp();
  assert.throws(
    () => win.Conduit.deviceUrlForIp('10.0.0.5', '/api/status'),
    /no uniqueId/i,
  );
});

test('deviceUrlForIp: HTTPS when the cached entry has a uniqueId', () => {
  const win = loadApp();
  win.localStorage.setItem('conduit', JSON.stringify({
    knownDevices: [{ ip: '10.0.0.5', uniqueId: 'aabbccdd11223344', name: 'bench-1' }],
  }));
  assert.equal(
    win.Conduit.deviceUrlForIp('10.0.0.5', '/api/status'),
    'https://10-0-0-5.aabbccdd11223344.devices.rm1n.com/api/status',
  );
});

// ---- probeDevice: passes the right URL to fetch ---------------------

test('probeDevice: returns null + logs warning when uniqueId is missing', async () => {
  const win = loadApp();
  // Capture console.warn so the test doesn't pollute output, and so we
  // can assert the deviceUrl error message reached the operator.
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warned.push(args.map(String).join(' ')); };
  try {
    await withFetch(async () => {
      throw new Error('fetch should never be called — deviceUrl throws first');
    }, async () => {
      const data = await win.Conduit.probeDevice({ ip: '10.0.0.5' });
      assert.equal(data, null,
        'probeDevice must return null when deviceUrl throws (no uniqueId)');
      assert.ok(warned.some((s) => /no uniqueId|HTTP fallback is disabled/i.test(s)),
        `expected a [probeDevice] warning about missing uniqueId; got: ${warned.join(' | ')}`);
    });
  } finally {
    console.warn = origWarn;
  }
});

test('probeDevice: HTTPS fetch + _uniqueId when uniqueId is provided', async () => {
  const win = loadApp();
  const calls = [];
  await withFetch(async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({ device: 'conduit', version: '1.0.0', partition: 'A' }),
    };
  }, async () => {
    const data = await win.Conduit.probeDevice({
      ip: '192.168.1.50', uniqueId: '0123456789ABCDEF',
    });
    // uniqueId is normalized to lowercase by probeDevice's input parser.
    assert.equal(calls[0],
      'https://192-168-1-50.0123456789abcdef.devices.rm1n.com/api/status');
    assert.equal(data._uniqueId, '0123456789abcdef');
  });
});

test('probeDevice: rejects responses where data.device !== "conduit"', async () => {
  const win = loadApp();
  await withFetch(async () => ({
    ok: true,
    json: async () => ({ device: 'something-else', version: '1.0.0' }),
  }), async () => {
    const result = await win.Conduit.probeDevice({ ip: '10.0.0.5' });
    assert.equal(result, null);
  });
});

test('probeDevice: returns null on a fetch failure', async () => {
  const win = loadApp();
  await withFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => {
    const result = await win.Conduit.probeDevice({ ip: '10.0.0.5' });
    assert.equal(result, null);
  });
});

// ---- probeAndRemember: cache + uniqueId carry-over ------------------

test('probeAndRemember: stores the new entry in localStorage', async () => {
  const win = loadApp();
  await withFetch(async () => ({
    ok: true,
    json: async () => ({
      device: 'conduit', version: '1.2.3', partition: 'A',
      mac: 'AA:BB', board_id: 'abcd1234',
    }),
  }), async () => {
    await win.Conduit.probeAndRemember({
      ip: '10.0.0.5', uniqueId: 'aabbccdd11223344', name: 'bench-1',
    });
    const known = win.Conduit.getKnownDevices();
    assert.equal(known.length, 1);
    assert.deepEqual(known[0], {
      ip: '10.0.0.5',
      version: '1.2.3',
      partition: 'A',
      mac: 'AA:BB',
      board_id: 'abcd1234',
      uniqueId: 'aabbccdd11223344',
      name: 'bench-1',
    });
  });
});

test('probeAndRemember: re-probe by IP picks up the cached uniqueId', async () => {
  // Hardware Manager registered the device with a uniqueId. The IDE's
  // auto-reconnect calls back with just the IP — the probe must still
  // hit the HTTPS hostname.
  const win = loadApp();
  win.localStorage.setItem('conduit', JSON.stringify({
    knownDevices: [{ ip: '10.0.0.5', uniqueId: 'aabbccdd11223344', name: 'bench-1' }],
  }));
  const calls = [];
  await withFetch(async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({ device: 'conduit', version: '1.2.3', partition: 'A' }),
    };
  }, async () => {
    await win.Conduit.probeAndRemember('10.0.0.5');
    assert.equal(calls[0],
      'https://10-0-0-5.aabbccdd11223344.devices.rm1n.com/api/status');
    // Cached uniqueId + name survive the re-probe — losing them on a
    // re-probe would silently downgrade a commissioned device to HTTP.
    const known = win.Conduit.getKnownDevices();
    assert.equal(known[0].uniqueId, 'aabbccdd11223344');
    assert.equal(known[0].name, 'bench-1');
  });
});

test('probeAndRemember: legacy entry (no uniqueId) returns null + warns', async () => {
  // Migration path: old localStorage shape lacks uniqueId. Pre-HTTPS-
  // only, we transparently re-probed over HTTP. Now that HTTP fallback
  // is disabled we surface the failure so the operator re-registers
  // the device with its uniqueId, rather than the IDE silently working
  // over plaintext.
  const win = loadApp();
  win.localStorage.setItem('conduit', JSON.stringify({
    knownDevices: [{ ip: '10.0.0.5', version: '1.0.0', partition: 'A' }],
  }));
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warned.push(args.map(String).join(' ')); };
  try {
    await withFetch(async () => {
      throw new Error('fetch should never be called');
    }, async () => {
      const result = await win.Conduit.probeAndRemember('10.0.0.5');
      assert.equal(result, null);
      assert.ok(warned.some((s) => /no uniqueId/i.test(s)));
    });
  } finally {
    console.warn = origWarn;
  }
});

// ---- removeKnownDevice ----------------------------------------------

test('removeKnownDevice: drops the matching entry, leaves others', () => {
  const win = loadApp();
  win.localStorage.setItem('conduit', JSON.stringify({
    knownDevices: [
      { ip: '10.0.0.5', uniqueId: 'aabbccdd11223344' },
      { ip: '10.0.0.6' },
    ],
  }));
  win.Conduit.removeKnownDevice('10.0.0.5');
  const left = win.Conduit.getKnownDevices();
  assert.equal(left.length, 1);
  assert.equal(left[0].ip, '10.0.0.6');
});
