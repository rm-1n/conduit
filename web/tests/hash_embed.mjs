// Tests finalize.js: takes a WASM-built SDK blink ELF, adds a hash IMAGE_DEF
// block, converts to UF2, and shells out to picotool to verify that picotool
// now recognizes the hash as valid.
//
// Run from repo root:  node web/tests/hash_embed.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';

globalThis.crypto ??= webcrypto;

const __dirname_local = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname_local, '..');
const elfPath = '/tmp/sdk-blink-app.elf'; // produced earlier by sdk_build.mjs

// Load elf.js + uf2.js + finalize.js into globalThis.Conduit
for (const f of ['elf.js', 'uf2.js', 'finalize.js']) {
  const src = await readFile(join(webRoot, f), 'utf8');
  (0, eval)(src);
}

console.log(`loading ${elfPath}`);
const elf = new Uint8Array(await readFile(elfPath));
console.log(`  ${elf.byteLength} bytes`);

console.log('\n=== picotool info BEFORE finalize ===');
const before = spawnSync(process.env.HOME + '/.pico-sdk/picotool/2.2.0-a4/picotool/picotool',
  ['info', elfPath], { encoding: 'utf8' });
console.log(before.stdout.split('\n').slice(0, 20).join('\n'));

console.log('\n=== running finalize (TBYB on, version bumped to 99.99) ===');
const meta = await globalThis.Conduit.finalize.finalizeElf(elf, {
  setTbyb: true,
  version: { major: 99, minor: 99 },
});
console.log(`  new block at 0x${meta.newBlockFlashAddr.toString(16)}`);
console.log(`  existing block at 0x${meta.existingBlockFlashAddr.toString(16)}`);
console.log(`  hash = ${Array.from(meta.hash).map(b=>b.toString(16).padStart(2,'0')).join('')}`);
console.log(`  extraChunks: ${meta.extraChunks.length}, patches: ${meta.patches.length}`);

console.log('\n=== producing UF2 with finalize metadata ===');
const uf2 = globalThis.Conduit.elfToUf2(elf, {
  extraChunks: meta.extraChunks,
  patches: meta.patches,
});
console.log(`  UF2: ${uf2.byteLength} bytes, ${uf2.byteLength / 512} blocks`);

await writeFile('/tmp/sdk-blink-hashed.uf2', uf2);
console.log('  wrote /tmp/sdk-blink-hashed.uf2');

console.log('\n=== picotool info ON hashed UF2 ===');
const after = spawnSync(process.env.HOME + '/.pico-sdk/picotool/2.2.0-a4/picotool/picotool',
  ['info', '/tmp/sdk-blink-hashed.uf2', '--all'], { encoding: 'utf8' });
console.log(after.stdout);
if (after.stderr) console.log('STDERR:', after.stderr);

// Key assertions
if (after.stdout.includes('hash:') && after.stdout.includes('verified')) {
  console.log('\n✓ picotool reports hash VERIFIED');
} else if (after.stdout.includes('hash:')) {
  console.log('\n⚠ picotool sees a hash but it did not verify');
  console.log('   (expected if the layout is close but not exact — iterate on finalize.js)');
} else {
  console.log('\n✗ picotool did not see a hash block at all');
}
