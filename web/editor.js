// editor.js — Monaco editor bootstrap for the IDE tab.
// Loaded lazily when the IDE tab is first activated to keep the device-manager
// tab snappy. Monaco ships from jsdelivr; workers are loaded via an inline
// data-URL shim so cross-origin (GH Pages → jsdelivr) works without same-origin
// restrictions.

(function () {
  'use strict';

  const MONACO_VERSION = '0.52.0';
  const MONACO_BASE = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min`;

  let monacoReady = null; // Promise<monaco>
  let editorInstance = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  function configureWorkerShim() {
    // Inline worker that re-hosts Monaco's language workers from the CDN.
    // Without this, Monaco would try to load workers from the current origin,
    // which fails on GH Pages (workers must be same-origin or data-url).
    self.MonacoEnvironment = {
      getWorkerUrl(moduleId, label) {
        const body = `
          self.MonacoEnvironment = { baseUrl: '${MONACO_BASE}/' };
          importScripts('${MONACO_BASE}/vs/base/worker/workerMain.js');
        `;
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(body)}`;
      },
    };
  }

  async function loadMonaco() {
    if (monacoReady) return monacoReady;
    monacoReady = (async () => {
      configureWorkerShim();
      await loadScript(`${MONACO_BASE}/vs/loader.js`);
      // Monaco's AMD loader is exposed as global `require`. Configure its path.
      window.require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
      await new Promise((resolve) => window.require(['vs/editor/editor.main'], resolve));
      return window.monaco;
    })();
    return monacoReady;
  }

  // Monaco theme — prefers the explicit Conduit `data-theme` attribute
  // (set by the topbar toggle), falls back to the OS preference. Without
  // the attribute check, the user can flip the topbar to "light" and
  // the chrome turns light but the editor stays dark.
  function pickTheme() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light') return 'vs';
    if (attr === 'dark')  return 'vs-dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs';
  }

  async function mountEditor(containerId, initialSource) {
    const monaco = await loadMonaco();
    const host = document.getElementById(containerId);
    if (!host) throw new Error(`Editor host element #${containerId} not found`);
    // Clear any placeholder content in the div.
    host.innerHTML = '';
    editorInstance = monaco.editor.create(host, {
      value: initialSource || '',
      language: 'c',
      theme: pickTheme(),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 4,
      insertSpaces: true,
      scrollBeyondLastLine: false,
    });
    // Live-follow the OS color scheme AND the Conduit data-theme
    // toggle. The MutationObserver fires whenever the topbar's
    // light/dark buttons flip data-theme on <html>.
    const reapply = () => monaco.editor.setTheme(pickTheme());
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', reapply);
    new MutationObserver(reapply).observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    });
    return editorInstance;
  }

  function getSource() {
    return editorInstance ? editorInstance.getValue() : null;
  }

  function setSource(s) {
    if (editorInstance) editorInstance.setValue(s);
  }

  function setMarkers(diagnostics) {
    // diagnostics: [{ line, column, endLine?, endColumn?, message, severity? }]
    // severity: 'error' | 'warning' | 'info'
    if (!editorInstance) return;
    const monaco = window.monaco;
    const sevMap = {
      error: monaco.MarkerSeverity.Error,
      warning: monaco.MarkerSeverity.Warning,
      info: monaco.MarkerSeverity.Info,
    };
    const markers = diagnostics.map((d) => ({
      startLineNumber: d.line,
      startColumn: d.column,
      endLineNumber: d.endLine || d.line,
      endColumn: d.endColumn || (d.column + 1),
      message: d.message,
      severity: sevMap[d.severity || 'error'],
    }));
    monaco.editor.setModelMarkers(editorInstance.getModel(), 'conduit-cc', markers);
  }

  function clearMarkers() {
    if (!editorInstance) return;
    window.monaco.editor.setModelMarkers(editorInstance.getModel(), 'conduit-cc', []);
  }

  // Register a debounced/direct content-change callback. Callers may subscribe
  // before the editor is mounted; we queue until onDidChangeModelContent is
  // available. Used by ide.js to persist source to localStorage on every edit.
  const pendingSubs = [];
  function onChange(cb) {
    if (typeof cb !== 'function') return;
    if (editorInstance) {
      editorInstance.onDidChangeModelContent(() => cb(getSource()));
    } else {
      pendingSubs.push(cb);
    }
  }
  function flushPendingSubs() {
    if (!editorInstance) return;
    while (pendingSubs.length) {
      const cb = pendingSubs.shift();
      editorInstance.onDidChangeModelContent(() => cb(getSource()));
    }
  }

  const originalMount = mountEditor;
  async function mountAndFlush(id, src) {
    const res = await originalMount(id, src);
    flushPendingSubs();
    return res;
  }

  window.Conduit = window.Conduit || {};
  window.Conduit.editor = {
    mount: mountAndFlush,
    getSource,
    setSource,
    setMarkers,
    clearMarkers,
    onChange,
  };
})();
