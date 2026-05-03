// elf.js — minimal ELF32 parser for RP2350/ARM binaries.
// We only need enough to extract PT_LOAD segments and their flash-target
// addresses so uf2.js can emit a UF2 image byte-identical to picotool's
// elf2uf2 output.

(function (root) {
  'use strict';

  const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // 0x7F 'E' 'L' 'F'
  const ELFCLASS32 = 1;
  const ELFDATA2LSB = 1;
  const EM_ARM = 40;
  const PT_LOAD = 1;
  const PF_X = 1;
  const PF_W = 2;
  const PF_R = 4;

  // Parse an ELF32 little-endian ARM binary. Returns { header, segments, bytes }.
  // Throws on malformed input.
  function parseElf(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.byteLength < 52) throw new Error('ELF too small');
    for (let i = 0; i < 4; i++) {
      if (bytes[i] !== ELF_MAGIC[i]) throw new Error('Not an ELF file (bad magic)');
    }
    if (bytes[4] !== ELFCLASS32) throw new Error('Not ELF32 (only 32-bit ARM supported)');
    if (bytes[5] !== ELFDATA2LSB) throw new Error('Not little-endian ELF');

    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = {
      e_type:      dv.getUint16(16, true),
      e_machine:   dv.getUint16(18, true),
      e_version:   dv.getUint32(20, true),
      e_entry:     dv.getUint32(24, true),
      e_phoff:     dv.getUint32(28, true),
      e_shoff:     dv.getUint32(32, true),
      e_flags:     dv.getUint32(36, true),
      e_ehsize:    dv.getUint16(40, true),
      e_phentsize: dv.getUint16(42, true),
      e_phnum:     dv.getUint16(44, true),
      e_shentsize: dv.getUint16(46, true),
      e_shnum:     dv.getUint16(48, true),
      e_shstrndx:  dv.getUint16(50, true),
    };

    if (header.e_machine !== EM_ARM) {
      throw new Error(`Unexpected e_machine 0x${header.e_machine.toString(16)}; expected ARM (40)`);
    }
    if (header.e_phentsize < 32) {
      throw new Error(`Unexpected e_phentsize ${header.e_phentsize}`);
    }

    const segments = [];
    for (let i = 0; i < header.e_phnum; i++) {
      const off = header.e_phoff + i * header.e_phentsize;
      segments.push({
        type:   dv.getUint32(off + 0,  true),
        offset: dv.getUint32(off + 4,  true),
        vaddr:  dv.getUint32(off + 8,  true),
        paddr:  dv.getUint32(off + 12, true),
        filesz: dv.getUint32(off + 16, true),
        memsz:  dv.getUint32(off + 20, true),
        flags:  dv.getUint32(off + 24, true),
        align:  dv.getUint32(off + 28, true),
      });
    }

    return { header, segments, bytes };
  }

  // RP2350 XIP flash range — anything outside this is SRAM, I/O, or bootrom,
  // and cannot be written via UF2. picotool's elf2uf2 applies the same filter.
  const FLASH_START = 0x10000000;
  const FLASH_END   = 0x18000000; // 128 MB XIP window; real boards use < 16 MB

  // Return loadable chunks { paddr, data: Uint8Array } in address order.
  // Only PT_LOAD segments with non-zero filesz AND a flash LMA contribute.
  //
  // Why the flash-LMA filter: lld sometimes emits PT_LOAD for RAM-resident
  // sections like .ram_vector_table with filesz > 0 and paddr == vaddr in
  // SRAM. The CMake/arm-none-eabi-ld reference emits filesz = 0 for these.
  // Keeping those segments sends UF2 blocks with targets in 0x2xxxxxxx, which
  // the firmware rejects with OTA_ERR_OVERFLOW ("data exceeds partition size")
  // because the translated flash_addr lands outside the target partition.
  //
  // p_paddr is the load-memory-address (flash address for Pico SDK images);
  // p_vaddr is the runtime virtual address (e.g. RAM for .data), but flash-
  // stored copies live at p_paddr.
  function loadableChunks(elf) {
    const chunks = [];
    for (const s of elf.segments) {
      if (s.type !== PT_LOAD) continue;
      if (s.filesz === 0) continue;
      if (s.paddr < FLASH_START || s.paddr >= FLASH_END) continue;
      const data = elf.bytes.subarray(s.offset, s.offset + s.filesz);
      chunks.push({ paddr: s.paddr, data });
    }
    chunks.sort((a, b) => a.paddr - b.paddr);
    return chunks;
  }

  root.Conduit = root.Conduit || {};
  root.Conduit.elf = {
    parseElf,
    loadableChunks,
    constants: { PT_LOAD, PF_X, PF_W, PF_R, EM_ARM },
  };
})(typeof window !== 'undefined' ? window : globalThis);
