// Byte-diff test: feed the CMake-built conduit_app.elf through the JS UF2
// pipeline (elf.js + uf2.js) and compare against the CMake-built
// conduit_app.uf2 produced by picotool. Must match exactly — Phase A
// acceptance criterion.
//
// Run from repo root:  node web/tests/roundtrip.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, '..');
const repoRoot = join(__dirname, '..', '..');

// Load the browser modules into global scope. Each file is an IIFE that
// attaches to globalThis.Conduit in non-window environments.
for (const f of ['elf.js', 'uf2.js']) {
  const src = await readFile(join(webRoot, f), 'utf8');
  (0, eval)(src);
}

const elfPath = join(repoRoot, 'firmware/build/app/conduit_app.elf');
const uf2Path = join(repoRoot, 'firmware/build/app/conduit_app.uf2');

const elfBytes = new Uint8Array(await readFile(elfPath));
const expectedUf2 = new Uint8Array(await readFile(uf2Path));

const actualUf2 = globalThis.Conduit.elfToUf2(elfBytes);

console.log(`ELF:       ${elfBytes.byteLength} bytes  (${elfPath.replace(repoRoot, '.')})`);
console.log(`expected:  ${expectedUf2.byteLength} bytes  (${expectedUf2.byteLength / 512} blocks)`);
console.log(`actual:    ${actualUf2.byteLength} bytes  (${actualUf2.byteLength / 512} blocks)`);

if (actualUf2.byteLength !== expectedUf2.byteLength) {
  console.error(`\nFAIL: size mismatch (${actualUf2.byteLength} vs ${expectedUf2.byteLength})`);
  process.exit(1);
}

let firstDiff = -1;
for (let i = 0; i < actualUf2.byteLength; i++) {
  if (actualUf2[i] !== expectedUf2[i]) { firstDiff = i; break; }
}

if (firstDiff === -1) {
  console.log(`\nPASS: byte-identical to picotool output`);
  process.exit(0);
}

const blockIdx = Math.floor(firstDiff / 512);
const offInBlock = firstDiff % 512;
console.error(`\nFAIL: diff at byte ${firstDiff} (block ${blockIdx}, offset ${offInBlock})`);

const hex = (arr) =>
  Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join(' ');

const blockStart = blockIdx * 512;
console.error(`  expected first 32 bytes of block ${blockIdx}:`);
console.error(`    ${hex(expectedUf2.slice(blockStart, blockStart + 32))}`);
console.error(`  actual first 32 bytes of block ${blockIdx}:`);
console.error(`    ${hex(actualUf2.slice(blockStart, blockStart + 32))}`);

// Count how many blocks differ in total, to gauge the scope.
let differingBlocks = 0;
for (let b = 0; b < expectedUf2.byteLength / 512; b++) {
  const off = b * 512;
  for (let i = 0; i < 512; i++) {
    if (actualUf2[off + i] !== expectedUf2[off + i]) { differingBlocks++; break; }
  }
}
console.error(`  ${differingBlocks} of ${expectedUf2.byteLength / 512} blocks differ`);
process.exit(1);
