// uf2.js — ELF → UF2 converter for RP2350 flash images.
// Emits a byte sequence matching picotool's elf2uf2 output for the same ELF:
// 256-byte payloads, family-id-present flag, one block per touched page,
// blocks in ascending flash-address order.
//
// Depends on: elf.js (window.PicoPoE.elf)

(function (root) {
  'use strict';

  const UF2_MAGIC_START0 = 0x0a324655; // "UF2\n"
  const UF2_MAGIC_START1 = 0x9e5d5157;
  const UF2_MAGIC_END    = 0x0ab16f30;

  const UF2_FLAG_NOT_MAIN_FLASH           = 0x00000001;
  const UF2_FLAG_FILE_CONTAINER           = 0x00001000;
  const UF2_FLAG_FAMILY_ID_PRESENT        = 0x00002000;
  const UF2_FLAG_MD5_PRESENT              = 0x00004000;
  const UF2_FLAG_EXTENSION_FLAGS_PRESENT  = 0x00008000;

  // Extension flag written in data[] after the payload; tells the bootrom
  // mass-storage path to skip this block when dragging & dropping a UF2.
  // Defined in ~/.pico-sdk/.../boot/uf2.h:46.
  const UF2_EXTENSION_RP2_IGNORE_BLOCK = 0x9957e304;

  const PAGE_SIZE = 256;

  // family id defaults to rp2350-arm-s per firmware/include/pico_poe_config.h:68
  const FAMILY_ID_RP2350        = 0xe48bff57;
  const FAMILY_ID_RP2350_ARM_S  = 0xe48bff59;
  const DEFAULT_FAMILY_ID = FAMILY_ID_RP2350_ARM_S;

  // RP2350 A2 "absolute block": the SDK's pico_add_uf2_output CMake function
  // passes `--abs-block` to picotool on PICO_RP2350_A2_SUPPORTED builds
  // (tools/CMakeLists.txt:595-599). picotool prepends a single UF2 block at
  // flash-top (0x10FFFF00) with family ABSOLUTE (0xe48bff57), flags
  // FAMILY_ID_PRESENT | EXTENSION_FLAGS_PRESENT, numBlocks=2, and 256 bytes
  // of 0xEF payload followed by UF2_EXTENSION_RP2_IGNORE_BLOCK in data[].
  const ABS_FAMILY_ID     = 0xe48bff57;
  const ABS_BLOCK_TARGET  = 0x10ffff00;
  const ABS_BLOCK_FLAGS   = UF2_FLAG_FAMILY_ID_PRESENT | UF2_FLAG_EXTENSION_FLAGS_PRESENT;
  const ABS_BLOCK_NUMBLKS = 2;
  const ABS_BLOCK_FILL    = 0xef;

  function writeBlock(out, off, flags, target, payloadSize, blockNo, numBlocks, family, payload) {
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    dv.setUint32(off + 0,  UF2_MAGIC_START0, true);
    dv.setUint32(off + 4,  UF2_MAGIC_START1, true);
    dv.setUint32(off + 8,  flags >>> 0, true);
    dv.setUint32(off + 12, target >>> 0, true);
    dv.setUint32(off + 16, payloadSize >>> 0, true);
    dv.setUint32(off + 20, blockNo >>> 0, true);
    dv.setUint32(off + 24, numBlocks >>> 0, true);
    dv.setUint32(off + 28, family >>> 0, true);
    out.set(payload, off + 32);
    dv.setUint32(off + 508, UF2_MAGIC_END, true);
  }

  // elfToUf2(elfBytes, { familyId?, includeAbsBlock?, extraChunks?, patches? })
  //   -> Uint8Array of packed 512-byte UF2 blocks.
  //
  // extraChunks: additional { paddr, data } entries to emit as UF2 blocks
  //   (e.g. a hash IMAGE_DEF block produced by finalize.js).
  // patches: overwrite arbitrary bytes at an absolute flash address AFTER
  //   the ELF bytes have been bucketed but BEFORE the UF2 is serialized.
  //   Used by finalize.js to patch the existing block's next_block_rel.
  function elfToUf2(elfBytes, opts) {
    const options = opts || {};
    const familyId = options.familyId != null ? options.familyId : DEFAULT_FAMILY_ID;
    const includeAbs = options.includeAbsBlock !== false;

    const elf = root.PicoPoE.elf.parseElf(elfBytes);
    const chunks = root.PicoPoE.elf.loadableChunks(elf);
    if (chunks.length === 0) throw new Error('No loadable PT_LOAD segments in ELF');

    const extraChunks = Array.isArray(options.extraChunks) ? options.extraChunks : [];
    const patches = Array.isArray(options.patches) ? options.patches : [];

    // Bucket every byte into a 256-byte page keyed by page base address.
    // This handles overlapping or unaligned segments correctly and matches
    // picotool's page-oriented output.
    const pages = new Map();
    const writeBytes = ({ paddr, data }) => {
      for (let i = 0; i < data.length; i++) {
        const addr = paddr + i;
        const pageBase = addr - (addr % PAGE_SIZE);
        let page = pages.get(pageBase);
        if (!page) {
          page = new Uint8Array(PAGE_SIZE);
          pages.set(pageBase, page);
        }
        page[addr - pageBase] = data[i];
      }
    };
    for (const c of chunks) writeBytes(c);
    for (const c of extraChunks) writeBytes(c);
    for (const p of patches) writeBytes(p);

    const sortedAddrs = Array.from(pages.keys()).sort((a, b) => a - b);
    const mainTotal = sortedAddrs.length;
    const absCount = includeAbs ? 1 : 0;

    const out = new Uint8Array((mainTotal + absCount) * 512);

    // Absolute block first (if enabled): family ABSOLUTE at 0x10FFFF00, with a
    // 256-byte 0xEF payload followed by the 4-byte IGNORE_BLOCK extension flag.
    if (includeAbs) {
      const absData = new Uint8Array(476);
      absData.fill(ABS_BLOCK_FILL, 0, PAGE_SIZE);
      new DataView(absData.buffer).setUint32(PAGE_SIZE, UF2_EXTENSION_RP2_IGNORE_BLOCK, true);
      writeBlock(
        out, 0,
        ABS_BLOCK_FLAGS, ABS_BLOCK_TARGET, PAGE_SIZE,
        0, ABS_BLOCK_NUMBLKS, ABS_FAMILY_ID,
        absData,
      );
    }

    // Main image: one block per touched 256-byte page, ascending target order.
    for (let i = 0; i < mainTotal; i++) {
      const addr = sortedAddrs[i];
      const page = pages.get(addr);
      writeBlock(
        out, (absCount + i) * 512,
        UF2_FLAG_FAMILY_ID_PRESENT, addr, PAGE_SIZE,
        i, mainTotal, familyId,
        page,
      );
    }

    return out;
  }

  root.PicoPoE = root.PicoPoE || {};
  root.PicoPoE.uf2 = {
    elfToUf2,
    constants: {
      PAGE_SIZE,
      UF2_MAGIC_START0, UF2_MAGIC_START1, UF2_MAGIC_END,
      UF2_FLAG_NOT_MAIN_FLASH, UF2_FLAG_FILE_CONTAINER,
      UF2_FLAG_FAMILY_ID_PRESENT, UF2_FLAG_MD5_PRESENT, UF2_FLAG_EXTENSION_FLAGS_PRESENT,
      UF2_EXTENSION_RP2_IGNORE_BLOCK,
      FAMILY_ID_RP2350, FAMILY_ID_RP2350_ARM_S, DEFAULT_FAMILY_ID,
    },
  };
  // convenience on the top-level namespace
  root.PicoPoE.elfToUf2 = elfToUf2;
})(typeof window !== 'undefined' ? window : globalThis);
