// data_loss_check.mjs — Headless analyzer for the SEQ channel collected
// by a long-running browser session against sim_server.mjs.
//
// Workflow:
//   1. Start sim_server with the SEQ channel (already the default).
//   2. Run web/tests/sim_server.mjs alongside the IDE; let the browser
//      tail telemetry for N minutes.
//   3. In the browser console, dump the SEQ channel:
//        copy(JSON.stringify({
//          start: window.__lossTestStartMs,
//          end:   window.Conduit.dataStore.sessionEndWallMs,
//          seq:   (() => {
//            const s = window.Conduit.dataStore.slice('SEQ', { copy: true });
//            return { count: s.count, values: Array.from(s.values),
//                     uptimeUs: Array.from(s.uptimeUs),
//                     wallMs:   Array.from(s.wallMs) };
//          })(),
//          stats: window.Conduit.dataStore.stats(),
//          diag:  window.CONDUIT_DIAG && window.CONDUIT_DIAG().events,
//        }, null, 2))
//   4. Paste the clipboard into a file (e.g. /tmp/seq-dump.json).
//   5. Run: node web/tests/data_loss_check.mjs /tmp/seq-dump.json
//
// Output:
//   - Total samples received vs expected (rate × duration)
//   - Every gap in the SEQ counter, with size + wall-clock window
//   - Cluster overlap with diag events (stall.abort / runStream.error)

import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path) {
  console.error('usage: node data_loss_check.mjs <seq-dump.json>');
  process.exit(2);
}
const dump = JSON.parse(await readFile(path, 'utf8'));

const seq = dump.seq;
if (!seq || !seq.count) {
  console.error('FAIL: no SEQ samples in dump');
  process.exit(1);
}

console.log(`SEQ samples received : ${seq.count}`);
console.log(`first SEQ value      : ${seq.values[0]}`);
console.log(`last  SEQ value      : ${seq.values[seq.count - 1]}`);
console.log(`session end - start  : ${((dump.end - dump.start) / 1000).toFixed(1)}s`);

// Walk the values; report any non-1 increment.
const gaps = [];
for (let i = 1; i < seq.count; i++) {
  const delta = seq.values[i] - seq.values[i - 1];
  if (delta !== 1) {
    gaps.push({
      atIdx:    i,
      seqBefore: seq.values[i - 1],
      seqAfter:  seq.values[i],
      lostCount: delta - 1,
      wallMsBefore: seq.wallMs[i - 1],
      wallMsAfter:  seq.wallMs[i],
      gapMs:    seq.wallMs[i] - seq.wallMs[i - 1],
    });
  }
}

const expected = (seq.values[seq.count - 1] - seq.values[0]) + 1;
const lossPct = ((expected - seq.count) / expected * 100).toFixed(3);

console.log('');
console.log(`expected (last-first+1): ${expected}`);
console.log(`actual                 : ${seq.count}`);
console.log(`missing                : ${expected - seq.count}  (${lossPct}%)`);
console.log(`gap count              : ${gaps.length}`);
console.log('');

if (gaps.length === 0) {
  console.log('PASS: no SEQ gaps — zero data loss in the captured window');
} else {
  console.log(`FAIL: ${gaps.length} gap(s) — sample of first 10:`);
  for (const g of gaps.slice(0, 10)) {
    const t = new Date(g.wallMsAfter).toISOString().slice(11, 23);
    console.log(`  @${t}  SEQ ${g.seqBefore} → ${g.seqAfter}  ` +
                `(lost ${g.lostCount}, ${g.gapMs.toFixed(0)}ms gap)`);
  }
  if (gaps.length > 10) console.log(`  ... and ${gaps.length - 10} more`);

  // Cluster gaps with diag events that landed inside the same wall-ms
  // window (±1000ms). Helps tell "loss happened during a stall" from
  // "loss happened mid-steady-state".
  if (Array.isArray(dump.diag)) {
    console.log('');
    console.log('diag events near gaps:');
    for (const g of gaps.slice(0, 10)) {
      const wallStart = g.wallMsBefore;
      const events = dump.diag.filter((e) => {
        // diag.t is ms since page-load — convert to wall-ms via the run start.
        const wall = dump.start + e.t;
        return Math.abs(wall - wallStart) < 1500;
      });
      if (events.length > 0) {
        console.log(`  gap @SEQ ${g.seqBefore}: ${events.map((e) => e.event).join(', ')}`);
      }
    }
  }
  process.exit(1);
}
