// Unit tests for the build-pipeline pure functions: ELF parsing
// (elf.js), UF2 block layout (uf2.js). The hash-block math in
// finalize.js is exercised end-to-end against picotool in
// web/tests/hash_embed.mjs — that's the integration check; here we
// stick to deterministic byte-level invariants.
//
// Strategy: hand-craft a minimal ELF32 with one PT_LOAD segment so we
// don't need a real toolchain to produce fixtures. The synthetic ELF
// has just enough structure that loadableChunks finds the segment.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadModule } from './_load.mjs';

// Load elf.js + uf2.js into the same window — uf2 looks up
// Conduit.elf via the shared root.
const win = loadModule('elf.js');
loadModule('uf2.js', win);
const elfMod = win.Conduit.elf;
const uf2Mod = win.Conduit.uf2;

// ---- Synthetic ELF builder -----------------------------------------

function buildMinimalElf({ paddr = 0x10000000, payload = new Uint8Array([0,1,2,3]) } = {}) {
  const EHSIZE = 52;     // ELF32 header
  const PHENTSIZE = 32;  // program header entry
  const phoff = EHSIZE;
  const dataOff = phoff + PHENTSIZE;
  const total = dataOff + payload.byteLength;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  // ELF identification
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46; // 0x7F 'E' 'L' 'F'
  buf[4] = 1;  // ELFCLASS32
  buf[5] = 1;  // ELFDATA2LSB
  buf[6] = 1;  // EV_CURRENT
  // ehdr
  dv.setUint16(16, 2, true);    // e_type = ET_EXEC
  dv.setUint16(18, 40, true);   // e_machine = EM_ARM
  dv.setUint32(20, 1, true);    // e_version
  dv.setUint32(24, paddr, true);// e_entry
  dv.setUint32(28, phoff, true);// e_phoff
  dv.setUint32(32, 0, true);    // e_shoff
  dv.setUint32(36, 0, true);    // e_flags
  dv.setUint16(40, EHSIZE, true);
  dv.setUint16(42, PHENTSIZE, true);
  dv.setUint16(44, 1, true);    // e_phnum = 1
  dv.setUint16(46, 0, true);
  dv.setUint16(48, 0, true);
  dv.setUint16(50, 0, true);
  // program header (PT_LOAD)
  dv.setUint32(phoff + 0,  1,        true);    // p_type   = PT_LOAD
  dv.setUint32(phoff + 4,  dataOff,  true);    // p_offset
  dv.setUint32(phoff + 8,  paddr,    true);    // p_vaddr
  dv.setUint32(phoff + 12, paddr,    true);    // p_paddr
  dv.setUint32(phoff + 16, payload.length, true);// p_filesz
  dv.setUint32(phoff + 20, payload.length, true);// p_memsz
  dv.setUint32(phoff + 24, 5,        true);    // p_flags = R+X
  dv.setUint32(phoff + 28, 4,        true);    // p_align
  buf.set(payload, dataOff);
  return buf;
}

// ---- elf.js -------------------------------------------------------

test('parseElf: rejects too-small input', () => {
  assert.throws(() => elfMod.parseElf(new Uint8Array(10)), /too small/);
});

test('parseElf: rejects bad magic', () => {
  const buf = new Uint8Array(64);
  assert.throws(() => elfMod.parseElf(buf), /bad magic/);
});

test('parseElf: reads program header offsets correctly', () => {
  const elf = elfMod.parseElf(buildMinimalElf());
  assert.equal(elf.header.e_machine, 40); // EM_ARM
  assert.equal(elf.segments.length, 1);
  assert.equal(elf.segments[0].type, 1); // PT_LOAD
  assert.equal(elf.segments[0].paddr, 0x10000000);
  assert.equal(elf.segments[0].filesz, 4);
});

test('loadableChunks: returns flash-LMA PT_LOADs in address order', () => {
  const elf = elfMod.parseElf(buildMinimalElf({ paddr: 0x10000100 }));
  const chunks = elfMod.loadableChunks(elf);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].paddr, 0x10000100);
  assert.deepEqual(Array.from(chunks[0].data), [0,1,2,3]);
});

test('loadableChunks: filters non-flash LMA (regression: lld .ram_vector_table)', () => {
  // Synthesize an ELF whose PT_LOAD lives in SRAM (0x20000000). This is
  // the lld bug that uf2.js's flash-LMA filter prevents from leaking into
  // the UF2; without the filter, the OTA path rejects the image with
  // OTA_ERR_OVERFLOW.
  const sramElf = buildMinimalElf({ paddr: 0x20000000 });
  const elf = elfMod.parseElf(sramElf);
  const chunks = elfMod.loadableChunks(elf);
  assert.equal(chunks.length, 0, 'SRAM PT_LOAD must be excluded from UF2 emission');
});

// ---- uf2.js -------------------------------------------------------

test('elfToUf2: emits abs block + main blocks in correct order', () => {
  const payload = new Uint8Array(256);
  for (let i = 0; i < 256; i++) payload[i] = i & 0xff;
  const elfBytes = buildMinimalElf({ paddr: 0x10000000, payload });
  const uf2 = uf2Mod.elfToUf2(elfBytes);
  // 1 abs block + 1 main block = 1024 bytes
  assert.equal(uf2.byteLength, 1024);

  const dv = new DataView(uf2.buffer);
  // Abs block: target 0x10ffff00, family 0xe48bff57
  assert.equal(dv.getUint32(0,  true), uf2Mod.constants.UF2_MAGIC_START0);
  assert.equal(dv.getUint32(12, true), 0x10ffff00, 'abs block target');
  assert.equal(dv.getUint32(28, true), 0xe48bff57, 'abs block family ABSOLUTE');
  // Main block: target 0x10000000, family rp2350-arm-s
  assert.equal(dv.getUint32(512 + 12, true), 0x10000000, 'main block target');
  assert.equal(dv.getUint32(512 + 28, true), 0xe48bff59, 'main block family rp2350-arm-s');
  // Block 0 of 2 in abs, then block 0 of 1 in main — picotool's convention
  assert.equal(dv.getUint32(20, true), 0,       'abs blockNo');
  assert.equal(dv.getUint32(24, true), 2,       'abs numBlocks (always 2)');
  assert.equal(dv.getUint32(512 + 20, true), 0, 'main blockNo');
  assert.equal(dv.getUint32(512 + 24, true), 1, 'main numBlocks');
});

test('elfToUf2: omits abs block when includeAbsBlock=false', () => {
  const elfBytes = buildMinimalElf();
  const uf2 = uf2Mod.elfToUf2(elfBytes, { includeAbsBlock: false });
  assert.equal(uf2.byteLength, 512); // single main block
});

test('elfToUf2: every block ends with the UF2 magic_end marker', () => {
  const elfBytes = buildMinimalElf();
  const uf2 = uf2Mod.elfToUf2(elfBytes);
  const dv = new DataView(uf2.buffer);
  for (let off = 0; off < uf2.byteLength; off += 512) {
    assert.equal(dv.getUint32(off + 508, true),
                 uf2Mod.constants.UF2_MAGIC_END,
                 `block at ${off} missing UF2 magic_end`);
  }
});

test('elfToUf2: respects custom familyId', () => {
  const elfBytes = buildMinimalElf();
  const uf2 = uf2Mod.elfToUf2(elfBytes, { familyId: 0xdeadbeef });
  // Abs block keeps its own family; main block reflects the override.
  const dv = new DataView(uf2.buffer);
  assert.equal(dv.getUint32(512 + 28, true), 0xdeadbeef);
});

test('elfToUf2: extraChunks contribute additional pages', () => {
  const elfBytes = buildMinimalElf({ paddr: 0x10000000, payload: new Uint8Array([0xAA]) });
  const extra = { paddr: 0x10001000, data: new Uint8Array(256).fill(0xBB) };
  const uf2 = uf2Mod.elfToUf2(elfBytes, { includeAbsBlock: false, extraChunks: [extra] });
  // Two pages → two main blocks, no abs.
  assert.equal(uf2.byteLength, 2 * 512);
  const dv = new DataView(uf2.buffer);
  // Pages emitted in ascending order
  assert.equal(dv.getUint32(0   + 12, true), 0x10000000);
  assert.equal(dv.getUint32(512 + 12, true), 0x10001000);
});

test('elfToUf2: throws when ELF has no flash-LMA loadable segments', () => {
  const sramElf = buildMinimalElf({ paddr: 0x20000000 });
  assert.throws(() => uf2Mod.elfToUf2(sramElf), /No loadable PT_LOAD/);
});
