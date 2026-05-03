// Attempts a real Pico SDK blink build inside the WASM toolchain.
//
// Mounts web/assets/sdk/ into the llvm-box VFS, compiles a blink program
// that #include's pico/stdlib.h + hardware/gpio.h, then links it against the
// pre-harvested SDK .o files + boot-stage-2 + the SDK's memmap_default.ld.
//
// Run from repo root:  node web/tests/sdk_build.mjs
//
// Expected outcome:
//   - If everything lines up, produces a multi-KB ARM ELF and a UF2.
//   - If SDK / clang ABI mismatches (float-abi, march, CMSE, etc.) bite,
//     this test prints the first error so we know what to fix.

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
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

globalThis.require = createRequire(import.meta.url);
globalThis.__dirname = dirname(llvmBoxMjs);
globalThis.__filename = llvmBoxMjs;

for (const f of ['elf.js', 'uf2.js']) {
  const src = await readFile(join(webRoot, f), 'utf8');
  (0, eval)(src);
}

// ---- Boot llvm-box ----
const LlvmBoxFactory = (await import(llvmBoxMjs)).default;
const wasmBinary = await readFile(llvmBoxWasm);
console.log('instantiating llvm-box...');
let stderrBuf = '';
const Module = await LlvmBoxFactory({
  wasmBinary,
  noInitialRun: true,
  noExitRuntime: true,
  print: () => {},
  printErr: (s) => { stderrBuf += s + '\n'; },
});
console.log('  ready');

function runTool(args, { echoErr = false } = {}) {
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
  try {
    rc = Module._main(argc, argv);
  } catch (e) {
    if (typeof e === 'number') rc = e;
    else if (e && 'status' in e) rc = e.status;
    else { rc = -1; stderrBuf += `runtime: ${e && e.message || e}\n`; }
  } finally {
    for (const p of allocs) Module._free(p);
  }
  if (echoErr && stderrBuf) console.error(stderrBuf.trim());
  return { rc, stderr: stderrBuf };
}

// ---- Mount the SDK bundle into MEMFS at /pico-sdk ----
function copyDirIntoFS(hostRoot, vfsRoot) {
  Module.FS.mkdirTree(vfsRoot);
  function walk(host, vfs) {
    for (const name of readdirSync(host)) {
      const hp = join(host, name);
      const vp = vfs + '/' + name;
      const st = statSync(hp);
      if (st.isDirectory()) {
        Module.FS.mkdir(vp);
        walk(hp, vp);
      } else if (st.isFile()) {
        Module.FS.writeFile(vp, new Uint8Array(readFileSync(hp)));
      }
    }
  }
  walk(hostRoot, vfsRoot);
}

console.log('mounting clang builtin headers at /clang-headers ...');
copyDirIntoFS(join(emceptionDir, 'clang-headers'), '/clang-headers');

console.log('mounting SDK bundle at /pico-sdk ...');
Module.FS.mkdirTree('/pico-sdk');
copyDirIntoFS(join(sdkDir, 'headers', 'include'), '/pico-sdk/include');
copyDirIntoFS(join(sdkDir, 'startup'), '/pico-sdk/startup');
copyDirIntoFS(join(sdkDir, 'linker'), '/pico-sdk/linker');

// Unpack the .o tarball into /pico-sdk/lib
const libTar = new Uint8Array(await readFile(join(sdkDir, 'lib', 'pico-sdk-objects.tar')));
Module.FS.mkdirTree('/pico-sdk/lib/tar-stage');
Module.FS.writeFile('/pico-sdk/lib/objects.tar', libTar);
// We don't have tar in llvm-box. Do the untar in Node and write resulting files.
{
  // Minimal POSIX tar reader — enough for the ustar archive from BSD tar.
  const tar = libTar;
  let off = 0;
  const objPaths = [];
  while (off + 512 <= tar.length) {
    // Empty block = end of archive
    let allZero = true;
    for (let i = 0; i < 512; i++) if (tar[off + i] !== 0) { allZero = false; break; }
    if (allZero) break;
    const nameEnd = tar.indexOf(0, off);
    const rawName = new TextDecoder().decode(tar.slice(off, nameEnd >= 0 && nameEnd < off + 100 ? nameEnd : off + 100));
    const name = rawName.replace(/^\.\//, '').replace(/\0.*$/, '');
    // size field is octal starting at offset 124, length 12
    const sizeStr = new TextDecoder().decode(tar.slice(off + 124, off + 136)).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    // typeflag at offset 156
    const type = String.fromCharCode(tar[off + 156] || 0);
    off += 512;
    if ((type === '0' || type === '\0' || type === '') && size > 0) {
      // Skip macOS AppleDouble metadata files that macOS tar sneaks in.
      const basename = name.split('/').pop() || '';
      if (!basename.startsWith('._')) {
        const data = tar.slice(off, off + size);
        const vfs = '/pico-sdk/lib/' + name;
        Module.FS.mkdirTree(vfs.substring(0, vfs.lastIndexOf('/')));
        Module.FS.writeFile(vfs, new Uint8Array(data));
        objPaths.push(vfs);
      }
    }
    off += Math.ceil(size / 512) * 512;
  }
  console.log(`  ${objPaths.length} SDK objects unpacked into /pico-sdk/lib`);
  globalThis.__sdkObjPaths = objPaths;
}

// ---- Write the blink source + compile ----
// Arduino-style hooks — firmware owns main(), we just supplement it.
// Strong user symbols override the firmware's weak defaults.
const BLINK = `
#include "pico/stdlib.h"
#include "hardware/gpio.h"

#define LED_PIN 25

void conduit_setup(void) {
    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);
}

void conduit_loop(void) {
    static uint32_t n = 0;
    if (++n >= 500) {
        n = 0;
        gpio_xor_mask(1u << LED_PIN);
    }
}
`;
Module.FS.writeFile('/main.c', BLINK);

// Flags lifted verbatim from firmware/build.ninja:636 — the exact flags arm-
// none-eabi-gcc compiled the SDK objects with. Keeping them identical
// maximizes ABI compatibility at link time.
const CFLAGS = [
  '-target', 'thumbv8m.main-none-eabi',
  '-mcpu=cortex-m33',
  '-mthumb',
  '-march=armv8-m.main+fp+dsp',
  '-mfloat-abi=softfp',
  '-Os',
  '-std=c11',
  // Use -nostdlibinc (not -nostdinc!) to keep clang's builtin headers
  // available (stdbool.h, stdint.h, stddef.h, ...) while suppressing
  // Emscripten's sysroot libc headers. The SDK's `#include <stdbool.h>`
  // relies on those builtin headers.
  // -nostdlibinc skips stdlib headers while keeping compiler builtins, BUT
  // Emption's clang doesn't ship its builtin headers in the wasm bundle —
  // we stage them at /clang-headers and point -isystem at them explicitly.
  '-nostdinc',
  '-isystem', '/clang-headers',
  '-isystem', '/pico-sdk/include/libc-stubs',   // legacy shim (sys/cdefs.h etc.)
  '-I', '/pico-sdk/include',
];

console.log('\n=== clang -c main.c ===');
let r = runTool(['clang', ...CFLAGS, '-c', '/main.c', '-o', '/main.o']);
if (r.rc !== 0) {
  console.error('clang failed:\n' + r.stderr.split('\n').slice(0, 25).join('\n'));
  process.exit(1);
}
console.log(`  main.o = ${Module.FS.readFile('/main.o').byteLength} B`);

// libc-stubs.c dropped — real newlib is linked instead. See /pico-sdk/lib/newlib/.

// ---- Mount newlib archives ----
const newlibFiles = ['libc.a', 'libm.a', 'libnosys.a', 'libgcc.a',
                     'crti.o', 'crtn.o', 'crtbegin.o', 'crtend.o'];
Module.FS.mkdirTree('/pico-sdk/lib/newlib');
for (const f of newlibFiles) {
  const data = new Uint8Array(await readFile(join(sdkDir, 'lib', 'newlib', f)));
  Module.FS.writeFile(`/pico-sdk/lib/newlib/${f}`, data);
}
console.log(`  mounted ${newlibFiles.length} newlib+libgcc archive + crt objects`);

// ---- Link ----
console.log('\n=== lld link ===');
// Link order mirrors the firmware's arm-none-eabi-gcc driver:
//   crti.o + crtbegin.o              (init/fini frame)
//   user objs + firmware objs + sdk  (--start-group for cyclic deps)
//   libc + libnosys + libm + libgcc  (wrapped in --start-group)
//   crtend.o + crtn.o                (close init/fini frame)
const linkArgs = [
  'lld', '-flavor', 'gnu',
  '-L', '/pico-sdk/linker',
  '-T', '/pico-sdk/linker/memmap_default.ld',
  '-o', '/app.elf',
  '--gc-sections',
  '/pico-sdk/lib/newlib/crti.o',
  '/pico-sdk/lib/newlib/crtbegin.o',
  '/pico-sdk/startup/bs2_default_padded_checksummed.S.o',
  '--start-group',
  '/main.o',
  ...globalThis.__sdkObjPaths,
  '/pico-sdk/lib/newlib/libc.a',
  '/pico-sdk/lib/newlib/libnosys.a',
  '/pico-sdk/lib/newlib/libm.a',
  '/pico-sdk/lib/newlib/libgcc.a',
  '--end-group',
  '/pico-sdk/lib/newlib/crtend.o',
  '/pico-sdk/lib/newlib/crtn.o',
];
r = runTool(linkArgs);
if (r.rc !== 0) {
  console.error('\nlld failed:\n' + r.stderr.split('\n').slice(0, 50).join('\n'));
  process.exit(1);
}
const elf = new Uint8Array(Module.FS.readFile('/app.elf'));
console.log(`  app.elf = ${elf.byteLength} B`);

// ---- UF2 ----
const uf2 = globalThis.Conduit.elfToUf2(elf);
console.log(`\n=== UF2: ${uf2.byteLength} B (${uf2.byteLength / 512} blocks) ===`);
console.log('\nSUCCESS: SDK blink compiled + linked + UF2-converted.');
