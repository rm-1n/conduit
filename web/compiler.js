// compiler.js — in-browser C → bare ELF via a locally-built Emception runtime.
//
// Lazy-loads from ./assets/emception/ and ./assets/sdk/ on the first call to
// compile(). Produced by web/lib/build-toolchain.sh (llvm-box) and the Pico
// SDK bundle staging (see README-SDK.md / web/tests/sdk_build.mjs for the
// exact file layout). Flags + link steps are kept in lockstep with
// web/tests/sdk_build.mjs so the unit test exercises the same code paths
// the browser runs.

(function () {
  'use strict';

  // Marker so we can see in the browser console which compiler.js is live.
  // If you see the setup/loop build fail with an lld "undefined symbol: main"
  // error, check that this marker logs — if not, you're running a stale
  // cached compiler.js.
  console.log('[compiler.js] fresh-module + flash-LMA filter; v=' +
              (window.CONDUIT_ASSET_VERSION || 'unknown'));

  const COMPILER_ROOT = new URL('./assets/emception/', document.baseURI);
  const SDK_ROOT = new URL('./assets/sdk/', document.baseURI);
  const LLVM_BOX_MJS = new URL('llvm/llvm-box.mjs', COMPILER_ROOT).href;
  const LLVM_BOX_WASM = new URL('llvm/llvm-box.wasm', COMPILER_ROOT).href;

  // Flags matching firmware/build/build.ninja:636 — the exact arm-none-eabi-gcc
  // flags the pre-harvested SDK objects were compiled with. Keep them aligned
  // so user code and SDK objects share float-abi / march, otherwise lld emits
  // ABI-mismatch warnings and the resulting binary can misbehave on VFP calls.
  const CLANG_TARGET_ARGS = [
    '-target', 'thumbv8m.main-none-eabi',
    '-mcpu=cortex-m33',
    '-mthumb',
    '-march=armv8-m.main+fp+dsp',
    '-mfloat-abi=softfp',
    '-Os',
    '-std=c11',
    '-nostdinc',
    '-isystem', '/clang-headers',
    '-isystem', '/pico-sdk/include/libc-stubs',
    '-I', '/pico-sdk/include',
    // Our conduit_user.h exports `log` as a printf-style helper. Clang
    // treats `log` as a math builtin and warns on the signature mismatch.
    // The warning is informational but noisy in the Build log panel.
    '-fno-builtin-log',
  ];

  // Minimal linker script for no-SDK (bare vector table) programs.
  const MINIMAL_LINKER_SCRIPT = `
ENTRY(reset_handler)
MEMORY {
    FLASH (rx)  : ORIGIN = 0x10000000, LENGTH = 2M
    RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 512K
}
PROVIDE(_stack_top = ORIGIN(RAM) + LENGTH(RAM));
SECTIONS {
    .vectors : { KEEP(*(.vectors)) } > FLASH
    .text    : { *(.text .text.*) } > FLASH
    .rodata  : { *(.rodata .rodata.*) } > FLASH
    /DISCARD/ : { *(.ARM.exidx*) *(.ARM.attributes*) *(.note.*) *(.comment*) }
}
`;

  // Paths to mount into the VFS. Each tuple is [urlBase, vfsPath]; all .h / .o
  // files under urlBase get streamed into the VFS at the corresponding vfsPath.
  // (We don't use the tarball approach for the browser — individual fetches
  // get browser-cached and parallelize better than a 10 MB tarball untar.)
  //
  // assetsReady holds the cached *asset bytes* (wasmBinary + file tree Maps).
  // We instantiate a FRESH llvm-box Module for every compile() call, because
  // lld's static globals accumulate input-file state across invocations —
  // so the second call on the same Module sees every object listed twice
  // and emits "duplicate symbol" for everything. Fresh Module per compile
  // ~200-300ms after warmup (see web/tests/fresh_module.mjs).
  let assetsReady = null;
  let LlvmBoxFactory = null;
  let progressCb = null;

  function setProgress(fn) { progressCb = fn; }
  function progress(stage, pct, detail) {
    if (progressCb) progressCb({ stage, pct, detail });
  }

  async function fetchBytes(url, stage) {
    // Append CONDUIT_ASSET_VERSION as a query param so each deploy gets a
    // distinct URL. That alone is enough to bust caches per deploy — we
    // intentionally use the default browser cache (NOT cache: 'no-cache')
    // so within a single deploy, reloads serve from the HTTP cache and
    // skip the network entirely. GitHub Pages emits proper ETag /
    // Last-Modified, so 304s would also be cheap, but with the version
    // query they aren't even needed.
    const v = (typeof window !== 'undefined' && window.CONDUIT_ASSET_VERSION) || 'dev';
    const busted = url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(v);
    const res = await fetch(busted);
    if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') || 0);
    if (!res.body || !total) {
      const buf = await res.arrayBuffer();
      progress(stage, 100, `${buf.byteLength} B`);
      return new Uint8Array(buf);
    }
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      progress(stage, (loaded / total) * 100, `${loaded}/${total} B`);
    }
    const out = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }

  // Very small ustar-format tar reader — walks the archive and yields
  // { path, data }. Skips macOS AppleDouble metadata ("._foo" entries).
  function* walkTar(bytes) {
    const dec = new TextDecoder();
    let off = 0;
    while (off + 512 <= bytes.length) {
      let allZero = true;
      for (let i = 0; i < 512; i++) if (bytes[off + i] !== 0) { allZero = false; break; }
      if (allZero) break;
      let nameEnd = off;
      const nameMax = off + 100;
      while (nameEnd < nameMax && bytes[nameEnd] !== 0) nameEnd++;
      const name = dec.decode(bytes.slice(off, nameEnd)).replace(/^\.\//, '');
      const sizeStr = dec.decode(bytes.slice(off + 124, off + 136)).replace(/\0.*$/, '').trim();
      const size = parseInt(sizeStr, 8) || 0;
      const type = String.fromCharCode(bytes[off + 156] || 0);
      off += 512;
      if ((type === '0' || type === '\0' || type === '') && size > 0) {
        const base = name.split('/').pop() || '';
        if (!base.startsWith('._')) {
          yield { path: name, data: bytes.slice(off, off + size) };
        }
      }
      off += Math.ceil(size / 512) * 512;
    }
  }

  // Fetch a tarball at `tarUrl` and return a Map<relPath, Uint8Array> of
  // its contents. Replaces the prior per-file fetchManifest() approach:
  // one fetch instead of hundreds, smaller wire bytes after gzip, no
  // files.txt manifest needed (the tar header lists everything).
  async function fetchTarMap(tarUrl, stage) {
    const tarBytes = await fetchBytes(tarUrl, stage);
    const map = new Map();
    let count = 0;
    for (const { path, data } of walkTar(tarBytes)) {
      map.set(path, data);
      count++;
    }
    progress(stage, 100, `${count} files unpacked`);
    return map;
  }

  // Bulk-copy a Map<rel, Uint8Array> into a Module's MEMFS rooted at vfsRoot.
  function mountMap(map, vfsRoot, Module) {
    Module.FS.mkdirTree(vfsRoot);
    for (const [rel, data] of map) {
      const vfs = vfsRoot + '/' + rel;
      Module.FS.mkdirTree(vfs.substring(0, vfs.lastIndexOf('/')));
      Module.FS.writeFile(vfs, data);
    }
  }

  // One-time asset fetch. Produces the host-side cache that every compile()
  // bulk-writes into a fresh Module. Each value is a Map<relPath, Uint8Array>
  // except wasmBinary (the Uint8Array of llvm-box.wasm) and startupFiles
  // (a small flat map covering the bs2 startup object + linker scripts).
  async function loadAssets() {
    if (assetsReady) return assetsReady;
    assetsReady = (async () => {
      progress('compiler', 0, 'fetching llvm-box.wasm');
      const wasmBinary = await fetchBytes(LLVM_BOX_WASM, 'compiler');
      progress('compiler', 100, 'loading Emscripten glue');
      LlvmBoxFactory = (await import(LLVM_BOX_MJS)).default;

      progress('clang-headers', 0, 'fetching clang builtin headers');
      const clangHeaders = await fetchTarMap(
        new URL('clang-headers.tar', COMPILER_ROOT).href, 'clang-headers');

      progress('sdk', 0, 'fetching Pico SDK headers');
      const sdkHeaders = await fetchTarMap(
        new URL('headers/include.tar', SDK_ROOT).href, 'sdk');

      const startupFiles = new Map();
      for (const rel of ['startup/bs2_default_padded_checksummed.S.o',
                         'linker/memmap_default.ld',
                         'linker/pico_flash_region.ld']) {
        startupFiles.set(rel, await fetchBytes(new URL(rel, SDK_ROOT).href, 'sdk'));
      }

      progress('sdk-objects', 0, 'unpacking SDK object archive');
      const tarBytes = await fetchBytes(
        new URL('lib/pico-sdk-objects.tar', SDK_ROOT).href, 'sdk-objects');
      const sdkObjects = new Map();
      for (const { path, data } of walkTar(tarBytes)) sdkObjects.set(path, data);
      progress('sdk-objects', 100, `${sdkObjects.size} objects unpacked`);
      // Sanity check the object set actually contains the firmware's main.c.o
      // (added during the Arduino-hooks rework). If it's missing, the browser
      // is almost certainly serving a pre-rework tarball from its HTTP cache.
      if (!sdkObjects.has('main.c.o')) {
        throw new Error(
          `SDK object bundle is missing main.c.o (the firmware's main() ` +
          `with conduit_setup/loop hooks). Got ${sdkObjects.size} objects. ` +
          `Hard-reload the page (Cmd+Shift+R) to bust the browser cache.`);
      }

      // Newlib + libgcc + libnosys archives for the cortex-m33/softfp multilib
      // that arm-none-eabi-gcc compiled the firmware with. Lazy-linked
      // (archive members only pulled in when referenced).
      progress('newlib', 0, 'fetching newlib + libgcc archives');
      const newlib = new Map();
      for (const f of ['libc.a', 'libm.a', 'libnosys.a', 'libgcc.a',
                       'crti.o', 'crtn.o', 'crtbegin.o', 'crtend.o']) {
        newlib.set(f, await fetchBytes(new URL(`lib/newlib/${f}`, SDK_ROOT).href, 'newlib'));
      }

      progress('compiler', 100, 'ready');
      return { wasmBinary, clangHeaders, sdkHeaders, startupFiles, sdkObjects, newlib };
    })().catch((e) => { assetsReady = null; throw e; });
    return assetsReady;
  }

  // Instantiate a fresh Module and bulk-write all cached files into its MEMFS.
  // This runs on every compile() call. Cost: ~100-200ms for wasm instantiate
  // + ~30ms for VFS mounts. See web/tests/fresh_module.mjs for timing data
  // and the reason we can't reuse a single Module across calls (lld state).
  async function freshModule(assets) {
    let stderrBuf = '';
    const Module = await LlvmBoxFactory({
      wasmBinary: assets.wasmBinary,
      noInitialRun: true,
      noExitRuntime: true,
      print: () => {},
      printErr: (s) => { stderrBuf += s + '\n'; },
    });

    mountMap(assets.clangHeaders, '/clang-headers', Module);
    mountMap(assets.sdkHeaders, '/pico-sdk/include', Module);
    for (const [rel, data] of assets.startupFiles) {
      const vfs = '/pico-sdk/' + rel;
      Module.FS.mkdirTree(vfs.substring(0, vfs.lastIndexOf('/')));
      Module.FS.writeFile(vfs, data);
    }
    Module.FS.mkdirTree('/pico-sdk/lib');
    const objPaths = [];
    for (const [rel, data] of assets.sdkObjects) {
      const vfs = '/pico-sdk/lib/' + rel;
      Module.FS.mkdirTree(vfs.substring(0, vfs.lastIndexOf('/')));
      Module.FS.writeFile(vfs, data);
      objPaths.push(vfs);
    }
    mountMap(assets.newlib, '/pico-sdk/lib/newlib', Module);

    // llvm-box strips argv[0] before dispatching to the embedded tool, so
    // we duplicate argv[0]. Mirrors web/tests/wasm_build.mjs.
    function runTool(args) {
      stderrBuf = '';
      const expanded = [args[0], ...args];
      const argc = expanded.length;
      const argv = Module._malloc((argc + 1) * 4);
      const allocs = [argv];
      for (let i = 0; i < argc; i++) {
        const p = Module.allocateUTF8(expanded[i]);
        allocs.push(p);
        Module.HEAPU32[(argv >> 2) + i] = p;
      }
      Module.HEAPU32[(argv >> 2) + argc] = 0;
      let rc = 0;
      try { rc = Module._main(argc, argv); }
      catch (e) {
        if (typeof e === 'number') rc = e;
        else if (e && 'status' in e) rc = e.status;
        else { rc = -1; stderrBuf += `runtime: ${e && e.message || e}\n`; }
      } finally { for (const p of allocs) Module._free(p); }
      return { rc, stderr: stderrBuf };
    }
    return { Module, runTool, objPaths };
  }

  // Compile user source, with SDK linkage. Source is placed at /main.c.
  // Each call instantiates a fresh llvm-box Module — see freshModule() for
  // why. Typical cost after warmup: ~200-300 ms.
  async function compile(source, opts) {
    const { mode = 'sdk' } = opts || {};
    const assets = await loadAssets();
    progress('module', 0, 'instantiating fresh llvm-box');
    const { Module, runTool, objPaths } = await freshModule(assets);
    progress('module', 100, 'ready');
    const FS = Module.FS;

    FS.writeFile('/main.c', source);

    progress('compile', 0, 'clang → /main.o');
    let r = runTool(['clang', ...CLANG_TARGET_ARGS, '-c', '/main.c', '-o', '/main.o']);
    if (r.rc !== 0) {
      throw Object.assign(new Error(`clang failed (rc=${r.rc})`),
        { stage: 'compile', stderr: r.stderr, code: r.rc });
    }
    progress('compile', 100, `/main.o = ${FS.readFile('/main.o').byteLength} B`);

    let linkArgs;
    if (mode === 'sdk') {
      // Link order mirrors the firmware's arm-none-eabi-gcc driver:
      //   crti.o + crtbegin.o              (init/fini frame)
      //   startup boot-stage-2 object
      //   user objs + firmware objs + sdk  (--start-group for cyclic deps)
      //   libc + libnosys + libm + libgcc  (newlib + compiler-rt)
      //   crtend.o + crtn.o                (close init/fini frame)
      //
      // user's strong conduit_setup / conduit_loop symbols override the
      // weak defaults in firmware/app/main.c (linked from main.c.o in
      // objPaths). The firmware's main() drives network/HTTP/OTA; user
      // code just supplements it via the two hooks.
      linkArgs = [
        'lld', '-flavor', 'gnu',
        '-L', '/pico-sdk/linker',
        '-T', '/pico-sdk/linker/memmap_default.ld',
        '--gc-sections',
        '-o', '/app.elf',
        '/pico-sdk/lib/newlib/crti.o',
        '/pico-sdk/lib/newlib/crtbegin.o',
        '/pico-sdk/startup/bs2_default_padded_checksummed.S.o',
        '--start-group',
        '/main.o',
        ...objPaths,
        '/pico-sdk/lib/newlib/libc.a',
        '/pico-sdk/lib/newlib/libnosys.a',
        '/pico-sdk/lib/newlib/libm.a',
        '/pico-sdk/lib/newlib/libgcc.a',
        '--end-group',
        '/pico-sdk/lib/newlib/crtend.o',
        '/pico-sdk/lib/newlib/crtn.o',
      ];
    } else {
      FS.writeFile('/minimal.ld', MINIMAL_LINKER_SCRIPT);
      linkArgs = [
        'lld', '-flavor', 'gnu',
        '-T', '/minimal.ld',
        '-o', '/app.elf',
        '/main.o',
      ];
    }

    progress('link', 0, mode === 'sdk' ? 'lld → /app.elf (+ Pico SDK)' : 'lld → /app.elf');
    r = runTool(linkArgs);
    if (r.rc !== 0) {
      throw Object.assign(new Error(`lld failed (rc=${r.rc})`),
        { stage: 'link', stderr: r.stderr, code: r.rc });
    }

    const elf = new Uint8Array(FS.readFile('/app.elf'));
    progress('link', 100, `/app.elf = ${elf.byteLength} B`);

    // Clean per-compile files (SDK objects + headers persist for reuse).
    try {
      FS.unlink('/main.c'); FS.unlink('/main.o'); FS.unlink('/app.elf');
      if (mode !== 'sdk') FS.unlink('/minimal.ld');
    } catch (_) {}

    return elf;
  }

  function isAvailable() { return assetsReady !== null; }

  window.Conduit = window.Conduit || {};
  window.Conduit.compiler = {
    compile,
    loadAssets,
    isAvailable,
    setProgress,
    flags: CLANG_TARGET_ARGS,
    linkerScript: MINIMAL_LINKER_SCRIPT,
  };
})();
