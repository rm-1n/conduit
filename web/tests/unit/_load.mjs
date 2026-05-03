// Tiny harness that loads browser-flavoured JS files into the current
// Node process. Most modules in web/ are IIFEs that attach to
// `window.Conduit`; the harness fakes a `window` and `localStorage`
// before sourcing them so the unit tests can exercise the public API
// without spinning up a browser.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const webRoot = join(here, '..', '..');

// Minimal localStorage mock — used by commands.js (token, presets) and
// control.js (layout). In-memory; isolated per test by calling reset().
class MemStorage {
  constructor() { this._m = new Map(); }
  getItem(k)    { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(k, String(v)); }
  removeItem(k) { this._m.delete(k); }
  clear()       { this._m.clear(); }
  key(i)        { return Array.from(this._m.keys())[i] ?? null; }
  get length()  { return this._m.size; }
}

export function makeWindow() {
  const fakeWin = {
    Conduit: {},
    localStorage: new MemStorage(),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    // CustomEvent shim — conduit events are fired/dispatched but our
    // tests don't need to observe them.
    CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d?.detail; } },
    document: {
      // The IIFEs touch document.getElementById / addEventListener
      // during init() helpers. Return harmless stubs. readyState='loading'
      // keeps DOMContentLoaded-gated bootstraps from firing — exactly what
      // we want for unit tests, since most modules' bootstrap kicks off
      // network loops we'd otherwise have to manually stop.
      getElementById() { return null; },
      querySelector()  { return null; },
      querySelectorAll(){ return []; },
      addEventListener() {},
      readyState: 'loading',
    },
  };
  return fakeWin;
}

// Source a browser file in a fresh-ish global scope. Returns the
// `window` object so tests can read off Conduit.<feature>.
export function loadModule(filename, win = makeWindow()) {
  const src = readFileSync(join(webRoot, filename), 'utf8');
  // Provide window/localStorage/document as locals so `(function(){})()`
  // IIFEs can find them.
  const fn = new Function('window', 'localStorage', 'document', 'globalThis', src);
  fn(win, win.localStorage, win.document, win);
  return win;
}
