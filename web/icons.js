// icons.js — Inline SVG icons (Material Symbols, 24×24, viewBox 0 -960 960 960).
//
// Inlined rather than served as a font so we keep the zero-dependency
// posture of the IDE (no extra HTTP fetch, no FOIT) and so each icon
// inherits text colour via fill="currentColor". Use:
//
//   <span class="icon" data-icon="pause"></span>     (CSS hydrates from below)
//   icons.svg('pause', { size: 16 })                  (returns an SVG string)
//   icons.set(buttonEl, 'play')                       (replaces button content)
//
// Naming follows the Material Symbols catalog so swapping in a new
// glyph later is a one-line lookup change.

(function () {
  'use strict';

  // Path-only — wrapping <svg> is added in `svg()` below.
  const PATHS = {
    // Side-panel toggles — exactly the two SVGs the user supplied.
    panel_close:        'M460-320v-320L300-480l160 160ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm440-80h120v-560H640v560Zm-80 0v-560H200v560h360Zm80 0h120-120Z',
    panel_open:         'M300-640v320l160-160-160-160ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm440-80h120v-560H640v560Zm-80 0v-560H200v560h360Zm80 0h120-120Z',

    // Playback controls.
    pause:              'M520-200v-560h240v560H520Zm-320 0v-560h240v560H200Zm400-80h80v-400h-80v400Zm-320 0h80v-400h-80v400Zm0-400v400-400Zm320 0v400-400Z',
    play_arrow:         'M320-200v-560l440 280-440 280Zm80-280Zm0 134 210-134-210-134v268Z',

    // Clock with hour/minute hands — used for the "Show times" toggle
    // in the runtime console.
    schedule:           'M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm112-192 56-56-128-128v-184h-80v216l152 152ZM480-480Z',

    // Buffer-clear (broom-sweep glyph reads as "wipe this view"). Falls
    // back to the simple X if anything in the toolchain mis-renders.
    clear:              'M120-280v-80h280v80H120Zm0-160v-80h440v80H120Zm0-160v-80h440v80H120Zm520 320L480-440l56-56 104 104 224-224 56 58-280 280Z',

    // Bundled telemetry+log download — moved from the runtime console
    // header into the telemetry header.
    download:           'M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z',

    // Used by the editable cmd-presets row.
    add:                'M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z',
    // 6-dot drag handle. Sits in the plot header so individual plots
    // can be reordered via mouse drag without the whole plot subtree
    // being a drag source.
    drag_indicator:     'M360-160q-33 0-56.5-23.5T280-240q0-33 23.5-56.5T360-320q33 0 56.5 23.5T440-240q0 33-23.5 56.5T360-160Zm240 0q-33 0-56.5-23.5T520-240q0-33 23.5-56.5T600-320q33 0 56.5 23.5T680-240q0 33-23.5 56.5T600-160ZM360-400q-33 0-56.5-23.5T280-480q0-33 23.5-56.5T360-560q33 0 56.5 23.5T440-480q0 33-23.5 56.5T360-400Zm240 0q-33 0-56.5-23.5T520-480q0-33 23.5-56.5T600-560q33 0 56.5 23.5T680-480q0 33-23.5 56.5T600-400ZM360-640q-33 0-56.5-23.5T280-720q0-33 23.5-56.5T360-800q33 0 56.5 23.5T440-720q0 33-23.5 56.5T360-640Zm240 0q-33 0-56.5-23.5T520-720q0-33 23.5-56.5T600-800q33 0 56.5 23.5T680-720q0 33-23.5 56.5T600-640Z',
    // Reserved for future "expand this plot into a fullscreen view"
    // affordance. Same Chart instance can be relocated under a
    // different parent so its buffer/state survives the round-trip.
    open_in_full:       'M120-120v-200h80v120h120v80H120Zm520 0v-80h120v-120h80v200H640ZM120-640v-200h200v80H200v120h-80Zm640 0v-120H640v-80h200v200h-80Z',
    // Four-corner "frame" icon — used by the per-plot auto-range
    // button (resets x to the 10 s window, y to autorange of visible
    // series). Different glyph from open_in_full so the two
    // affordances don't visually collide.
    crop_free:          'M200-120q-33 0-56.5-23.5T120-200v-160h80v160h160v80H200Zm400 0v-80h160v-160h80v160q0 33-23.5 56.5T760-120H600ZM120-600v-160q0-33 23.5-56.5T200-840h160v80H200v160h-80Zm640 0v-160H600v-80h160q33 0 56.5 23.5T840-760v160h-80Z',
    edit:               'M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z',
    delete:             'M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z',
    check:              'M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z',
    close:              'm256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z',
    // Three horizontal lines tapering bottom-right — used for the
    // per-plot channel picker that lets the user pick which series a
    // plot shows when there are too many to fit comfortably in the
    // legend.
    filter_list:        'M400-240v-80h160v80H400ZM240-440v-80h480v80H240ZM120-640v-80h720v80H120Z',
  };

  // Build a complete <svg> string. Default size 16 keeps it usable inside
  // .btn-mini buttons without overpowering the surrounding chrome.
  function svg(name, opts = {}) {
    const path = PATHS[name];
    if (!path) return '';
    const size = opts.size || 16;
    const cls  = opts.class ? ` class="${opts.class}"` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
         + `viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"${cls}>`
         + `<path d="${path}"/></svg>`;
  }

  // Replace the button's content with an icon. Preserves an
  // optional accessible label via aria-label / title — the visible
  // glyph alone isn't enough for screen readers.
  function set(el, name, opts = {}) {
    if (!el) return;
    el.innerHTML = svg(name, opts);
    if (opts.label != null) {
      el.setAttribute('aria-label', opts.label);
      if (!el.title) el.title = opts.label;
    }
  }

  // Hydrate every <span class="icon" data-icon="X"> in the DOM.
  // Called once on init so HTML can reference icons declaratively.
  function hydrate(root = document) {
    for (const el of root.querySelectorAll('.icon[data-icon]')) {
      el.innerHTML = svg(el.dataset.icon, { size: el.dataset.size || 16 });
    }
  }

  window.Conduit = window.Conduit || {};
  window.Conduit.icons = { svg, set, hydrate, NAMES: Object.keys(PATHS) };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => hydrate());
  } else {
    hydrate();
  }
})();
