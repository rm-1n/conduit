/**
 * CONDUIT A/B Bootloader
 *
 * Signed bootloader that loads the partition table, picks the correct
 * A/B partition (supporting flash updates), and chains into the application.
 * No encryption — just signature verification by the ROM.
 *
 * Based on pico-examples/bootloaders/encrypted/enc_bootloader.c
 * Copyright (c) 2023 Raspberry Pi (Trading) Ltd.
 * SPDX-License-Identifier: BSD-3-Clause
 */

#include <string.h>
#include "pico/stdlib.h"
#include "pico/bootrom.h"
#include "boot/picobin.h"

// Silent bootloader — no stdio init. Initializing USB stdio here leaks
// peripheral state across rom_chain_image and prevents the chained app from
// cleanly enumerating USB. If diagnostics are needed, wire up UART to a
// dedicated pin and swap back in stdio_init_all() + printfs.

static __attribute__((aligned(4))) uint8_t workarea[4 * 1024];

int main() {
    int rc = rom_load_partition_table(workarea, sizeof(workarea), false);
    if (rc) {
        reset_usb_boot(0, 0);
    }

    rc = rom_pick_ab_partition_during_update((uint32_t *)workarea, sizeof(workarea), 0);
    if (rc < 0) {
        reset_usb_boot(0, 0);
    }
    uint8_t boot_partition = (uint8_t)rc;

    rc = rom_get_partition_table_info(
        (uint32_t *)workarea, 0x8,
        PT_INFO_PARTITION_LOCATION_AND_FLAGS | PT_INFO_SINGLE_PARTITION | (boot_partition << 24));
    if (rc != 3) {
        // No valid partition info — chaining to flash[0] would recurse into
        // this bootloader. Drop to BOOTSEL so the host can recover.
        reset_usb_boot(0, 0);
    }

    uint16_t first_sector = (((uint32_t *)workarea)[1] & PICOBIN_PARTITION_LOCATION_FIRST_SECTOR_BITS)
                            >> PICOBIN_PARTITION_LOCATION_FIRST_SECTOR_LSB;
    uint16_t last_sector  = (((uint32_t *)workarea)[1] & PICOBIN_PARTITION_LOCATION_LAST_SECTOR_BITS)
                            >> PICOBIN_PARTITION_LOCATION_LAST_SECTOR_LSB;
    uint32_t data_start_addr = first_sector * 0x1000;
    uint32_t data_size = ((last_sector + 1) - first_sector) * 0x1000;

    rom_chain_image(
        workarea,
        sizeof(workarea),
        XIP_BASE + data_start_addr,
        data_size);

    // rom_chain_image only returns on failure — drop to BOOTSEL.
    reset_usb_boot(0, 0);
}
