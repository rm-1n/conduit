// finalize.js — replicate picotool's pico_hash_binary step in the browser.
//
// Takes a bare ELF (from clang+lld, no post-link stamping) that already has
// a `.binary_info` IMAGE_DEF block (contributed by the SDK's standard_
// binary_info.c object), and:
//   1. Locates the existing IMAGE_DEF block in the flash segments.
//   2. Builds a new IMAGE_DEF block that extends it with load_map +
//      hash_def + hash_value items.
//   3. Computes SHA256 over (concatenated PT_LOAD bytes in address order +
//      the new block's own words minus the last 3 footer words), same as
//      picotool's hash_andor_sign_block().
//   4. Patches the existing block's `next_block_rel` word to point at the
//      new block (forming a cycle, matching what picotool emits).
//   5. Returns { extraChunks, patches } that uf2.js can fold into the UF2.
//
// Block format constants come from the Pico SDK's
//   ~/.pico-sdk/sdk/2.2.0/src/common/boot_picobin_headers/include/boot/picobin.h
// Hash algorithm + layout trace from picotool source at
//   firmware/build/_deps/picotool-src/bintool/bintool.cpp:629+.
//
// Runs in both browser (uses globalThis.crypto.subtle) and Node (crypto module
// is polyfilled on globalThis.crypto from Node 20+).

(function (root) {
  'use strict';

  const MARKER_START = 0xffffded3;
  const MARKER_END   = 0xab123579;

  const ITEM_IMAGE_TYPE      = 0x42;
  const ITEM_VERSION         = 0x48;
  const ITEM_LOAD_MAP        = 0x06;
  const ITEM_HASH_DEF        = 0x47;
  const ITEM_HASH_VALUE      = 0x4b;

  // Image-type flag layout (picobin.h: PICOBIN_IMAGE_TYPE_EXE_TBYB_BITS).
  // TBYB = Try Before You Buy. If set, the ROM boots the newly-written
  // partition on flash-update reboot but keeps it on probation until
  // rom_explicit_buy() is called. Required for the RP2350 bootrom's
  // rom_pick_ab_partition_during_update to prefer our freshly-written
  // partition over the older committed one.
  const IMAGE_TYPE_TBYB_FLAG = 0x8000;
  // LAST sentinel. Per picobin.h: PICOBIN_BLOCK_ITEM_2BS_LAST = (0x80 | 0x7f)
  // which is just the single byte 0xff — NOT 0xff7f. picotool detects LAST
  // by switching on `(uint8_t)header` (low byte only).
  const ITEM_2BS_LAST        = 0xff;

  const HASH_SHA256          = 0x01;

  // Round up to next 256-byte flash page boundary. UF2 blocks are 256 B pages
  // anyway, so placing the new IMAGE_DEF block at a page start keeps uf2.js's
  // page-bucket coalescing happy.
  function alignUp(x, align) {
    const r = x % align;
    return r === 0 ? x : x + (align - r);
  }

  // Scan a loadable chunk for an IMAGE_DEF block. Returns the byte offset
  // within the chunk where MARKER_START sits, or -1.
  function findImageDefInChunk(chunk) {
    const dv = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    for (let off = 0; off + 16 <= chunk.data.byteLength; off += 4) {
      if (dv.getUint32(off, true) === MARKER_START) {
        // Find MARKER_END by following until we see it (bounded scan).
        for (let end = off + 8; end + 4 <= chunk.data.byteLength; end += 4) {
          if (dv.getUint32(end, true) === MARKER_END) return { blockStart: off, blockEnd: end + 4 };
        }
      }
    }
    return null;
  }

  // Locate the first IMAGE_DEF block across all chunks. Returns the chunk
  // index + byte offsets + the absolute flash address of the block start
  // + the parsed block's image_type word + version word (as first two items).
  function findExistingBlock(chunks) {
    for (let i = 0; i < chunks.length; i++) {
      const hit = findImageDefInChunk(chunks[i]);
      if (!hit) continue;
      return {
        chunkIndex: i,
        chunkPaddr: chunks[i].paddr,
        blockStart: hit.blockStart,
        blockEnd: hit.blockEnd,
        flashAddr: chunks[i].paddr + hit.blockStart,
        bytes: chunks[i].data.subarray(hit.blockStart, hit.blockEnd),
      };
    }
    return null;
  }

  // Read the image_type + version items out of a block's bytes. Returns
  // { imageTypeFlags, versionMajor, versionMinor } — enough to recreate
  // equivalent items in the new block.
  function parseBlockItems(blockBytes) {
    const dv = new DataView(blockBytes.buffer, blockBytes.byteOffset, blockBytes.byteLength);
    let off = 4; // skip MARKER_START
    let imageTypeFlags = null, versionMajor = 0, versionMinor = 0;
    while (off + 4 <= blockBytes.byteLength) {
      const header = dv.getUint32(off, true);
      if (header === MARKER_END) break;
      const type = header & 0x7f;
      const hasLongSize = (header & 0x80) !== 0;
      const size = hasLongSize ? ((header >>> 8) & 0xffff) : ((header >>> 8) & 0xff);
      // LAST sentinel detected by low byte == 0xff (picotool's switch).
      if ((header & 0xff) === 0xff) break;
      if (type === ITEM_IMAGE_TYPE) {
        imageTypeFlags = (header >>> 16) & 0xffff;
      } else if (type === ITEM_VERSION) {
        // version word layout (picotool metadata.h version_item::to_words):
        //   word = (major << 16) | minor
        const word = dv.getUint32(off + 4, true);
        versionMajor = (word >>> 16) & 0xffff;
        versionMinor = word & 0xffff;
      }
      off += size * 4;
      if (size === 0) break; // safety
    }
    return { imageTypeFlags, versionMajor, versionMinor };
  }

  // Concatenate all loadable chunk bytes in ascending paddr order (that's
  // what picotool's get_lm_hash_data produces for the "no load_map yet" path).
  function concatLoadableBytes(chunks) {
    const sorted = [...chunks].sort((a, b) => a.paddr - b.paddr);
    let total = 0;
    for (const c of sorted) total += c.data.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of sorted) { out.set(c.data, off); off += c.data.byteLength; }
    return out;
  }

  // SHA256 helper that works in browser + Node.
  async function sha256(bytes) {
    // The subtle.digest path is the same in both modern environments.
    const buf = await (root.crypto || globalThis.crypto).subtle.digest('SHA-256', bytes);
    return new Uint8Array(buf);
  }

  // Build a new IMAGE_DEF block's word array with items and a zero hash.
  // The hash value occupies 8 words; we'll patch them after sha256.
  //
  // blockBaseAddr is the flash address where this block will live (block
  // physical_addr). picotool's non-absolute load_map encodes each entry's
  // storage address as a delta relative to the LOAD_MAP header's own flash
  // position (= blockBaseAddr + load_map_header_word_offset * 4). The parser
  // reverses the delta using the same `current_addr`.
  function buildNewBlockWords(
    { imageTypeFlags, versionMajor, versionMinor },
    loadMapEntries,
    hashBytesPlaceholder,
    blockBaseAddr,
  ) {
    const words = [];
    words.push(MARKER_START);

    // IMAGE_TYPE item (single-byte size = 1, with flags in upper 16 bits)
    const imgHeader = (1 << 8) | ITEM_IMAGE_TYPE | ((imageTypeFlags & 0xffff) << 16);
    words.push(imgHeader >>> 0);

    // VERSION item (single-byte size = 2). Layout matches picotool's
    // version_item::to_words: second word = (major << 16) | minor.
    words.push(((2 << 8) | ITEM_VERSION) >>> 0);
    words.push((((versionMajor & 0xffff) << 16) | (versionMinor & 0xffff)) >>> 0);

    // LOAD_MAP item (single-byte size = 1 + 3*N; low 8 bits of byte 3 = entry
    // count; bit 31 = absolute flag which we leave 0). Entries are encoded
    // with storage_address - loadMapHeaderFlashAddr, to match picotool.
    const nEntries = loadMapEntries.length;
    const loadMapSize = 1 + 3 * nEntries;
    const loadMapHeader = (loadMapSize << 8) | ITEM_LOAD_MAP | ((nEntries & 0xff) << 24);
    const loadMapHeaderWordOffset = words.length;
    const loadMapHeaderFlashAddr = blockBaseAddr + loadMapHeaderWordOffset * 4;
    words.push(loadMapHeader >>> 0);
    for (const e of loadMapEntries) {
      const relStorage = e.storage === 0 ? 0 : (e.storage - loadMapHeaderFlashAddr) | 0;
      words.push(relStorage >>> 0);
      words.push(e.runtime >>> 0);
      words.push(e.size >>> 0);
    }

    // HASH_DEF item (single-byte size = 2, hash_type in upper byte)
    // Second word = block_words_to_hash. picotool writes ctx.word_offset + 2
    // when block_words_to_hash == 0, which equals the word offset JUST AFTER
    // the hash_def item header+data. We emit 0 here and patch later below.
    const hashDefWordIdx = words.length;
    words.push(((2 << 8) | ITEM_HASH_DEF | (HASH_SHA256 << 24)) >>> 0);
    words.push(0); // placeholder, filled in after we know block_words_to_hash

    // HASH_VALUE item (size = 1 + hashBytes/4)
    const hashWords = hashBytesPlaceholder.length / 4; // 8 for SHA256
    const hashValueHeader = ((1 + hashWords) << 8) | ITEM_HASH_VALUE;
    const hashValueHeaderIdx = words.length;
    words.push(hashValueHeader >>> 0);
    const hashStartIdx = words.length;
    for (let i = 0; i < hashWords; i++) {
      const w = (hashBytesPlaceholder[i*4]) |
                (hashBytesPlaceholder[i*4+1] << 8) |
                (hashBytesPlaceholder[i*4+2] << 16) |
                (hashBytesPlaceholder[i*4+3] << 24);
      words.push(w >>> 0);
    }

    // Footer: LAST + next_block_rel + MARKER_END. picotool encodes LAST as
    //   PICOBIN_BLOCK_ITEM_2BS_LAST | (words.size() - 1) << 8
    // where words.size() is the PRE-push count (bintool/metadata.h:689).
    const lastIdx = words.length;
    const encodedSize = words.length - 1;
    words.push((ITEM_2BS_LAST | (encodedSize << 8)) >>> 0);
    const nextBlockRelIdx = words.length;
    words.push(0); // next_block_rel — patched below (points back to existing block → cycle)
    words.push(MARKER_END);

    // hash_def's "block_words_to_hash" = word offset of the first word AFTER
    // hash_def within the block. picotool records the same value via
    // ctx.word_offset + 2 when creating, and picotool's verify does
    // tmp_words.resize(block_words_to_hash) to isolate the to-hash region.
    const blockWordsToHash = hashDefWordIdx + 2;
    words[hashDefWordIdx + 1] = blockWordsToHash >>> 0;

    return { words, hashStartIdx, nextBlockRelIdx, lastIdx, blockWordsToHash };
  }

  function wordsToBytes(words) {
    const out = new Uint8Array(words.length * 4);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < words.length; i++) dv.setUint32(i*4, words[i] >>> 0, true);
    return out;
  }

  // Main entry: returns { extraChunks, patches } for uf2.js.
  //   patches: list of { paddr, data } — overwrite paddr..paddr+data.length in
  //     existing UF2 output. Used to rewrite the existing block's
  //     next_block_rel word and, when setTbyb=true, its IMAGE_TYPE flags.
  //   extraChunks: list of { paddr, data } — new flash content to add as
  //     additional UF2 pages (the new IMAGE_DEF block).
  //
  // opts:
  //   setTbyb           - OR the TBYB flag into image_type flags on both
  //                       existing and new blocks. Defaults true because the
  //                       RP2350 bootrom's flash-update partition picker
  //                       requires it to prefer the just-written partition.
  //   version           - { major, minor } override. Defaults to the version
  //                       already in the existing block. Set to current
  //                       device version + 1 to guarantee the new image wins
  //                       the cold-boot A/B selection.
  async function finalizeElf(elfBytes, opts) {
    const { setTbyb = true, version: versionOverride = null } = opts || {};
    const elf = root.PicoPoE.elf.parseElf(elfBytes);
    const chunks = root.PicoPoE.elf.loadableChunks(elf);
    if (!chunks.length) throw new Error('no loadable chunks');

    const existing = findExistingBlock(chunks);
    if (!existing) {
      // Nothing to finalize; caller can still build a valid (unhashed) UF2.
      return { extraChunks: [], patches: [] };
    }

    let { imageTypeFlags, versionMajor, versionMinor } = parseBlockItems(existing.bytes);
    if (versionOverride) {
      if (typeof versionOverride.major === 'number') versionMajor = versionOverride.major & 0xffff;
      if (typeof versionOverride.minor === 'number') versionMinor = versionOverride.minor & 0xffff;
    }
    if (setTbyb) imageTypeFlags = (imageTypeFlags | IMAGE_TYPE_TBYB_FLAG) & 0xffff;

    // Pick a flash address for the new block: first 256-byte page after the
    // last loadable chunk.
    const lastEnd = Math.max(...chunks.map((c) => c.paddr + c.data.byteLength));
    const newBlockAddr = alignUp(lastEnd, 256);

    // Build load-map entries: one per PT_LOAD chunk, absolute form.
    const loadMapEntries = [...chunks]
      .sort((a, b) => a.paddr - b.paddr)
      .map((c) => ({ storage: c.paddr, runtime: c.paddr, size: c.data.byteLength }));

    // Compute the next_block_rel patch for the existing block FIRST so we
    // can apply it to the chunk bytes before hashing. picotool's verify path
    // reads bytes from the UF2-derived bin (which includes the patch), so if
    // we hash the pre-patch ELF bytes we get a different hash than picotool.
    const newBlockFlashAddr = newBlockAddr;
    const existingBlockFlashAddr = existing.flashAddr;
    const existingNextBlockRelByte = existing.blockEnd - 8;
    const existingDelta = (newBlockFlashAddr - existingBlockFlashAddr) | 0;
    const nextRelBytes = new Uint8Array(4);
    new DataView(nextRelBytes.buffer).setInt32(0, existingDelta, true);
    const nextRelPaddr = existing.chunkPaddr + existingNextBlockRelByte;
    const patches = [{ paddr: nextRelPaddr, data: nextRelBytes }];

    // If setTbyb, also patch the existing block's IMAGE_TYPE header word so
    // the two blocks agree. The existing block layout is MARKER_START @ 0,
    // IMAGE_TYPE header @ 4. Re-read original bytes, OR in TBYB, write back.
    if (setTbyb) {
      const imgHeaderBlockOffset = 4;
      const imgHeaderByteOffset = existing.blockStart + imgHeaderBlockOffset;
      const origDv = new DataView(
        existing.bytes.buffer, existing.bytes.byteOffset, existing.bytes.byteLength,
      );
      const origHeader = origDv.getUint32(imgHeaderBlockOffset, true);
      const newHeader = (origHeader | (IMAGE_TYPE_TBYB_FLAG << 16)) >>> 0;
      const imgPatchBytes = new Uint8Array(4);
      new DataView(imgPatchBytes.buffer).setUint32(0, newHeader, true);
      patches.push({
        paddr: existing.chunkPaddr + imgHeaderByteOffset,
        data: imgPatchBytes,
      });
    }

    // Apply every patch to a working copy of the chunks, then concat — this is
    // the byte sequence picotool will read back from the UF2 when it verifies.
    const patchedChunks = chunks.map((c) => {
      let data = c.data;
      for (const p of patches) {
        const cEnd = c.paddr + data.byteLength;
        if (p.paddr >= c.paddr && p.paddr + p.data.length <= cEnd) {
          if (data === c.data) data = new Uint8Array(c.data);
          data.set(p.data, p.paddr - c.paddr);
        }
      }
      return data === c.data ? c : { paddr: c.paddr, data };
    });

    // Build block with zero hash, compute bytes-to-hash, then SHA256.
    // The hashed region is the first `block_words_to_hash` words of the
    // block — i.e. everything through and INCLUDING hash_def, but NOT
    // hash_value or the footer. picotool's create path hashes a block that
    // has no hash_value item yet; its verify path resizes to block_words_to_hash.
    const zero32 = new Uint8Array(32);
    const { words: tmpWords, blockWordsToHash } = buildNewBlockWords(
      { imageTypeFlags, versionMajor, versionMinor }, loadMapEntries, zero32, newBlockAddr);

    const toHashLoadable = concatLoadableBytes(patchedChunks);
    // picotool's hash_andor_sign_block clears the TBYB bit from tmp_words[1]
    // (the IMAGE_TYPE word, bit 31) before hashing — so the hash is
    // independent of whether the image is on-probation or committed.
    // bintool.cpp:~642 has the same `tmp_words[1] &= ~0x80000000` dance.
    // We must mirror it here or the verify path's cleared hash won't match
    // ours (which kept TBYB set).
    const hashWordsCopy = tmpWords.slice(0, blockWordsToHash);
    if (hashWordsCopy[1] & 0x80000000) hashWordsCopy[1] = (hashWordsCopy[1] & ~0x80000000) >>> 0;
    const blockHashRegion = wordsToBytes(hashWordsCopy);
    const toHash = new Uint8Array(toHashLoadable.byteLength + blockHashRegion.byteLength);
    toHash.set(toHashLoadable, 0);
    toHash.set(blockHashRegion, toHashLoadable.byteLength);

    const hash = await sha256(toHash);

    // Rebuild the block with the real hash.
    const { words: finalWords, nextBlockRelIdx } =
      buildNewBlockWords({ imageTypeFlags, versionMajor, versionMinor }, loadMapEntries, hash, newBlockAddr);

    // next_block_rel is a BYTE offset (signed) from the block's physical_addr
    // (block START, not the next_block_rel word itself). picotool computes
    // next_block_addr = first_block->physical_addr + next_block_rel directly.
    // See picotool bintool.cpp:292.
    finalWords[nextBlockRelIdx] = (existingBlockFlashAddr - newBlockFlashAddr) | 0;

    const newBlockBytes = wordsToBytes(finalWords);
    const extraChunks = [{ paddr: newBlockFlashAddr, data: newBlockBytes }];

    return { extraChunks, patches, hash, newBlockFlashAddr, existingBlockFlashAddr };
  }

  root.PicoPoE = root.PicoPoE || {};
  root.PicoPoE.finalize = { finalizeElf };
})(typeof window !== 'undefined' ? window : globalThis);
