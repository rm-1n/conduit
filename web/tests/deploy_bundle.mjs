#!/usr/bin/env node
// deploy_bundle.mjs — verify every asset compiler.js fetches at first
// Build is present in the staged bundle, by hosting `web/` over HTTP
// (mimicking GitHub Pages) and probing each URL.
//
// Catches the exact regression the live site hit at conduit.rm1n.com:
// build-web-sdk.yml drifted from build-sdk-bundle.sh and silently
// shipped a release missing pico-sdk-objects.tar. The IDE then 404'd
// at first Build click. Asserting the URL list at the bundle level
// (not just at the compile level — that's sdk_build.mjs's job) makes
// the regression cheap to detect.
//
// What this DOES NOT catch:
//   - Wrong bundle contents (e.g. an .o compiled with bad flags) —
//     run sdk_build.mjs, which actually links + UF2-converts.
//   - JS-side bugs in compiler.js's loader logic — not exercised here.
//   - Bandwidth ceilings, MIME-type quirks, gzip/br handling on the
//     real Pages CDN — those need a deployed-site smoke test.
//
// Usage:
//   cd web/tests && node deploy_bundle.mjs
//
//   # Or point the HTTP root at a pre-staged directory (e.g. CI's
//   # web-sdk-stage/, with emception merged in alongside).
//   WEB_ROOT=/tmp/staged node deploy_bundle.mjs
//
// Pre-requisite for the default mode: firmware/build/ exists with
// CMakeFiles/conduit_app.dir/ populated. Run `conduit build` first.

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE       = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(HERE, '..', '..');
const WEB_ROOT   = process.env.WEB_ROOT
                   ? resolve(process.env.WEB_ROOT)
                   : resolve(REPO_ROOT, 'web');
const FW_DIR_OBJ = resolve(REPO_ROOT, 'firmware/build/app/CMakeFiles/conduit_app.dir');

// ---- 1. Stage the bundle if running against the live web/ tree -----
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

if (!process.env.WEB_ROOT) {
  if (!await exists(FW_DIR_OBJ)) {
    console.error('error: firmware/build/app/CMakeFiles/conduit_app.dir/ missing.');
    console.error('       Run `conduit build` (or `cmake -S firmware -B firmware/build && cmake --build firmware/build`) first.');
    process.exit(2);
  }
  console.log('staging SDK bundle via build-sdk-bundle.sh ...');
  const stage = spawnSync('bash', [resolve(REPO_ROOT, 'web/lib/build-sdk-bundle.sh')], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (stage.status !== 0) {
    process.stderr.write(stage.stderr || '');
    process.stdout.write(stage.stdout || '');
    console.error('build-sdk-bundle.sh failed');
    process.exit(1);
  }
}

// ---- 2. URL list (mirrors compiler.js's loadAssets() flow) ---------
// If compiler.js's URL list changes, update this array — drift here
// is the whole point of the test, the same way deploy-pages.yml's
// sanity-check guards CI.
const URLS = [
  // emception (clang+lld in WASM)
  '/assets/emception/llvm/llvm-box.mjs',
  '/assets/emception/llvm/llvm-box.wasm',
  '/assets/emception/clang-headers.tar',
  // sdk root: bundled headers + framework objects + linker scripts
  '/assets/sdk/headers/include.tar',
  '/assets/sdk/lib/pico-sdk-objects.tar',
  '/assets/sdk/startup/bs2_default_padded_checksummed.S.o',
  '/assets/sdk/linker/memmap_default.ld',
  '/assets/sdk/linker/pico_flash_region.ld',
  // newlib + libgcc multilib (cortex-m33 +fp+dsp / softfp)
  '/assets/sdk/lib/newlib/libc.a',
  '/assets/sdk/lib/newlib/libm.a',
  '/assets/sdk/lib/newlib/libnosys.a',
  '/assets/sdk/lib/newlib/libgcc.a',
  '/assets/sdk/lib/newlib/crti.o',
  '/assets/sdk/lib/newlib/crtn.o',
  '/assets/sdk/lib/newlib/crtbegin.o',
  '/assets/sdk/lib/newlib/crtend.o',
];

// ---- 3. Spin up HTTP server with WEB_ROOT as docroot ---------------
const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '').split('?')[0]);
  const filePath = resolve(WEB_ROOT, '.' + url);
  // Path-traversal guard. WEB_ROOT MUST be the prefix of any served file.
  if (!filePath.startsWith(WEB_ROOT)) {
    res.statusCode = 403; res.end(); return;
  }
  try {
    const st = await stat(filePath);
    if (!st.isFile()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Length', String(st.size));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.statusCode = 200;
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(await readFile(filePath));
  } catch {
    res.statusCode = 404; res.end();
  }
});
const port = await new Promise((r) =>
  server.listen(0, '127.0.0.1', () => r(server.address().port))
);
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`hosting ${WEB_ROOT} at ${baseUrl}\n`);

// ---- 4. Probe each URL ---------------------------------------------
let failed = 0;
for (const url of URLS) {
  const r = await fetch(`${baseUrl}${url}`, { method: 'HEAD' });
  const len = Number(r.headers.get('content-length') || 0);
  if (r.status !== 200) {
    console.error(`FAIL  ${url}  →  HTTP ${r.status}`);
    failed++;
  } else if (!len) {
    console.error(`FAIL  ${url}  →  HTTP 200 but empty`);
    failed++;
  } else {
    console.log(`ok    ${url.padEnd(60)}  ${(len / 1024).toFixed(0)} KB`);
  }
}

// ---- 5. Tarball contents spot-check ---------------------------------
// A 0-byte or truncated tarball passes the HEAD-status check above
// but breaks the in-browser walkTar() with cryptic errors. Open each
// of the three tarballs and confirm a file we know must be present.
async function tarContains(url, regex) {
  const r = await fetch(`${baseUrl}${url}`);
  if (!r.ok) return false;
  const bytes = new Uint8Array(await r.arrayBuffer());
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= bytes.length) {
    let allZero = true;
    for (let i = 0; i < 512 && allZero; i++) if (bytes[off + i] !== 0) allZero = false;
    if (allZero) break;
    let nameEnd = off;
    while (nameEnd < off + 100 && bytes[nameEnd] !== 0) nameEnd++;
    const name = dec.decode(bytes.slice(off, nameEnd)).replace(/^\.\//, '');
    const sizeStr = dec.decode(bytes.slice(off + 124, off + 136)).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    if (regex.test(name)) return true;
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return false;
}

const TAR_CHECKS = [
  // pico-sdk-objects.tar — full conduit_app object set. discovery.c.o
  // and friends MUST be present so user main.c uploaded via Build &
  // Upload preserves network + OTA + telemetry + discovery.
  ['/assets/sdk/lib/pico-sdk-objects.tar', /(^|\/)main\.c\.o$/],
  ['/assets/sdk/lib/pico-sdk-objects.tar', /(^|\/)discovery\.c\.o$/],
  ['/assets/sdk/lib/pico-sdk-objects.tar', /(^|\/)network\.c\.o$/],
  ['/assets/sdk/lib/pico-sdk-objects.tar', /(^|\/)http_server\.c\.o$/],
  ['/assets/sdk/lib/pico-sdk-objects.tar', /(^|\/)ota\.c\.o$/],
  // include.tar — flattened SDK + firmware/include + libc-stubs.
  ['/assets/sdk/headers/include.tar', /(^|\/)pico\/stdlib\.h$/],
  ['/assets/sdk/headers/include.tar', /(^|\/)conduit_user\.h$/],
  // clang-headers.tar — clang builtin intrinsics tree.
  ['/assets/emception/clang-headers.tar', /^stdarg\.h$/],
];

console.log('\nValidating tarball contents:');
for (const [url, regex] of TAR_CHECKS) {
  const ok = await tarContains(url, regex);
  if (!ok) {
    console.error(`FAIL  ${url}  →  no entry matching ${regex}`);
    failed++;
  } else {
    console.log(`ok    ${url}  contains  ${regex}`);
  }
}

server.close();

if (failed > 0) {
  console.error(`\n${failed} check(s) failed — deployed Pages would 404 or fail to compile.`);
  process.exit(1);
}
console.log(`\nALL ${URLS.length} ASSETS + ${TAR_CHECKS.length} TAR CHECKS OK — deploy would succeed.`);
