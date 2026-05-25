// Regression: when the firmware's /api/status response buffer is
// undersized for the JSON it builds (e.g. a new diag field landed but
// HTTP_MAX_RESPONSE wasn't bumped to match), the device responds 200 OK
// with a body cut mid-string. Browsers' `res.json()` throws on the
// malformed body, and the OTA flow's waitForDevice catches & retries
// silently — the user sees "N/30 waiting" prints stack up while the
// network tab shows healthy 200s. getStatus must salvage the head of
// the body via regex so the post-OTA wait can still detect the device.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadModule, makeWindow } from './_load.mjs';

function harness() {
  const win = makeWindow();
  win.Conduit.deviceUrlForIp = (ip, path) => `http://${ip}${path}`;
  loadModule('upload.js', win);
  return win;
}

function fakeResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok, status,
    text: async () => body,
    json: async () => JSON.parse(body),  // intentionally throws on truncated body
  };
}

test('getStatus: full JSON body parses normally', async () => {
  const win = harness();
  const body = JSON.stringify({
    version: '1.2.0', binary_version: '10.82', ip: '10.0.0.5',
    partition: 'A', uptime: 42, link: true, tbyb_pending: false,
  });
  globalThis.fetch = async () => fakeResponse(body);
  const s = await win.Conduit.getStatus('10.0.0.5', 1000, { allowCached: false });
  assert.equal(s.version, '1.2.0');
  assert.equal(s.partition, 'A');
  assert.equal(s.uptime, 42);
  assert.equal(s._truncated, undefined,
    'a well-formed body must NOT be flagged truncated — otherwise downstream consumers treat every successful fetch as suspect');
});

test('getStatus: truncated body → salvages version/partition/uptime', async () => {
  const win = harness();
  // Real-world truncation shape — fields cut off mid-string near the end.
  // The fields the salvage path needs all appear before the cut.
  const truncated =
    '{"version":"1.2.0","binary_version":"10.82","ip":"192.168.178.200",' +
    '"mac":"B8:27:EB:91:77:01","uptime":283,"link":true,"poe":false,' +
    '"partition":"B","board_id":"29166ac0e5917701","ota_in_progress":false,' +
    '"ota_bytes_written":0,"rx_drops":0,"boot_type":"normal",' +
    '"tbyb_pending":true,"data_ring_evictions":0,"data_ring_evicted_bytes":0,' +
    '"streams_open":1,"stream_close_recv_eof":0,"stream_close_recv_err":0,' +
    '"stream_close_err_rst":0,"stream_close_err_abrt":0,"stream_close_err_clsd":0,' +
    '"device":"cond';  // cut mid-string
  globalThis.fetch = async () => fakeResponse(truncated);
  const s = await win.Conduit.getStatus('192.168.178.200', 1000, { allowCached: false });
  assert.equal(s.version, '1.2.0');
  assert.equal(s.binary_version, '10.82');
  assert.equal(s.partition, 'B');
  assert.equal(s.uptime, 283, 'uptime is critical — waitForDevice rejects pre-reboot status using it');
  assert.equal(s.tbyb_pending, true, 'tbyb_pending decides whether updateFirmware calls /api/commit');
  assert.equal(s.ota_in_progress, false);
  assert.equal(s.link, true);
  assert.equal(s._truncated, true, 'salvage path must flag the result so downstream code can log/warn');
});

test('getStatus: malformed body missing required fields → still throws', async () => {
  const win = harness();
  // Truncated so early that not even "version" + "partition" are present.
  const tooShort = '{"binary_ver';
  globalThis.fetch = async () => fakeResponse(tooShort);
  await assert.rejects(
    () => win.Conduit.getStatus('10.0.0.5', 1000, { allowCached: false }),
    /malformed body/,
    'with no salvageable fields the function must throw — synthesising an empty status would let waitForDevice return a meaningless "post" and the rollback-detection (post.version === pre.version) would misfire');
});

test('getStatus: non-200 response throws (unchanged)', async () => {
  const win = harness();
  globalThis.fetch = async () => fakeResponse('', { ok: false, status: 503 });
  await assert.rejects(
    () => win.Conduit.getStatus('10.0.0.5', 1000, { allowCached: false }),
    /HTTP 503/);
});
