#include "ota.h"
#include "pico_poe_config.h"

#include <stdio.h>
#include <string.h>
#include "pico/stdlib.h"
#include "pico/bootrom.h"
#include "pico/flash.h"
#include "boot/picoboot_constants.h"
#include "boot/picobin.h"
#include "hardware/flash.h"
#include "hardware/sync.h"
#include "hardware/watchdog.h"

// UF2 block structure
typedef struct {
    uint32_t magic_start0;
    uint32_t magic_start1;
    uint32_t flags;
    uint32_t target_addr;
    uint32_t payload_size;
    uint32_t block_no;
    uint32_t num_blocks;
    uint32_t family_id;
    uint8_t  data[476];     // 256 payload + 220 padding
    uint32_t magic_end;
} uf2_block_t;

_Static_assert(sizeof(uf2_block_t) == 512, "UF2 block must be 512 bytes");

// OTA state
static struct {
    bool     active;
    uint32_t partition_start;  // flash offset (not XIP address)
    uint32_t partition_size;
    int32_t  addr_delta;       // runtime addr delta: target_partition_base - uf2_target_base
    uint32_t bytes_written;
    uint32_t blocks_received;
    uint32_t num_blocks_expected;
    int32_t  last_erased_sector; // sector index of last erased sector
    uint8_t  block_buf[UF2_BLOCK_SIZE];
    uint16_t block_buf_pos;
} ota;

static uint8_t workarea[4 * 1024] __attribute__((aligned(4)));

// TBYB commit state — set at boot from rom_get_boot_info().boot_type, cleared
// by ota_commit() on a successful rom_explicit_buy. See ota.h for the flow.
static bool g_commit_pending = false;
static const char *g_boot_type_str = "unknown";

// Parameters for flash_safe_program. flash_safe_execute passes a single void*,
// so pack address + buffer + length into one struct.
typedef struct {
    uint32_t       addr;
    const uint8_t *data;
    size_t         len;
} flash_write_params_t;

static void flash_safe_erase(void *param) {
    uint32_t addr = (uint32_t)(uintptr_t)param;
    flash_range_erase(addr, PICO_POE_FLASH_SECTOR_SIZE);
}

static void flash_safe_program(void *param) {
    flash_write_params_t *wp = (flash_write_params_t *)param;
    flash_range_program(wp->addr, wp->data, wp->len);
}

const char *ota_error_string(ota_err_t err) {
    switch (err) {
        case OTA_OK:                    return "ok";
        case OTA_ERR_ALREADY_IN_PROGRESS: return "update already in progress";
        case OTA_ERR_NO_PARTITION:      return "no target partition found";
        case OTA_ERR_INVALID_UF2:       return "invalid UF2 block";
        case OTA_ERR_WRONG_FAMILY:      return "wrong UF2 family ID";
        case OTA_ERR_FLASH_ERASE:       return "flash erase failed";
        case OTA_ERR_FLASH_WRITE:       return "flash write failed";
        case OTA_ERR_OVERFLOW:          return "data exceeds partition size";
        case OTA_ERR_BLOCK_COUNT:       return "block count mismatch";
        case OTA_ERR_NOT_STARTED:       return "no update in progress";
    }
    return "unknown error";
}

ota_err_t ota_begin(void) {
    if (ota.active) {
        return OTA_ERR_ALREADY_IN_PROGRESS;
    }

    // Load partition table so ROM can resolve the UF2 target partition.
    int rc = rom_load_partition_table(workarea, sizeof(workarea), false);
    if (rc) {
        printf("[ota] PT load failed %d\n", rc);
        return OTA_ERR_NO_PARTITION;
    }

    // Ask ROM to choose target partition for this UF2 family, the same way
    // BOOTSEL drag-and-drop does. Our app is built as rp2350-arm-s, and the
    // partitions.json declares both A and B as that family — so this call
    // returns whichever of A/B is the A/B-update target (i.e., the one we
    // are not currently running from). BOOTROM error codes are all negative
    // (see boot/bootrom_constants.h); a non-negative return is the selected
    // partition index and means success.
    resident_partition_t target;
    rc = rom_get_uf2_target_partition(workarea, sizeof(workarea),
                                      UF2_FAMILY_RP2350_ARM_S, &target);
    if (rc < 0) {
        printf("[ota] UF2 target partition pick failed %d\n", rc);
        return OTA_ERR_NO_PARTITION;
    }

    // If the chosen target overlaps the partition we are currently executing
    // from, switch to the other A/B partition. Find "the other one" by
    // scanning partitions 0 and 1 and picking whichever's sector range does
    // NOT contain our current storage address.
    intptr_t current_storage_addr = rom_flash_runtime_to_storage_addr((uintptr_t)&ota_begin);
    if (current_storage_addr >= 0) {
        uint32_t current_off = (uint32_t)current_storage_addr;
        uint16_t t_first_sector = (target.permissions_and_location & PICOBIN_PARTITION_LOCATION_FIRST_SECTOR_BITS)
                                  >> PICOBIN_PARTITION_LOCATION_FIRST_SECTOR_LSB;
        uint16_t t_last_sector  = (target.permissions_and_location & PICOBIN_PARTITION_LOCATION_LAST_SECTOR_BITS)
                                  >> PICOBIN_PARTITION_LOCATION_LAST_SECTOR_LSB;
        uint32_t t_start = t_first_sector * PICO_POE_FLASH_SECTOR_SIZE;
        uint32_t t_end   = (t_last_sector + 1) * PICO_POE_FLASH_SECTOR_SIZE;

        if (current_off >= t_start && current_off < t_end) {
            bool alt_found = false;
            for (uint32_t id = 0; id < 2; id++) {
                int info_rc = rom_get_partition_table_info(
                    (uint32_t *)workarea,
                    sizeof(workarea),
                    PT_INFO_PARTITION_LOCATION_AND_FLAGS | PT_INFO_SINGLE_PARTITION | (id << 24));
                if (info_rc != 3) continue;

                uint32_t alt_loc = ((uint32_t *)workarea)[1];
                uint16_t a_first = (alt_loc & PICOBIN_PARTITION_LOCATION_FIRST_SECTOR_BITS)
                                   >> PICOBIN_PARTITION_LOCATION_FIRST_SECTOR_LSB;
                uint16_t a_last  = (alt_loc & PICOBIN_PARTITION_LOCATION_LAST_SECTOR_BITS)
                                   >> PICOBIN_PARTITION_LOCATION_LAST_SECTOR_LSB;
                uint32_t a_start = a_first * PICO_POE_FLASH_SECTOR_SIZE;
                uint32_t a_end   = (a_last + 1) * PICO_POE_FLASH_SECTOR_SIZE;

                if (current_off >= a_start && current_off < a_end) continue;
                target.permissions_and_location = alt_loc;
                printf("[ota] Switched to alternate partition %u to avoid self-overwrite\n", id);
                alt_found = true;
                break;
            }
            if (!alt_found) {
                printf("[ota] No non-overlapping alternate partition found\n");
                return OTA_ERR_NO_PARTITION;
            }
        }
    }

    uint16_t first_sector = (target.permissions_and_location & PICOBIN_PARTITION_LOCATION_FIRST_SECTOR_BITS)
                            >> PICOBIN_PARTITION_LOCATION_FIRST_SECTOR_LSB;
    uint16_t last_sector  = (target.permissions_and_location & PICOBIN_PARTITION_LOCATION_LAST_SECTOR_BITS)
                            >> PICOBIN_PARTITION_LOCATION_LAST_SECTOR_LSB;

    ota.partition_start = first_sector * PICO_POE_FLASH_SECTOR_SIZE;
    ota.partition_size  = ((last_sector + 1) - first_sector) * PICO_POE_FLASH_SECTOR_SIZE;
    ota.addr_delta = 0;
    ota.bytes_written = 0;
    ota.blocks_received = 0;
    ota.num_blocks_expected = 0;
    ota.last_erased_sector = -1;
    ota.block_buf_pos = 0;
    ota.active = true;

        printf("[ota] Target partition: offset 0x%x, size 0x%x\n",
            ota.partition_start, ota.partition_size);

    return OTA_OK;
}

static ota_err_t process_uf2_block(const uf2_block_t *block) {
    // Validate magic numbers
    if (block->magic_start0 != UF2_MAGIC_START0 ||
        block->magic_start1 != UF2_MAGIC_START1 ||
        block->magic_end    != UF2_MAGIC_END) {
        return OTA_ERR_INVALID_UF2;
    }

    // Skip ABSOLUTE-family blocks. pico_package_uf2_output emits one such
    // block per UF2 (the RP2350-E10 errata "abs-block" at 0x10ffff00). It
    // isn't part of the partition image — it's a flash marker for the
    // bootrom. Counting it into our address translation would skew
    // addr_delta and overflow the subsequent partition-targeted blocks.
    if ((block->flags & 0x00002000) && block->family_id == UF2_FAMILY_ABSOLUTE) {
        return OTA_OK;
    }

    // All remaining blocks must be RP2350-ARM-S (what our partitions accept).
    if ((block->flags & 0x00002000) &&
        block->family_id != UF2_FAMILY_RP2350_ARM_S) {
        return OTA_ERR_WRONG_FAMILY;
    }

    // Store expected block count and compute translation from UF2 runtime
    // addresses to the selected partition runtime base.
    if (ota.blocks_received == 0) {
        ota.num_blocks_expected = block->num_blocks;
        ota.addr_delta = (int32_t)(XIP_BASE + ota.partition_start) - (int32_t)block->target_addr;
    }

    // Translate this block address into the selected partition.
    int64_t translated_runtime = (int64_t)block->target_addr + (int64_t)ota.addr_delta;
    int64_t flash_addr_64 = translated_runtime - (int64_t)XIP_BASE;
    if (flash_addr_64 < 0 || flash_addr_64 > 0xffffffffll) {
        printf("[ota] Block addr translation overflow (target=0x%x)\n", block->target_addr);
        return OTA_ERR_OVERFLOW;
    }
    uint32_t flash_addr = (uint32_t)flash_addr_64;

    if (flash_addr < ota.partition_start ||
        flash_addr + block->payload_size > ota.partition_start + ota.partition_size) {
        printf("[ota] Block addr 0x%x outside partition\n", flash_addr);
        return OTA_ERR_OVERFLOW;
    }

    uint32_t write_offset = flash_addr - ota.partition_start;

    // Erase sectors as needed. Use flash_safe_execute so core 1 (the RMII
    // ethernet loop, running from flash) is locked out during each XIP pause.
    uint32_t sector_idx = write_offset / PICO_POE_FLASH_SECTOR_SIZE;
    uint32_t end_sector  = (write_offset + block->payload_size - 1) / PICO_POE_FLASH_SECTOR_SIZE;

    for (uint32_t s = sector_idx; s <= end_sector; s++) {
        if ((int32_t)s > ota.last_erased_sector) {
            uint32_t erase_addr = ota.partition_start + s * PICO_POE_FLASH_SECTOR_SIZE;
            int erc = flash_safe_execute(flash_safe_erase, (void *)(uintptr_t)erase_addr, 5000);
            if (erc != PICO_OK) {
                printf("[ota] flash_safe_execute(erase) failed %d\n", erc);
                return OTA_ERR_FLASH_ERASE;
            }
            ota.last_erased_sector = (int32_t)s;
        }
    }

    // Write the payload, again coordinated via flash_safe_execute.
    flash_write_params_t wp = {
        .addr   = ota.partition_start + write_offset,
        .data   = block->data,
        .len    = block->payload_size,
    };
    int wrc = flash_safe_execute(flash_safe_program, &wp, 5000);
    if (wrc != PICO_OK) {
        printf("[ota] flash_safe_execute(program) failed %d\n", wrc);
        return OTA_ERR_FLASH_WRITE;
    }

    ota.bytes_written += block->payload_size;
    ota.blocks_received++;

    return OTA_OK;
}

ota_err_t ota_write_chunk(const uint8_t *data, size_t len) {
    if (!ota.active) {
        return OTA_ERR_NOT_STARTED;
    }

    size_t offset = 0;
    while (offset < len) {
        // Fill the block buffer
        size_t needed = UF2_BLOCK_SIZE - ota.block_buf_pos;
        size_t available = len - offset;
        size_t copy = (available < needed) ? available : needed;

        memcpy(ota.block_buf + ota.block_buf_pos, data + offset, copy);
        ota.block_buf_pos += copy;
        offset += copy;

        // Process complete block
        if (ota.block_buf_pos == UF2_BLOCK_SIZE) {
            ota_err_t err = process_uf2_block((const uf2_block_t *)ota.block_buf);
            if (err != OTA_OK) {
                ota_abort();
                return err;
            }
            ota.block_buf_pos = 0;
        }
    }

    return OTA_OK;
}

ota_err_t ota_finish(void) {
    if (!ota.active) {
        return OTA_ERR_NOT_STARTED;
    }

    // Check all blocks received
    if (ota.num_blocks_expected > 0 && ota.blocks_received != ota.num_blocks_expected) {
        printf("[ota] Block count mismatch: got %u, expected %u\n",
               ota.blocks_received, ota.num_blocks_expected);
        ota_abort();
        return OTA_ERR_BLOCK_COUNT;
    }

    printf("[ota] Complete: %u blocks, %u bytes written\n",
           ota.blocks_received, ota.bytes_written);

    ota.active = false;

    // Reboot — ROM will pick the partition with the newer version
    printf("[ota] Rebooting...\n");
    sleep_ms(100);  // Let printf flush

    // Hint ROM to boot the updated image after this write completes.
    //
    // g_reboot_pending tells main() (on core 0) to stop calling
    // watchdog_update() — rom_reboot programs the same watchdog LOAD
    // register to fire the reset after delay_ms, and the main loop would
    // otherwise reset that countdown before it can fire. See memory:
    // project_rom_reboot_watchdog_race.
    extern volatile bool g_reboot_pending;
    __atomic_store_n(&g_reboot_pending, true, __ATOMIC_RELEASE);
    rom_reboot(REBOOT2_FLAG_REBOOT_TYPE_FLASH_UPDATE, 100,
               XIP_BASE + ota.partition_start, 0);

    // Busy-wait while the watchdog countdown expires.
    while (1) tight_loop_contents();

    // Unreachable
    return OTA_OK;
}

void ota_abort(void) {
    if (ota.active) {
        printf("[ota] Aborted after %u blocks\n", ota.blocks_received);
    }
    memset(&ota, 0, sizeof(ota));
    ota.last_erased_sector = -1;
}

bool ota_in_progress(void) {
    return ota.active;
}

uint32_t ota_bytes_written(void) {
    return ota.bytes_written;
}

// ---- TBYB commit state -----------------------------------------------------

void ota_init_boot_state(void) {
    boot_info_t info;
    int rc = rom_get_boot_info(&info);
    if (rc < 0) {
        printf("[ota] rom_get_boot_info failed %d\n", rc);
        g_boot_type_str = "unknown";
        g_commit_pending = false;
        return;
    }

    switch (info.boot_type) {
        case BOOT_TYPE_NORMAL:       g_boot_type_str = "normal";       break;
        case BOOT_TYPE_BOOTSEL:      g_boot_type_str = "bootsel";      break;
        case BOOT_TYPE_RAM_IMAGE:    g_boot_type_str = "ram_image";    break;
        case BOOT_TYPE_FLASH_UPDATE: g_boot_type_str = "flash_update"; break;
        case BOOT_TYPE_PC_SP:        g_boot_type_str = "pc_sp";        break;
        default:                     g_boot_type_str = "unknown";      break;
    }

    // A flash-update boot is the only one that puts us into TBYB-pending
    // state: rom_reboot was called with REBOOT2_FLAG_REBOOT_TYPE_FLASH_UPDATE
    // by the previous image's OTA finish. Any other boot_type means we're
    // either on a committed image already, or the ROM rolled us back — in
    // both cases there is nothing for us to commit.
    g_commit_pending = (info.boot_type == BOOT_TYPE_FLASH_UPDATE);
    printf("[ota] boot_type=%s, commit_pending=%d\n",
           g_boot_type_str, (int)g_commit_pending);
}

bool ota_commit_pending(void) {
    return g_commit_pending;
}

const char *ota_boot_type_str(void) {
    return g_boot_type_str;
}

ota_commit_result_t ota_commit(void) {
    if (!g_commit_pending) {
        return OTA_COMMIT_NOT_PENDING;
    }
    int rc = rom_explicit_buy(workarea, sizeof(workarea));
    if (rc == 0) {
        g_commit_pending = false;
        printf("[ota] Committed via /api/commit\n");
        return OTA_COMMIT_OK;
    }
    printf("[ota] rom_explicit_buy returned %d\n", rc);
    return OTA_COMMIT_FAILED;
}
