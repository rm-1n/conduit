// Unit tests for the IDE layout solver — the pure function that takes
// the viewport width plus saved telemetry / build-log percentages and
// produces the clamped percentages required to keep every pane at or
// above its minimum width.
//
// What we're protecting against:
//   • A saved telemetry-w that's too wide for the current viewport
//     (window shrunk between sessions, mins increased, etc.)
//   • A saved log-w that's too wide for the bottom area (bottom area
//     itself depends on telemetry-w → cascading clamp)
//   • The user's reported scenario: drag log wide, THEN drag telemetry
//     wide — without cascading the inner constraint, log stays at its
//     stale percentage and the runtime console gets crushed.
//
// Convention: percentages are 0..100. The solver doesn't touch any DOM —
// callers compute container widths from the returned percentages and
// apply CSS variables themselves.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadModule } from './_load.mjs';

const win = loadModule('ide.js');
const solveLayout = win.PicoPoE && win.PicoPoE.layout && win.PicoPoE.layout.solve;
if (!solveLayout) throw new Error('window.PicoPoE.layout.solve not exposed by ide.js');

// Default mins lifted from style.css / index.html. Kept here so the
// tests detect drift if either side bumps a min without updating
// the other.
const MINS = {
  log: 360,
  console: 420,
  telemetry: 420,
  resizer: 6,                // log↔console + main↔telemetry
};

function widths({ ideLayoutPx, telemetryPct, logPct }) {
  // Replicate the rendered geometry for assertion convenience.
  const telPx = (telemetryPct / 100) * ideLayoutPx;
  const main  = ideLayoutPx - MINS.resizer - telPx;
  const logPx = (logPct / 100) * main;
  const conPx = main - MINS.resizer - logPx;
  return { tel: telPx, main, log: logPx, con: conPx };
}

function expectFitting(out, ideLayoutPx) {
  const w = widths({ ideLayoutPx, ...out });
  assert.ok(w.tel >= MINS.telemetry - 0.5, `telemetry ${w.tel} < ${MINS.telemetry}`);
  assert.ok(w.log >= MINS.log - 0.5, `log ${w.log} < ${MINS.log}`);
  assert.ok(w.con >= MINS.console - 0.5, `console ${w.con} < ${MINS.console}`);
  // Sum invariant: viewport == main + 6 + tel
  assert.ok(Math.abs(ideLayoutPx - (w.main + MINS.resizer + w.tel)) < 1);
  // bottom = log + 6 + con
  assert.ok(Math.abs(w.main - (w.log + MINS.resizer + w.con)) < 1);
}

// ───────────────────────────────────────────────────────────────────
// Basic: well-behaved inputs pass through
// ───────────────────────────────────────────────────────────────────

test('solve: defaults at typical viewport leave inputs unchanged when valid', () => {
  // Viewport 1512, telemetry 35%, log 50% → all inside their bands.
  const out = solveLayout({ ideLayoutPx: 1512, telemetryPct: 35, logPct: 50, mins: MINS });
  assert.equal(out.telemetryPct, 35);
  assert.equal(out.logPct, 50);
  expectFitting(out, 1512);
});

test('solve: leaves the inputs alone if everything already fits', () => {
  for (const tel of [25, 30, 40, 47]) {
    for (const log of [40, 50, 55]) {
      const out = solveLayout({ ideLayoutPx: 1512, telemetryPct: tel, logPct: log, mins: MINS });
      expectFitting(out, 1512);
    }
  }
});

// ───────────────────────────────────────────────────────────────────
// Scenario A: saved telemetry too wide → telemetry shrinks first
// ───────────────────────────────────────────────────────────────────

test('solve: telemetry capped so main column ≥ log_min + 6 + console_min', () => {
  const out = solveLayout({ ideLayoutPx: 1512, telemetryPct: 90, logPct: 50, mins: MINS });
  // Max telemetry % = (1 - 792/1512)*100 = 47.62
  assert.ok(out.telemetryPct <= 47.7, `telemetry ${out.telemetryPct} > 47.7`);
  expectFitting(out, 1512);
});

test('solve: telemetry honours its own minimum', () => {
  const out = solveLayout({ ideLayoutPx: 1512, telemetryPct: 5, logPct: 50, mins: MINS });
  // Min telemetry % = (420/1512)*100 = 27.78
  assert.ok(out.telemetryPct >= 27.7, `telemetry ${out.telemetryPct} < 27.7`);
  expectFitting(out, 1512);
});

// ───────────────────────────────────────────────────────────────────
// Scenario B: saved log too wide for current bottom area
// ───────────────────────────────────────────────────────────────────

test('solve: log clamps when its % would crush the runtime console', () => {
  // Viewport 1512, telemetry 47% (≈max), so bottom-area ≈ 794. With
  // log=70% of 794 = 555, console = 794-555-6 = 233 < 420 → must clamp log.
  const out = solveLayout({ ideLayoutPx: 1512, telemetryPct: 47, logPct: 70, mins: MINS });
  expectFitting(out, 1512);
  // Concretely: with the same telemetry, log should be ≤ a value that
  // leaves console ≥ 420.
  assert.ok(out.logPct < 70, 'log was not actually shrunk');
});

test('solve: user-reported scenario — log wide first, then telemetry wide', () => {
  // Replays the exact reported sequence on a 1512 viewport:
  //   1. user drags log to 70% (bottom-area was wide, so this was fine)
  //   2. user drags telemetry to 47%, shrinking bottom-area
  // Without cascading clamp, log stays at 70% of the now-narrow bottom-
  // area and the runtime console is invisible. solveLayout must catch
  // this regardless of input order.
  const out = solveLayout({ ideLayoutPx: 1512, telemetryPct: 47, logPct: 70, mins: MINS });
  expectFitting(out, 1512);
});

// ───────────────────────────────────────────────────────────────────
// Scenario C: every combination of "user pushes to extremes"
// ───────────────────────────────────────────────────────────────────

test('solve: combinations of extreme telemetry and log percentages all fit', () => {
  const cases = [];
  for (const tel of [5, 25, 35, 47, 60, 80, 95]) {
    for (const log of [5, 25, 50, 70, 95]) {
      cases.push({ tel, log });
    }
  }
  for (const { tel, log } of cases) {
    const out = solveLayout({ ideLayoutPx: 1512, telemetryPct: tel, logPct: log, mins: MINS });
    expectFitting(out, 1512);
  }
});

// ───────────────────────────────────────────────────────────────────
// Scenario D: viewport variations — narrower panels still fit
// ───────────────────────────────────────────────────────────────────

test('solve: tighter viewport still satisfies all mins (down to total min)', () => {
  // Total minimum width = log(360) + 6 + console(420) + 6 + telemetry(420) = 1212
  const out = solveLayout({ ideLayoutPx: 1212, telemetryPct: 50, logPct: 50, mins: MINS });
  expectFitting(out, 1212);
});

test('solve: viewport below total min — solver returns best-effort, no crash', () => {
  // 1100 < 1212 — geometry can't satisfy every min. Solver must NOT
  // throw; the caller handles overflow (CSS scrollbars / clipped panes).
  // We assert percentages are finite + 0..100.
  const out = solveLayout({ ideLayoutPx: 1100, telemetryPct: 35, logPct: 50, mins: MINS });
  assert.ok(Number.isFinite(out.telemetryPct));
  assert.ok(Number.isFinite(out.logPct));
  assert.ok(out.telemetryPct >= 0 && out.telemetryPct <= 100);
  assert.ok(out.logPct >= 0 && out.logPct <= 100);
});

// ───────────────────────────────────────────────────────────────────
// Scenario E: idempotence — running solve twice on its own output
// ───────────────────────────────────────────────────────────────────

test('solve: idempotent — second run returns identical values', () => {
  const o1 = solveLayout({ ideLayoutPx: 1512, telemetryPct: 90, logPct: 80, mins: MINS });
  const o2 = solveLayout({ ideLayoutPx: 1512, telemetryPct: o1.telemetryPct, logPct: o1.logPct, mins: MINS });
  assert.ok(Math.abs(o1.telemetryPct - o2.telemetryPct) < 0.01);
  assert.ok(Math.abs(o1.logPct - o2.logPct) < 0.01);
});

// ───────────────────────────────────────────────────────────────────
// Scenario F: order independence — same inputs in any order
// ───────────────────────────────────────────────────────────────────

test('solve: clamping order doesn\'t matter (telemetry-then-log == log-then-telemetry)', () => {
  // Apply tel-first: solve with bad tel, valid log.
  const a = solveLayout({ ideLayoutPx: 1512, telemetryPct: 90, logPct: 50, mins: MINS });
  // Apply log-first: solve with valid tel, bad log.
  const b = solveLayout({ ideLayoutPx: 1512, telemetryPct: a.telemetryPct, logPct: 80, mins: MINS });
  // Apply both bad simultaneously.
  const c = solveLayout({ ideLayoutPx: 1512, telemetryPct: 90, logPct: 80, mins: MINS });
  // Final telemetry should be the same regardless of how we got there.
  assert.ok(Math.abs(a.telemetryPct - c.telemetryPct) < 0.01);
  assert.ok(Math.abs(b.telemetryPct - c.telemetryPct) < 0.01);
  // Log final value should also match between b and c.
  assert.ok(Math.abs(b.logPct - c.logPct) < 0.01);
});
