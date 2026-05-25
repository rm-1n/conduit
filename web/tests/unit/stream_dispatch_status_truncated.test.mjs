// Regression: stream.js's dispatchStatus used to JSON.parse a STATUS
// frame and silently `return` on parse failure. After ws_push_status's
// fixed-buffer body (`char body[N]` in ws_server.c) started truncating
// — same shape as the HTTP-side /api/status truncation — every
// STATUS frame on the wire became unparseable, and onStatus
// subscribers stopped firing. Two visible symptoms:
//   * IDE's "[device] v… (binary …)" build-log line never updates
//     after OTA (the dedupe never sees a new line because the
//     callback never fires),
//   * telemetry's schema map never picks up data_schema from STATUS,
//     so the first records of a fresh session come in as unknown
//     msgId and the chart starts cycling through HTTPS /api/data_schema
//     refreshes.
// dispatchStatus must salvage the head of the truncated body and
// still dispatch to subscribers.
//
// Source-level test only: stream.js doesn't expose dispatchStatus as
// part of the public API, and standing up a fake WebSocket to drive
// the real receive path is too coupled to the IIFE's internal life-
// cycle to be stable across refactors. Instead we assert the salvage
// shape directly against the source (loud failure if a future
// refactor regresses), and we validate the regex shape against a
// representative truncated body so the salvage actually catches the
// fields it claims to.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const streamJs = readFileSync(join(here, '..', '..', 'stream.js'), 'utf8');

test('stream.js source: dispatchStatus has truncated-body salvage path', () => {
  const fn = streamJs.slice(streamJs.indexOf('function dispatchStatus'),
                            streamJs.indexOf('function dispatchNotice'));
  assert.ok(/catch[\s\S]*pick/.test(fn),
    'dispatchStatus must include a salvage path inside its catch — silently returning on parse failure breaks onStatus subscribers');
  assert.ok(/_truncated/.test(fn),
    'salvaged objects must be tagged _truncated:true so subscribers can warn');
  assert.ok(/version[\s\S]*partition/.test(fn),
    'salvage path must recover version + partition (the minimum needed to broadcast)');
});

test('stream.js source: salvage propagates stream_close_* + liveness counters', () => {
  // The IDE's "[device] stream-close: <bucket>=<n>" diff line lives
  // on stream_close_* buckets surfacing via STATUS frames. If the
  // salvage path stops recovering them, every reconnect's bucket
  // attribution disappears — exactly the diagnostic we need when
  // the WS cycles unexplained.
  const fn = streamJs.slice(streamJs.indexOf('function dispatchStatus'),
                            streamJs.indexOf('function dispatchNotice'));
  for (const k of [
    'stream_close_recv_eof', 'stream_close_err_abrt',
    'stream_close_ws_parse_fail', 'stream_close_link_down',
    'stream_last_close_err', 'stream_last_close_age_ms',
    'core1_iter', 'http_poll_fires',
  ]) {
    assert.ok(fn.includes(k),
      `salvage must include "${k}" — surfaces diagnostic the IDE prints on every reconnect`);
  }
});

test('salvage regex shape recovers fields from a real-world truncated body', () => {
  // Real bytes pulled from `curl http://device/api/status` on a v10.82
  // build whose http_server.c still has the old HTTP_MAX_RESPONSE of
  // 1024. The end cuts mid-string inside "device":"conduit". The IDE
  // shape sends the same body over WS via ws_push_status.
  const truncated =
    '{"version":"1.2.0","binary_version":"10.82","ip":"192.168.178.200",' +
    '"mac":"B8:27:EB:91:77:01","uptime":283,"link":true,"poe":false,' +
    '"partition":"B","board_id":"29166ac0e5917701","ota_in_progress":false,' +
    '"ota_bytes_written":0,"rx_drops":0,"boot_type":"normal",' +
    '"tbyb_pending":true,"data_ring_evictions":0,"data_ring_evicted_bytes":0,' +
    '"streams_open":1,"stream_close_recv_eof":0,"stream_close_recv_err":0,' +
    '"stream_close_err_rst":0,"stream_close_err_abrt":0,"stream_close_err_clsd":0,' +
    '"stream_close_err_other":0,"stream_close_write_err":0,' +
    '"stream_close_ws_parse_fail":27,"stream_close_link_down":0,' +
    '"stream_last_close_err":0,"stream_last_close_age_ms":10785,' +
    '"core1_iter":162726084,"http_poll_fires":2179,"http_accepts":34,' +
    '"http_streams_started":28,"device":"cond';
  const pickStr  = (k) => { const m = truncated.match(new RegExp(`"${k}":"([^"]*)"`)); return m && m[1]; };
  const pickInt  = (k) => { const m = truncated.match(new RegExp(`"${k}":(-?\\d+)`)); return m && parseInt(m[1], 10); };
  const pickBool = (k) => { const m = truncated.match(new RegExp(`"${k}":(true|false)`)); return m && (m[1] === 'true'); };
  assert.equal(pickStr('version'), '1.2.0');
  assert.equal(pickStr('binary_version'), '10.82');
  assert.equal(pickStr('partition'), 'B');
  assert.equal(pickInt('uptime'), 283);
  assert.equal(pickBool('link'), true);
  assert.equal(pickBool('tbyb_pending'), true);
  assert.equal(pickInt('streams_open'), 1);
  assert.equal(pickInt('stream_close_ws_parse_fail'), 27,
    'this is the exact bucket that was incrementing in the 5-second-cycle case the user reported');
  assert.equal(pickInt('stream_last_close_age_ms'), 10785);
  assert.equal(pickInt('core1_iter'), 162726084);
});
