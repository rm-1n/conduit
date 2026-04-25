// Unit test: the locally-built Emception runtime at web/assets/emception/
// can cross-compile a minimal C program for Cortex-M33, produce a valid
// ARM ELF, and that ELF round-trips through elf.js + uf2.js into a UF2
// the pico-poe device would accept.
//
// Bypasses web/lib/emception/src/FileSystem.mjs (which is browser-only:
// IDBFS, createLazyFolder, cross-origin fetch). We load the raw Emscripten
// module directly and drive its MEMFS.
//
// Requires:
//   - web/lib/build-toolchain.sh to have been run successfully (produces
//     web/assets/emception/llvm/llvm-box.{mjs,wasm}).
//
// Run from repo root:  node web/tests/wasm_build.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);
const webRoot = join(__dirname_local, '..');
const assetsDir = join(webRoot, 'assets', 'emception');
const llvmBoxMjs = join(assetsDir, 'llvm', 'llvm-box.mjs');
const llvmBoxWasm = join(assetsDir, 'llvm', 'llvm-box.wasm');

// Emscripten 3.1.24's .mjs output uses CJS `require` and `__dirname` when it
// detects a Node environment. Node's ESM loader doesn't provide those in
// scope, so we have to inject globals before importing the module.
globalThis.require = createRequire(import.meta.url);
globalThis.__dirname = dirname(llvmBoxMjs);
globalThis.__filename = llvmBoxMjs;

// ---- Load elf.js + uf2.js into globalThis.PicoPoE ----
for (const f of ['elf.js', 'uf2.js']) {
  const src = await readFile(join(webRoot, f), 'utf8');
  (0, eval)(src);
}

// ---- Load llvm-box Emscripten module ----
console.log(`loading ${llvmBoxMjs}`);
const LlvmBoxFactory = (await import(llvmBoxMjs)).default;

console.log(`reading ${llvmBoxWasm}`);
const wasmBinary = await readFile(llvmBoxWasm);
console.log(`  ${wasmBinary.byteLength} bytes`);

console.log('instantiating llvm-box Emscripten module...');
const t0 = Date.now();
let capturedErr = '';
const Module = await LlvmBoxFactory({
  wasmBinary,
  noInitialRun: true,
  noExitRuntime: true,
  print: () => {},             // suppress clang's stdout chatter
  printErr: (s) => { capturedErr += s + '\n'; },
});
console.log(`  instantiated in ${Date.now() - t0} ms`);

// Helper: invoke llvm-box's main() with the given argv. The llvm-box dispatcher
// (box_src/llvm-box.cpp) strips argv[0] before forwarding to the embedded
// tool's main(), so we duplicate argv[0] — once as the dispatch prefix, once
// as the tool's program name. This matches Emception's BoxProcess.exec layout.
function runTool(args) {
  capturedErr = '';
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
    else {
      rc = -1;
      console.error('runtime error:', e);
    }
  } finally {
    for (const p of allocs) Module._free(p);
  }
  return rc;
}

// ---- TEST 1: clang emits ARM Thumb code ----
console.log('\n=== TEST 1: clang compile C → ARM .o ===');
Module.FS.writeFile('/main.c', `
__attribute__((used))
int user_add(int a, int b) { return a + b; }
`);

let rc = runTool([
  'clang',
  '-target', 'thumbv8m.main-none-eabi',
  '-mcpu=cortex-m33',
  '-mthumb',
  '-c', '/main.c',
  '-o', '/main.o',
]);
if (rc !== 0) {
  console.error('clang stderr:\n' + capturedErr);
  assert.fail(`clang compile returned ${rc}`);
}
const objBytes = new Uint8Array(Module.FS.readFile('/main.o'));
console.log(`  main.o = ${objBytes.byteLength} bytes`);

assert.deepEqual([...objBytes.slice(0, 4)], [0x7f, 0x45, 0x4c, 0x46], 'ELF magic');
assert.equal(objBytes[4], 1, 'ELFCLASS32');
assert.equal(objBytes[5], 1, 'little-endian');
const objDv = new DataView(objBytes.buffer, objBytes.byteOffset, objBytes.byteLength);
const eMachine = objDv.getUint16(18, true);
assert.equal(eMachine, 40 /* EM_ARM */,
  `e_machine = 0x${eMachine.toString(16)}, expected 0x28 (EM_ARM)`);
console.log('  ✓ main.o is ELF32 ARM, little-endian');

// ---- TEST 2: compile + link a bootable ELF with a vector table ----
console.log('\n=== TEST 2: clang compile + lld link → bootable ELF ===');

Module.FS.writeFile('/vectors.c', `
extern char _stack_top[];
void reset_handler(void);

__attribute__((section(".vectors"), used))
void * const vectors[] = {
    (void *)_stack_top,
    (void *)&reset_handler,
};

__attribute__((noreturn))
void reset_handler(void) {
    while (1) { __asm__ volatile ("nop"); }
}
`);

Module.FS.writeFile('/minimal.ld', `
ENTRY(reset_handler)
MEMORY {
    FLASH (rx)  : ORIGIN = 0x10000000, LENGTH = 2M
    RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = 512K
}
PROVIDE(_stack_top = ORIGIN(RAM) + LENGTH(RAM));
SECTIONS {
    .vectors : { KEEP(*(.vectors)) } > FLASH
    .text    : { *(.text .text.*) } > FLASH
    /DISCARD/ : { *(.ARM.exidx*) *(.ARM.attributes*) }
}
`);

// Try compile+link in one clang invocation. If clang's driver can't find
// ld.lld (Emception's setup is emscripten-oriented), fall back to a manual
// lld invocation with -flavor gnu.
rc = runTool([
  'clang',
  '-target', 'thumbv8m.main-none-eabi',
  '-mcpu=cortex-m33',
  '-mthumb',
  '-nostdlib',
  '-fuse-ld=lld',
  '-T', '/minimal.ld',
  '/vectors.c',
  '-o', '/app.elf',
]);

if (rc !== 0) {
  console.log('  clang driver link failed — trying split compile + manual lld');
  console.log(`  (clang stderr snippet: ${capturedErr.split('\n').slice(0, 3).join(' | ')})`);
  const cRc = runTool([
    'clang',
    '-target', 'thumbv8m.main-none-eabi',
    '-mcpu=cortex-m33',
    '-mthumb',
    '-c', '/vectors.c', '-o', '/vectors.o',
  ]);
  assert.equal(cRc, 0, `manual clang compile returned ${cRc}\n${capturedErr}`);
  const lRc = runTool([
    'lld', '-flavor', 'gnu',
    '-T', '/minimal.ld',
    '/vectors.o',
    '-o', '/app.elf',
  ]);
  if (lRc !== 0) {
    console.error('lld stderr:\n' + capturedErr);
    assert.fail(`lld link returned ${lRc}`);
  }
}

const elfBytes = new Uint8Array(Module.FS.readFile('/app.elf'));
console.log(`  app.elf = ${elfBytes.byteLength} bytes`);

// ELF header sanity
assert.deepEqual([...elfBytes.slice(0, 4)], [0x7f, 0x45, 0x4c, 0x46], 'app.elf ELF magic');
const elfDv = new DataView(elfBytes.buffer, elfBytes.byteOffset, elfBytes.byteLength);
assert.equal(elfDv.getUint16(18, true), 40, 'app.elf e_machine = EM_ARM');
const eType = elfDv.getUint16(16, true);
assert(eType === 2 || eType === 3, `app.elf e_type=${eType} (want ET_EXEC=2 or ET_DYN=3)`);
console.log(`  ✓ app.elf is ARM, e_type=${eType}`);

// Parse via elf.js and verify a flash-range PT_LOAD is present
const elf = globalThis.PicoPoE.elf.parseElf(elfBytes);
const chunks = globalThis.PicoPoE.elf.loadableChunks(elf);
assert(chunks.length >= 1, `at least 1 loadable chunk, got ${chunks.length}`);
const first = chunks[0];
assert(first.paddr >= 0x10000000 && first.paddr < 0x20000000,
  `first chunk paddr 0x${first.paddr.toString(16)} should be in FLASH range`);
console.log(`  ✓ ${chunks.length} loadable chunk(s); first at 0x${first.paddr.toString(16)} (${first.data.byteLength} bytes)`);

// ---- TEST 3: ELF → UF2 via uf2.js ----
console.log('\n=== TEST 3: WASM-built ELF → UF2 ===');
const uf2 = globalThis.PicoPoE.elfToUf2(elfBytes);
assert(uf2.byteLength >= 512, 'UF2 is at least 1 block');
assert.equal(uf2.byteLength % 512, 0, 'UF2 is a multiple of 512 bytes');
const blocks = uf2.byteLength / 512;
console.log(`  UF2: ${uf2.byteLength} bytes, ${blocks} blocks`);

function readBlock(idx) {
  const off = idx * 512;
  const d = new DataView(uf2.buffer, uf2.byteOffset + off, 512);
  return {
    magic0:      d.getUint32(0, true),
    magic1:      d.getUint32(4, true),
    flags:       d.getUint32(8, true),
    target:      d.getUint32(12, true),
    payloadSize: d.getUint32(16, true),
    blockNo:     d.getUint32(20, true),
    numBlocks:   d.getUint32(24, true),
    family:      d.getUint32(28, true),
    endMagic:    d.getUint32(508, true),
  };
}

// Block 0 is the RP2350-A2 abs-block (family ABSOLUTE at 0x10FFFF00).
const abs = readBlock(0);
assert.equal(abs.magic0, 0x0a324655, 'abs block magic0');
assert.equal(abs.magic1, 0x9e5d5157, 'abs block magic1');
assert.equal(abs.endMagic, 0x0ab16f30, 'abs block end magic');
assert.equal(abs.target, 0x10ffff00, `abs block target 0x${abs.target.toString(16)}`);
assert.equal(abs.family, 0xe48bff57, `abs block family 0x${abs.family.toString(16)}`);
console.log(`  ✓ block 0: abs-block at 0x10FFFF00 (family ABSOLUTE)`);

// Block 1 is the first main-image block (family RP2350_ARM_S at 0x10000000).
const main0 = readBlock(1);
assert.equal(main0.target, 0x10000000, `main block 0 target 0x${main0.target.toString(16)}`);
assert.equal(main0.family, 0xe48bff59, `main block 0 family 0x${main0.family.toString(16)}`);
assert.equal(main0.blockNo, 0, 'main block 0 blockNo');
assert.equal(main0.numBlocks, blocks - 1, 'numBlocks excludes abs-block');
console.log(`  ✓ block 1: main image at 0x10000000 (family ARM_S), ${main0.numBlocks} blocks`);

// Every main block should be in flash range and contiguous at 256-byte pages.
let prev = main0.target - 256;
for (let i = 1; i < blocks; i++) {
  const b = readBlock(i);
  assert.equal(b.magic0, 0x0a324655, `block ${i} magic0`);
  assert.equal(b.family, 0xe48bff59, `block ${i} family`);
  assert(b.target > prev, `block ${i} target monotonic`);
  assert.equal(b.target % 256, 0, `block ${i} target is page-aligned`);
  prev = b.target;
}
console.log(`  ✓ all ${blocks - 1} main blocks are page-aligned, in ascending flash order`);

console.log('\nALL TESTS PASSED');
