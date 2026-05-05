// Unit tests for the per-plot channel picker in chart.js. Verifies:
//   1. Excluding a channel via the picker stops it from registering
//      with this chart (knownChannels stays out).
//   2. The picker filter is plot-local — pushing the same record into
//      another (non-excluded) plot still registers it there.
//   3. `dataStore.append()` is independent of any chart's picker
//      (telemetry.js calls it BEFORE chart.push, so a record excluded
//      from every plot is still recorded for HDF5 export).
//   4. Deselecting the only-rendered channel destroys the previous
//      uPlot instance and shows the "waiting for telemetry…"
//      placeholder, instead of leaving stale traces on screen.
//
// Chart.js needs a real-ish DOM + a uPlot constructor + ResizeObserver
// to load. The stubs below are the minimum surface to get init() to
// run cleanly and let `Conduit.charts.add()` mount a Chart we can
// drive directly.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..');

// ---- Browser stubs --------------------------------------------------

class ClassList {
  constructor() { this._set = new Set(); }
  add(...c) { c.forEach((x) => this._set.add(x)); }
  remove(...c) { c.forEach((x) => this._set.delete(x)); }
  toggle(c, force) {
    if (force === true)  { this._set.add(c);    return true;  }
    if (force === false) { this._set.delete(c); return false; }
    if (this._set.has(c)) { this._set.delete(c); return false; }
    this._set.add(c); return true;
  }
  contains(c) { return this._set.has(c); }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName    = tag.toUpperCase();
    this.children   = [];
    this.dataset    = {};
    this.style      = {};
    this.classList  = new ClassList();
    this.attributes = new Map();
    this._listeners = new Map();
    this.parentNode = null;
    this.hidden     = false;
    this.draggable  = false;
    this._innerHTML = '';
    this.title      = '';
    this.type       = '';
    this.value      = '';
    this.textContent = '';
  }
  // Setting innerHTML='' is the idiom chart.js uses to wipe a mount;
  // mirror real-DOM behaviour by detaching all children so subsequent
  // appendChild calls produce the same `.children` array we'd see in
  // a browser. (Non-empty assignments aren't used by the code under
  // test, so we don't bother parsing them.)
  set innerHTML(v) {
    this._innerHTML = v;
    if (v === '') {
      for (const c of this.children) c.parentNode = null;
      this.children = [];
    }
  }
  get innerHTML() { return this._innerHTML; }
  // chart.js uses both `el.className = 'x'` and `el.classList.add(...)`
  // interchangeably; mirror real-DOM by syncing one to the other.
  set className(v) {
    this.classList = new ClassList();
    if (v) for (const tok of String(v).split(/\s+/)) if (tok) this.classList.add(tok);
  }
  get className() { return [...this.classList._set].join(' '); }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  setAttribute(k, v) { this.attributes.set(k, v); }
  getAttribute(k)    { return this.attributes.get(k) ?? null; }
  addEventListener(ev, fn) {
    if (!this._listeners.has(ev)) this._listeners.set(ev, []);
    this._listeners.get(ev).push(fn);
  }
  removeEventListener() {}
  querySelector()    { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { width: 600, height: 200, top: 0, left: 0, right: 600, bottom: 200 }; }
  get clientWidth()  { return 600; }
  get clientHeight() { return 200; }
  get nextElementSibling() { return null; }
  focus() {}
}

class FakeUplot {
  constructor(opts, data) {
    this.opts = opts;
    this.data = data || [];
    this.series = opts.series || [];
    this.scales = { x: { min: 0, max: 0, time: true }, y: { min: 0, max: 0 } };
    this.over = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 200 }) };
    this.ctx = { measureText: () => ({ width: 10 }), font: '', save() {}, restore() {} };
  }
  destroy()                {}
  setData(d)               { this.data = d; }
  setSize()                {}
  setScale(name, r)        { Object.assign(this.scales[name] || (this.scales[name] = {}), r); }
  setSeries(idx, opts)     {
    if (this.series[idx] && opts && 'show' in opts) this.series[idx].show = opts.show;
  }
  posToVal(_p, _ax)        { return 0; }
  batch(fn)                { fn(); }
}
class FakeResizeObserver { observe() {} disconnect() {} unobserve() {} }
class MemStorage {
  constructor() { this._m = new Map(); }
  getItem(k)    { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(k, String(v)); }
  removeItem(k) { this._m.delete(k); }
  clear()       { this._m.clear(); }
}

function evalInWindow(filename, win) {
  const src = readFileSync(join(webRoot, filename), 'utf8');
  const fn = new Function('window', 'localStorage', 'document', 'globalThis',
                          'uPlot', 'ResizeObserver', 'requestAnimationFrame',
                          'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
                          'CustomEvent', 'console', src);
  fn(win, win.localStorage, win.document, win,
     win.uPlot, win.ResizeObserver, win.requestAnimationFrame,
     setTimeout, clearTimeout, setInterval, clearInterval,
     win.CustomEvent, console);
}

function loadChart({ withDataStore = false, withStatsEl = false } = {}) {
  const plotsContainer = new FakeElement('div');
  plotsContainer.id = 'ide-plots';
  const statsEl = withStatsEl ? new FakeElement('span') : null;

  const elsById = new Map();
  elsById.set('ide-plots', plotsContainer);
  if (statsEl) elsById.set('ide-telemetry-stats', statsEl);
  const fakeDoc = {
    readyState:    'complete',          // run init() synchronously below
    documentElement: { style: {}, getPropertyValue: () => '' },
    body:           new FakeElement('body'),
    createElement:  (tag) => new FakeElement(tag),
    getElementById: (id) => elsById.get(id) || null,
    querySelector:  () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    dispatchEvent:    () => {},
  };

  const win = {
    Conduit: {
      // chart.js init() reads icons.svg/set; harmless to stub.
      icons: { svg: () => '<svg></svg>', set: () => {} },
    },
    localStorage: new MemStorage(),
    addEventListener:    () => {},
    removeEventListener: () => {},
    dispatchEvent:       () => {},
    requestAnimationFrame: (fn) => { fn(0); return 0; },
    setTimeout, clearTimeout, setInterval, clearInterval,
    uPlot:           FakeUplot,
    ResizeObserver:  FakeResizeObserver,
    document:        fakeDoc,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    CustomEvent:     class { constructor(t, d) { this.type = t; this.detail = d?.detail; } },
    console,
  };

  if (withDataStore) {
    // Load the real dataStore so chart's central-stats reader sees
    // realistic listChannels()/stats() output as we append data.
    evalInWindow('data_store.js', win);
  } else {
    win.Conduit.dataStore = {
      listChannels:      () => [],
      sessionEndWallMs:  null,
      stats:             () => ({ channels: 0, samples: 0 }),
    };
  }

  evalInWindow('chart.js', win);
  return { win, plotsContainer, statsEl };
}

function rec(name, value) {
  return { name, msgId: 0, dtype: 8, n: 1, uptimeUs: 1000, wallMs: 100, values: new Float32Array([value]) };
}

// ---- Tests ----------------------------------------------------------

test('picker exclusion stops the channel from registering with the chart', () => {
  const { win } = loadChart();
  const charts = win.Conduit.charts;
  const c = charts.list()[0];
  assert.ok(c, 'init() should have mounted one default plot');

  c.push(rec('SIN', 0.1));
  assert.ok(c.knownChannels.has('SIN'), 'SIN should register on first push');

  // Drive the picker programmatically (the click handler ultimately
  // calls _setChannelEnabled, so we're reaching the same code path).
  c._setChannelEnabled('SIN', false);
  assert.ok(c.excludedChannels.has('SIN'), 'SIN should be in excludedChannels');
  assert.ok(!c.knownChannels.has('SIN'),    'SIN should be removed from knownChannels');

  // Subsequent push of the SAME channel must NOT re-register.
  c.push(rec('SIN', 0.2));
  assert.ok(!c.knownChannels.has('SIN'),    'excluded SIN should stay out of knownChannels');

  // Other channels should still flow.
  c.push(rec('COS', 0.5));
  assert.ok(c.knownChannels.has('COS'),     'unrelated channel should still register');
});

test('picker filter is plot-local: another plot still receives the record', () => {
  const { win } = loadChart();
  const charts = win.Conduit.charts;
  charts.add({ title: 'Plot 2' });
  const [c1, c2] = charts.list();
  assert.equal(charts.list().length, 2, 'should have two plots');

  c1._setChannelEnabled('SIN', false);
  // The singleton fan-out is what telemetry.js calls; it iterates plots.
  win.Conduit.chart.push(rec('SIN', 0.7));

  assert.ok(!c1.knownChannels.has('SIN'),   'plot 1 excluded → no SIN');
  assert.ok(c2.knownChannels.has('SIN'),    'plot 2 not excluded → SIN registered');
});

test('deselecting the only channel destroys uPlot and shows placeholder', async () => {
  const { win } = loadChart();
  const c = win.Conduit.charts.list()[0];

  c.push(rec('SIN', 0.1));
  // _scheduleRebuild debounces by 50 ms.
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(c.uplot, 'uPlot instance should exist after first channel registers');

  c._setChannelEnabled('SIN', false);
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(c.uplot, null, 'uPlot instance should be torn down when no channels remain');
  // A `.chart-placeholder` child should be back in the mount.
  const hasPlaceholder = c.mount.children.some(
    (el) => el.classList && el.classList.contains('chart-placeholder'));
  assert.ok(hasPlaceholder, 'placeholder should be re-mounted when knownChannels goes empty');
});

test('central stats header keeps updating when every chart excludes the channel', () => {
  const { win, statsEl } = loadChart({ withDataStore: true, withStatsEl: true });
  const ds = win.Conduit.dataStore;
  const c  = win.Conduit.charts.list()[0];

  // First, register SIN and capture a baseline header reading. The
  // central-stats element should show non-empty content once dataStore
  // has at least one sample on at least one channel.
  ds.append({ name: 'SIN', dtype: 8, n: 1, uptimeUs: 1_000_000, wallMs: 1_000, values: new Float32Array([0.1]) });
  win.Conduit.chart.push({ name: 'SIN', msgId: 0, dtype: 8, n: 1, uptimeUs: 1_000_000, wallMs: 1_000, values: new Float32Array([0.1]) });
  const before = statsEl.innerHTML;
  assert.ok(before.length > 0, 'header should populate after the first sample');

  // Exclude SIN — every plot now ignores it. dataStore.append must
  // still happen (it's called from telemetry.js BEFORE chart.push), and
  // the header refresh must still fire so the user sees PTS / TIME
  // ticking instead of a frozen value that reads as "recording stopped".
  c._setChannelEnabled('SIN', false);

  // 200 ms later — simulate telemetry.js doing its drain: dataStore
  // gets the sample, then the singleton chart.push fans out (and our
  // single plot's per-chart push() drops it via excludedChannels).
  for (let i = 1; i <= 5; i++) {
    const usec = 1_000_000 + i * 40_000;
    ds.append({ name: 'SIN', dtype: 8, n: 1, uptimeUs: usec, wallMs: 1_000 + i * 40, values: new Float32Array([i / 10]) });
    win.Conduit.chart.push({ name: 'SIN', msgId: 0, dtype: 8, n: 1, uptimeUs: usec, wallMs: 1_000 + i * 40, values: new Float32Array([i / 10]) });
  }

  const after = statsEl.innerHTML;
  // The PTS segment should reflect 6 samples now (1 baseline + 5 above).
  assert.ok(after.includes('6PTS') || after.includes('6 PTS') || after.match(/>6\s*PTS</),
    `header should show updated sample count after exclusions; got: ${after}`);
  assert.notEqual(after, before, 'header content should change after additional samples');
});

test('reset() clears excludedChannels (post-OTA hygiene)', () => {
  const { win } = loadChart();
  const c = win.Conduit.charts.list()[0];

  c.push(rec('SIN', 0.1));
  c._setChannelEnabled('SIN', false);
  assert.ok(c.excludedChannels.has('SIN'));

  c.reset();
  assert.equal(c.excludedChannels.size, 0,
    'OTA reset should drop stale exclusions — names from old firmware may not exist any more');
  assert.equal(c.knownChannels.size, 0);
});
