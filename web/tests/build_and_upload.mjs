// build_and_upload.mjs — End-to-end regression for the IDE's "Build & Upload"
// button, run headlessly against a live PICO-POE board on the LAN.
//
// What it exercises (mirrors ide.js:onBuildUpload exactly):
//   1. Fresh-module compile of the Arduino-hooks blink template, via the
//      same llvm-box / Pico-SDK / newlib pipeline compiler.js runs in the
//      browser.
//   2. finalize.js (TBYB flag + SHA256 hash + version = device + 1).
//   3. uf2.js (flash-LMA-filtered ELF → UF2, family rp2350-arm-s).
//   4. upload.js — evaluated in a Node shim so the test uses the EXACT code
//      that runs in the browser (chunked POST /api/upload with X-OTA-Start /
//      X-OTA-Finish, waitForDevice, POST /api/commit).
//
// Usage:
//     node web/tests/build_and_upload.mjs [--ip=192.168.178.200]
//                                         [--token=changeme]
//                                         [--subnet=192.168.178]
//                                         [--no-scan]
//
// Environment overrides: PICOPOE_IP, PICOPOE_TOKEN, PICOPOE_SUBNET.
//
// If no IP is given and scanning is enabled, probes the /24 of the host's
// default interface (on macOS/Linux) or the subnet given by --subnet. The
// first host that answers /api/status and reports {"device":"pico-poe"}
// is the target.
//
// Success criteria (all must hold):
//   - UF2 produced; all ARM-S block targets land inside the target partition
//     after OTA addr translation (guard against the "data exceeds partition
//     size" regression).
//   - Upload completes all chunks without a protocol error.
//   - Device comes back within 60 s and returns /api/status.
//   - post.partition differs from pre.partition (A↔B flip) — the strongest
//     signal that the ROM actually booted our new image. /api/status.version
//     is the compile-time PICO_POE_VERSION_STRING, so it does NOT change
//     across uploads of the same firmware tree; we can't use it as a signal.
//   - post.tbyb_pending was true immediately after reboot and becomes false
//     after POST /api/commit.
//   - A second /api/status 2 s later still works (device is stable).

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const webRoot = join(__dirname_local, '..');
const assetsDir = join(webRoot, 'assets');
const emceptionDir = join(assetsDir, 'emception');
const sdkDir = join(assetsDir, 'sdk');
const llvmBoxMjs = join(emceptionDir, 'llvm', 'llvm-box.mjs');
const llvmBoxWasm = join(emceptionDir, 'llvm', 'llvm-box.wasm');

// ---------- CLI + env parsing ----------
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const IP = args.ip || process.env.PICOPOE_IP || null;
const TOKEN = args.token || process.env.PICOPOE_TOKEN || 'changeme';
const SUBNET = args.subnet || process.env.PICOPOE_SUBNET || '192.168.178';
const NO_SCAN = args['no-scan'] === true;

// ---------- Load browser JS into a DOM-shimmed globalThis ----------
// web/upload.js attaches to `window.PicoPoE`; map window → globalThis so we
// get the same exported functions as the browser build.
globalThis.window = globalThis;

// Node's fetch can't reach LAN-local hosts on macOS (Local Network privacy)
// and inside Claude Code's sandbox; curl works. Install a curl-backed
// fetch shim as globalThis.fetch before loading upload.js so upload.js's
// bare fetch() calls go through curl transparently.
const { installAsGlobalFetch } = await import('./_curl_fetch.mjs');
installAsGlobalFetch();

for (const f of ['elf.js', 'uf2.js', 'finalize.js', 'upload.js']) {
  const src = await readFile(join(webRoot, f), 'utf8');
  (0, eval)(src);
}
const { elfToUf2, finalize, uploadFirmware, getStatus, waitForDevice,
        commitFirmware, updateFirmware } = globalThis.PicoPoE;

// ---------- Boot llvm-box (for compile + link) ----------
globalThis.require = createRequire(import.meta.url);
globalThis.__dirname = dirname(llvmBoxMjs);
globalThis.__filename = llvmBoxMjs;

const wasmBinary = new Uint8Array(await readFile(llvmBoxWasm));
const LlvmBoxFactory = (await import(llvmBoxMjs)).default;

let stderrBuf = '';
console.log('→ instantiating llvm-box...');
const Module = await LlvmBoxFactory({
  wasmBinary, noInitialRun: true, noExitRuntime: true,
  print: () => {},
  printErr: (s) => { stderrBuf += s + '\n'; },
});
console.log('  ready');

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

function copyDirIntoFS(hostRoot, vfsRoot) {
  Module.FS.mkdirTree(vfsRoot);
  function walk(host, vfs) {
    for (const name of readdirSync(host)) {
      const hp = join(host, name);
      const vp = vfs + '/' + name;
      const st = statSync(hp);
      if (st.isDirectory()) { Module.FS.mkdir(vp); walk(hp, vp); }
      else if (st.isFile()) Module.FS.writeFile(vp, new Uint8Array(readFileSync(hp)));
    }
  }
  walk(hostRoot, vfsRoot);
}

console.log('→ mounting clang/sdk/newlib into VFS...');
copyDirIntoFS(join(emceptionDir, 'clang-headers'), '/clang-headers');
copyDirIntoFS(join(sdkDir, 'headers', 'include'), '/pico-sdk/include');
copyDirIntoFS(join(sdkDir, 'startup'), '/pico-sdk/startup');
copyDirIntoFS(join(sdkDir, 'linker'), '/pico-sdk/linker');

// Unpack the SDK objects tarball (the 119-object firmware bundle).
const libTar = new Uint8Array(await readFile(join(sdkDir, 'lib', 'pico-sdk-objects.tar')));
Module.FS.mkdirTree('/pico-sdk/lib');
const objPaths = [];
{
  let off = 0;
  while (off + 512 <= libTar.length) {
    let allZero = true;
    for (let i = 0; i < 512; i++) if (libTar[off + i] !== 0) { allZero = false; break; }
    if (allZero) break;
    const ne = libTar.indexOf(0, off);
    const rn = new TextDecoder().decode(libTar.slice(off, ne >= 0 && ne < off + 100 ? ne : off + 100));
    const name = rn.replace(/^\.\//, '').replace(/\0.*$/, '');
    const sz = parseInt(new TextDecoder().decode(libTar.slice(off + 124, off + 136)).replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(libTar[off + 156] || 0);
    off += 512;
    if ((type === '0' || type === '\0' || type === '') && sz > 0) {
      const bn = name.split('/').pop() || '';
      if (!bn.startsWith('._')) {
        const vfs = '/pico-sdk/lib/' + name;
        Module.FS.mkdirTree(vfs.substring(0, vfs.lastIndexOf('/')));
        Module.FS.writeFile(vfs, new Uint8Array(libTar.slice(off, off + sz)));
        objPaths.push(vfs);
      }
    }
    off += Math.ceil(sz / 512) * 512;
  }
}
assert(objPaths.includes('/pico-sdk/lib/main.c.o'),
  'main.c.o missing from SDK bundle — re-harvest the tarball');

for (const f of ['libc.a', 'libm.a', 'libnosys.a', 'libgcc.a',
                 'crti.o', 'crtn.o', 'crtbegin.o', 'crtend.o']) {
  Module.FS.mkdirTree('/pico-sdk/lib/newlib');
  Module.FS.writeFile(`/pico-sdk/lib/newlib/${f}`,
    new Uint8Array(await readFile(join(sdkDir, 'lib', 'newlib', f))));
}

// ---------- User source (same template ide.js pre-fills in Monaco) ----------
const BLINK_SOURCE = `
#include "pico/stdlib.h"
#include "hardware/gpio.h"
#include "pico_poe_user.h"

#define LED_PIN 25

void pico_poe_setup(void) {
    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);
    log("hello from pico_poe_setup()\\n");
}

void pico_poe_loop(void) {
    static uint32_t n = 0;
    if (++n >= 500) {
        n = 0;
        gpio_xor_mask(1u << LED_PIN);
    }
}
`;

Module.FS.writeFile('/main.c', BLINK_SOURCE);

const CFLAGS = [
  '-target', 'thumbv8m.main-none-eabi',
  '-mcpu=cortex-m33', '-mthumb',
  '-march=armv8-m.main+fp+dsp',
  '-mfloat-abi=softfp',
  '-Os', '-std=c11',
  '-nostdinc',
  '-isystem', '/clang-headers',
  '-isystem', '/pico-sdk/include/libc-stubs',
  '-I', '/pico-sdk/include',
  '-fno-builtin-log',
];

console.log('→ clang -c main.c');
let r = runTool(['clang', ...CFLAGS, '-c', '/main.c', '-o', '/main.o']);
if (r.rc !== 0) {
  console.error('clang failed:\n' + r.stderr.split('\n').slice(0, 30).join('\n'));
  process.exit(1);
}

console.log('→ lld → /app.elf');
r = runTool([
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
]);
if (r.rc !== 0) {
  console.error('lld failed:\n' + r.stderr.split('\n').slice(0, 30).join('\n'));
  process.exit(1);
}
const elfBytes = new Uint8Array(Module.FS.readFile('/app.elf'));
console.log(`  app.elf = ${elfBytes.byteLength} B`);

// ---------- Device discovery ----------
async function probe(ip, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://${ip}/api/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body && body.device === 'pico-poe') return { ip, status: body };
  } catch (_) {}
  return null;
}

async function scanSubnet(subnet, concurrency = 24) {
  const ips = [];
  for (let i = 1; i <= 254; i++) ips.push(`${subnet}.${i}`);
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < ips.length) {
      const ip = ips[cursor++];
      const hit = await probe(ip);
      if (hit) results.push(hit);
    }
  }
  const workers = [];
  for (let k = 0; k < concurrency; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

let targetIp = IP;
if (!targetIp) {
  if (NO_SCAN) {
    console.error('no --ip given and --no-scan set'); process.exit(1);
  }
  console.log(`→ scanning ${SUBNET}.0/24 for pico-poe devices...`);
  const hits = await scanSubnet(SUBNET);
  if (hits.length === 0) {
    console.error(`  no pico-poe device found on ${SUBNET}.0/24`);
    process.exit(1);
  }
  if (hits.length > 1) {
    console.log(`  found ${hits.length} devices: ${hits.map((h) => h.ip).join(', ')}; using first`);
  }
  targetIp = hits[0].ip;
}
console.log(`  target: ${targetIp}`);

// ---------- Precheck ----------
console.log('→ GET /api/status (precheck)');
const pre = await getStatus(targetIp);
console.log(`  pre: v${pre.version} partition=${pre.partition} tbyb_pending=${pre.tbyb_pending}`);
assert(['A', 'B'].includes(pre.partition),
  `device partition is "${pre.partition}" — reflash via BOOTSEL before running this test`);

// If a previous upload is sitting on TBYB probation, commit it so the partition
// we're about to overwrite is the OTHER one. Without this, the firmware may
// still elect our new partition but rollback on the next cold boot.
if (pre.tbyb_pending) {
  console.log('  pre: TBYB-pending from a prior run — committing first');
  const c = await commitFirmware(targetIp, TOKEN);
  console.log(`  pre-commit: committed=${c.committed} version=${c.version}`);
}

// Stamp a high, monotonically-increasing binary version. We use seconds-
// since-epoch (mod 65536) for the minor so consecutive test runs don't tie
// on version — TBYB + flash_update is only "preferential, not mandatory",
// so a tied version lets ROM keep the already-committed partition.
// Mirrors ide.js's nextStampedVersion().
const stampVer = {
  major: 0x7fff,
  minor: Math.floor(Date.now() / 1000) & 0xffff,
};
console.log(`  will stamp binary version {${stampVer.major}, ${stampVer.minor}} ` +
            `(pre /api/status.version = "${pre.version}" — compile-time constant)`);

// ---------- finalize + UF2 ----------
console.log('→ finalize (TBYB + version + hash) → UF2');
const meta = await finalize.finalizeElf(elfBytes, {
  setTbyb: true,
  version: stampVer,
});
const uf2 = elfToUf2(elfBytes, {
  extraChunks: meta.extraChunks || [],
  patches: meta.patches || [],
});
console.log(`  UF2 = ${uf2.byteLength} B (${uf2.byteLength / 512} blocks)`);
if (meta.hash) {
  const hex = Array.from(meta.hash, (b) => b.toString(16).padStart(2, '0')).join('');
  console.log(`  hash = ${hex.slice(0, 16)}...`);
}

// ---------- partition-bounds sanity (guards the ".ram_vector_table" regression) ----------
{
  const XIP_BASE = 0x10000000;
  const PART_A_START = 0x10000, PART_A_SIZE = 1984 * 1024;
  const dv = new DataView(uf2.buffer, uf2.byteOffset, uf2.byteLength);
  let firstARMS = null, minT = 0xffffffff, maxT = 0;
  for (let i = 0; i < uf2.byteLength / 512; i++) {
    const flags = dv.getUint32(i * 512 + 8, true);
    const tgt = dv.getUint32(i * 512 + 12, true);
    const psz = dv.getUint32(i * 512 + 16, true);
    const fam = dv.getUint32(i * 512 + 28, true);
    const isAbs = (flags & 0x2000) && fam === 0xe48bff57;
    if (isAbs || fam !== 0xe48bff59) continue;
    if (firstARMS === null) firstARMS = tgt;
    if (tgt < minT) minT = tgt;
    if (tgt + psz > maxT) maxT = tgt + psz;
  }
  const addrDelta = (XIP_BASE + PART_A_START) - firstARMS;
  const flashMin = minT + addrDelta - XIP_BASE;
  const flashMax = maxT + addrDelta - XIP_BASE;
  console.log(`  translated flash range: 0x${flashMin.toString(16)}..0x${flashMax.toString(16)} ` +
              `(partition A: 0x${PART_A_START.toString(16)}..0x${(PART_A_START + PART_A_SIZE).toString(16)})`);
  assert(flashMin >= PART_A_START && flashMax <= PART_A_START + PART_A_SIZE,
    'UF2 would overflow partition A — flash-LMA filter in elf.js must be active');
}

// ---------- Upload via upload.js's updateFirmware ----------
console.log('→ updateFirmware (chunked upload + wait + commit)');
const result = await updateFirmware({
  ip: targetIp,
  token: TOKEN,
  data: uf2,
  onStage: (stage, detail) => {
    if (typeof detail === 'object' && detail) {
      console.log(`  [${stage}] v${detail.version} partition=${detail.partition} tbyb=${detail.tbyb_pending}`);
    } else {
      console.log(`  [${stage}]${detail ? ' ' + detail : ''}`);
    }
  },
  onProgress: (() => {
    let lastPct = -1;
    return ({ pct, loaded, total }) => {
      const rounded = Math.round(pct / 10) * 10;
      if (rounded !== lastPct) {
        lastPct = rounded;
        process.stdout.write(`    ${rounded}% (${loaded}/${total} B)\r`);
        if (rounded === 100) process.stdout.write('\n');
      }
    };
  })(),
});

// ---------- Assertions ----------
console.log(`\n→ outcome: ${result.outcome}`);
if (result.outcome === 'error') {
  console.error('  error:', result.error && (result.error.message || result.error));
  process.exit(1);
}
if (result.outcome === 'unreachable') {
  console.error('  device never returned after upload — check serial console / power-cycle');
  process.exit(1);
}
if (result.outcome === 'rollback') {
  console.error('  device rolled back / never rebooted.');
  console.error(`  pre  uptime=${result.pre.uptime}, post uptime=${result.post.uptime}`);
  if (result.post.uptime >= result.pre.uptime) {
    console.error('  → post uptime is NOT lower than pre, so the device never rebooted at all.');
    console.error('    Either ota_finish rejected the last chunk (check ota_bytes_written) or');
    console.error('    the subsequent rom_reboot(FLASH_UPDATE) returned without actually rebooting.');
    console.error(`    ota_bytes_written: pre=${result.pre.ota_bytes_written} post=${result.post.ota_bytes_written}`);
  } else {
    console.error('  → uptime reset — reboot happened but ROM rolled back to pre-partition (hash/TBYB check failed?).');
  }
  process.exit(1);
}

const { pre: resPre, post } = result;
assert.equal(post.device, 'pico-poe', 'post-upload status.device mismatch');
assert.notEqual(post.partition, resPre.partition,
  `partition should have flipped (pre=${resPre.partition} post=${post.partition}) — ` +
  `if unchanged, the ROM rolled back or the flash-update reboot never happened`);
assert(['A', 'B'].includes(post.partition), `post.partition invalid: ${post.partition}`);

if (result.outcome === 'committed') {
  assert(result.commit && result.commit.committed !== false,
    `commit did not succeed: ${JSON.stringify(result.commit)}`);
  console.log(`  ✓ committed v${post.version} on partition ${post.partition}`);
} else if (result.outcome === 'rebooted') {
  console.log(`  ✓ rebooted onto v${post.version} (no TBYB — was not flagged)`);
}

// ---------- Post-commit stability: device still answers 2 s later ----------
await new Promise((r) => setTimeout(r, 2000));
const final = await getStatus(targetIp);
assert.equal(final.version, post.version, 'version changed after commit — instability');
assert.equal(final.tbyb_pending, false, 'tbyb_pending still true after commit');
console.log(`  ✓ stable 2s later: v${final.version} partition=${final.partition} tbyb_pending=${final.tbyb_pending}`);

console.log('\nPASS: Build & Upload round-trip succeeded end-to-end.');
