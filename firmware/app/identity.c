// identity.c — see identity.h for the contract.
//
// Two concerns separated for testability:
//
//   conduit_identity_parse() is pure — it takes a buffer + length and
//   either accepts the blob or rejects it. Host-testable; covered by
//   firmware/tests/test_identity.c with canned byte sequences.
//
//   conduit_identity_load() is the IO half — it locates partition 2
//   via the bootrom, memcpy's the 8 KB out of XIP into a static buffer,
//   then calls conduit_identity_parse(). The lookup pattern mirrors
//   ota.c's rom_get_partition_table_info() / sector-bit extraction.

#include "identity.h"

#include "dev_log.h"
#include "sha256.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#ifndef CONDUIT_IDENTITY_HOSTTEST
// Pico-side includes. Skipped under host tests so we can compile the
// parser standalone with a normal C compiler.
#include "hardware/regs/addressmap.h"   // XIP_BASE
#include "pico/bootrom.h"
#include "boot/picobin.h"
#include "boot/picoboot.h"
#endif

#ifndef CONDUIT_FLASH_SECTOR_SIZE
#define CONDUIT_FLASH_SECTOR_SIZE 4096
#endif

#define IDENTITY_PARTITION_ID 2

#ifndef CONDUIT_IDENTITY_HOSTTEST
// 8 KB cached blob. .bss so we don't pay flash for the bytes; only
// 8 KB of SRAM out of 520 KB available on RP2350. Host tests skip
// the IO half entirely, so these statics are excluded too.
static uint8_t   g_identity_blob[CONDUIT_IDENTITY_BLOB_SIZE];
static bool      g_identity_loaded = false;
static conduit_identity_t g_identity_cached;
#endif

// Read a little-endian uint16 from an unaligned offset.
static uint16_t read_u16_le(const uint8_t *p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

// Read a little-endian uint32 from an unaligned offset.
static uint32_t read_u32_le(const uint8_t *p) {
    return  (uint32_t)p[0]
         | ((uint32_t)p[1] << 8)
         | ((uint32_t)p[2] << 16)
         | ((uint32_t)p[3] << 24);
}

bool conduit_identity_parse(const uint8_t *blob, size_t len,
                            conduit_identity_t *out) {
    if (!blob || !out) return false;
    if (len != CONDUIT_IDENTITY_BLOB_SIZE) return false;

    // 1. magic
    if (memcmp(blob, CONDUIT_IDENTITY_MAGIC, CONDUIT_IDENTITY_MAGIC_LEN) != 0) {
        return false;
    }
    // 2. version
    uint16_t ver = read_u16_le(blob + 4);
    if (ver != CONDUIT_IDENTITY_VERSION) return false;
    // 3. reserved must be zero (defensive — catches corrupted writes
    //    that scribbled into the header gap).
    uint16_t reserved = read_u16_le(blob + 6);
    if (reserved != 0) return false;
    // 4. unique_id null-terminated within its 64-byte field. Walk
    //    until first 0x00 or end. Reject if no terminator.
    const uint8_t *uid_field = blob + 8;
    size_t uid_len = 0;
    while (uid_len <= CONDUIT_IDENTITY_UID_MAX && uid_field[uid_len] != 0) {
        uid_len++;
    }
    if (uid_len > CONDUIT_IDENTITY_UID_MAX) return false;
    // 5. lengths fit
    uint32_t key_len  = read_u32_le(blob + 72);
    uint32_t cert_len = read_u32_le(blob + 76);
    if ((size_t)key_len + (size_t)cert_len > CONDUIT_IDENTITY_MAX_PAYLOAD) {
        return false;
    }
    // 6. SHA-256 of bytes [0, BODY_LEN) matches trailer [BODY_LEN, BLOB_SIZE).
    uint8_t digest[CONDUIT_SHA256_DIGEST_LEN];
    conduit_sha256(blob, CONDUIT_IDENTITY_BODY_LEN, digest);
    if (memcmp(digest, blob + CONDUIT_IDENTITY_BODY_LEN,
               CONDUIT_SHA256_DIGEST_LEN) != 0) {
        return false;
    }

    // All checks passed — populate the output struct.
    memcpy(out->unique_id, uid_field, uid_len);
    out->unique_id[uid_len] = '\0';
    out->key_der  = blob + CONDUIT_IDENTITY_HEADER_LEN;
    out->key_len  = key_len;
    out->cert_pem = (const char *)(blob + CONDUIT_IDENTITY_HEADER_LEN + key_len);
    out->cert_len = cert_len;
    return true;
}

#ifndef CONDUIT_IDENTITY_HOSTTEST

// Locate IDENTITY partition's flash byte offset via the bootrom. On
// success returns the offset relative to flash start (i.e., add to
// XIP_BASE for an XIP-readable address); on failure returns -1.
//
// Mirrors the rom_get_partition_table_info pattern from ota.c — same
// PT_INFO_PARTITION_LOCATION_AND_FLAGS request with the partition id
// shifted into the upper byte of the request word.
static int32_t find_identity_partition_offset(void) {
    // Match ota.c's pattern exactly: uint8_t buffer, 4-byte aligned so
    // it's safe to read back as uint32_t* once the bootrom has filled
    // it. SDK's rom_load_partition_table takes uint8_t*, while the
    // result-reading rom_get_partition_table_info takes uint32_t* —
    // same buffer, two views.
    static uint8_t workarea[4 * 1024] __attribute__((aligned(4)));

    int rc = rom_load_partition_table(workarea, sizeof(workarea), false);
    if (rc) {
        DEV_LOG("[identity] PT load failed %d\n", rc);
        return -1;
    }

    int info_rc = rom_get_partition_table_info(
        (uint32_t *)workarea, sizeof(workarea),
        PT_INFO_PARTITION_LOCATION_AND_FLAGS
            | PT_INFO_SINGLE_PARTITION
            | (IDENTITY_PARTITION_ID << 24));
    if (info_rc != 3) {
        DEV_LOG("[identity] partition %d not found (info_rc=%d)\n",
                IDENTITY_PARTITION_ID, info_rc);
        return -1;
    }

    uint32_t loc = ((uint32_t *)workarea)[1];
    uint16_t first_sector = (loc & PICOBIN_PARTITION_LOCATION_FIRST_SECTOR_BITS)
                            >> PICOBIN_PARTITION_LOCATION_FIRST_SECTOR_LSB;
    uint16_t last_sector  = (loc & PICOBIN_PARTITION_LOCATION_LAST_SECTOR_BITS)
                            >> PICOBIN_PARTITION_LOCATION_LAST_SECTOR_LSB;
    uint32_t size_bytes = (uint32_t)(last_sector - first_sector + 1) * CONDUIT_FLASH_SECTOR_SIZE;

    if (size_bytes < CONDUIT_IDENTITY_BLOB_SIZE) {
        DEV_LOG("[identity] partition too small: %lu < %u\n",
                (unsigned long)size_bytes,
                (unsigned)CONDUIT_IDENTITY_BLOB_SIZE);
        return -1;
    }

    return (int32_t)((uint32_t)first_sector * CONDUIT_FLASH_SECTOR_SIZE);
}

bool conduit_identity_load(conduit_identity_t *out) {
    // Idempotent — subsequent calls just hand back the cached parse
    // without re-reading flash. Important because Phase 2's TLS init
    // will probably call this too.
    if (g_identity_loaded) {
        if (out) *out = g_identity_cached;
        return true;
    }

    int32_t offset = find_identity_partition_offset();
    if (offset < 0) return false;

    // KNOWN-BROKEN as written: a direct XIP memcpy from partition 2's flash
    // window (e.g. 0x103F0000 on 4 MB flash) HardFaults on this device.
    // After rom_load_partition_table + rom_get_partition_table_info above,
    // the bootrom has narrowed XIP coverage to the booted partition's
    // range only, and reads outside that fault. The fix is to wrap the
    // read in a flash_safe_execute call against a thunk in RAM that does:
    //     rom_connect_internal_flash → rom_flash_exit_xip
    //     → rom_flash_flush_cache → rom_flash_enter_cmd_xip → memcpy
    // — the rom_flash_* dance can't run from XIP because it cuts XIP
    // mid-call. That work belongs with the PR 4 (TLS server) refactor;
    // until then main.c bypasses conduit_identity_load() entirely so the
    // firmware boots cleanly over plain HTTP.
    const uint8_t *src = (const uint8_t *)(XIP_BASE + (uint32_t)offset);
    memcpy(g_identity_blob, src, CONDUIT_IDENTITY_BLOB_SIZE);

    if (!conduit_identity_parse(g_identity_blob,
                                CONDUIT_IDENTITY_BLOB_SIZE,
                                &g_identity_cached)) {
        // Wipe the cache so a follow-up load() retries from flash —
        // useful if a future host-side write fixes a corrupt blob and
        // we want to recover without rebooting.
        memset(&g_identity_cached, 0, sizeof(g_identity_cached));
        return false;
    }

    g_identity_loaded = true;
    if (out) *out = g_identity_cached;
    return true;
}

const conduit_identity_t *conduit_identity_get(void) {
    return g_identity_loaded ? &g_identity_cached : NULL;
}

#endif // !CONDUIT_IDENTITY_HOSTTEST
