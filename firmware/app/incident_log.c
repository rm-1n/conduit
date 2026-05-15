// incident_log.c — see incident_log.h for the design rationale.

#include "incident_log.h"

#include "dev_log.h"

#include <string.h>

#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "pico/flash.h"
#include "hardware/flash.h"
#include "hardware/regs/addressmap.h"   // XIP_BASE
#include "hardware/sync.h"
#include "hardware/watchdog.h"

#include "lwip/stats.h"
#include "lwip/tcp.h"
#include "lwip/priv/tcp_priv.h"

#include "conduit_version.h"            // CONDUIT_BINARY_VERSION_MAJOR/MINOR

// Defined in main.c — Core 1 liveness counter, ticked every loop pass.
extern volatile uint32_t g_core1_iter;

#define INCIDENT_MAGIC                  0xC0DEF1AFu

// One sector at the very end of flash. Above the IDENTITY partition
// (003f0000-003f2000) and far above either firmware partition. The
// remaining tail (003f2000–003ff000) is unpartitioned scratch; we
// claim only the last 4 KB so future code can use the rest.
//
// MUST be read via XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE (0x1C000000)
// rather than plain XIP_BASE (0x10000000). The bootrom narrows the
// XIP cache to the booted partition's range after rom_load_partition_table;
// cache misses to addresses outside that range HardFault. The
// no-cache aperture bypasses the cache and reads directly from flash.
// See identity.c for the same pattern. `flash_start_xip()` (called
// from conduit_identity_load() before multicore_launch_core1) already
// restored full-flash XIP coverage, so the no-cache reads work here.
#define INCIDENT_LOG_FLASH_OFFSET       (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE)
#define INCIDENT_LOG_XIP_PTR            ((const uint8_t *)(XIP_NOCACHE_NOALLOC_NOTRANSLATE_BASE \
                                                          + INCIDENT_LOG_FLASH_OFFSET))
#define INCIDENT_RECORDS_PER_SECTOR     (FLASH_SECTOR_SIZE / FLASH_PAGE_SIZE)

_Static_assert(INCIDENT_RECORDS_PER_SECTOR == 16,
               "expected 16 records per 4 KB sector with 256 B pages");

// ---- Read helpers ---------------------------------------------------------

static const incident_record_t *slot_ptr(unsigned i) {
    return (const incident_record_t *)(INCIDENT_LOG_XIP_PTR + i * FLASH_PAGE_SIZE);
}

static bool slot_written(const incident_record_t *r) {
    return r->magic == INCIDENT_MAGIC;
}

unsigned incident_log_count(void) {
    unsigned n = 0;
    for (unsigned i = 0; i < INCIDENT_RECORDS_PER_SECTOR; i++) {
        if (slot_written(slot_ptr(i))) n++;
        else break;     // append-only: first erased page = end
    }
    return n;
}

const incident_record_t *incident_log_get(unsigned i) {
    if (i >= INCIDENT_RECORDS_PER_SECTOR) return NULL;
    const incident_record_t *r = slot_ptr(i);
    return slot_written(r) ? r : NULL;
}

// ---- Forensic snapshot helpers --------------------------------------------

static uint32_t snapshot_heap_used(void) {
#if MEM_STATS
    return (uint32_t)lwip_stats.mem.used;
#else
    return 0;
#endif
}

static uint32_t snapshot_pcb_active(void) {
    unsigned a = 0;
    for (struct tcp_pcb *p = tcp_active_pcbs; p; p = p->next) a++;
    return a;
}

static void fill_record(incident_record_t *r, uint16_t cause, uint32_t c1, const char *msg) {
    memset(r, 0xFF, sizeof *r);  // pre-fill with the erased pattern; only
                                 // the explicit fields below get written
    r->magic          = INCIDENT_MAGIC;
    r->version        = 1;
    r->cause          = cause;
    r->uptime_ms      = (uint32_t)to_ms_since_boot(get_absolute_time());
    r->c1_value       = c1;
    r->heap_used      = snapshot_heap_used();
    r->pcb_active     = snapshot_pcb_active();
    r->binary_version = ((uint32_t)CONDUIT_BINARY_VERSION_MAJOR << 16) |
                        ((uint32_t)CONDUIT_BINARY_VERSION_MINOR & 0xFFFFu);
    if (msg) {
        size_t n = strnlen(msg, sizeof r->msg - 1);
        memcpy(r->msg, msg, n);
        r->msg[n] = '\0';
    } else {
        r->msg[0] = '\0';
    }
}

// ---- Flash write paths ----------------------------------------------------

// Both writers share these two helpers; the only difference is whether
// they're invoked through flash_safe_execute (cooperative) or directly
// after a Core 1 reset (emergency).

typedef struct {
    uint32_t        offset;
    const uint8_t  *page_buf;
} program_args_t;

static void do_erase_sector(void *arg) {
    (void)arg;
    flash_range_erase(INCIDENT_LOG_FLASH_OFFSET, FLASH_SECTOR_SIZE);
}

static void do_program_page(void *arg) {
    program_args_t *a = (program_args_t *)arg;
    flash_range_program(a->offset, a->page_buf, FLASH_PAGE_SIZE);
}

// Build the page buffer + figure out which slot to write. Caller does
// the actual erase/program — split out so emergency and cooperative
// paths share it.
static int prep_write(uint16_t cause, uint32_t c1, const char *msg,
                      uint8_t page_buf[FLASH_PAGE_SIZE], int *out_slot,
                      bool *out_need_erase) {
    int slot = -1;
    for (unsigned i = 0; i < INCIDENT_RECORDS_PER_SECTOR; i++) {
        if (!slot_written(slot_ptr(i))) { slot = (int)i; break; }
    }
    *out_need_erase = false;
    if (slot < 0) {
        // Sector full — wrap. Caller will erase first.
        slot = 0;
        *out_need_erase = true;
    }
    *out_slot = slot;

    incident_record_t rec;
    fill_record(&rec, cause, c1, msg);
    memset(page_buf, 0xFF, FLASH_PAGE_SIZE);
    memcpy(page_buf, &rec, sizeof rec);
    return 0;
}

int incident_log_append(incident_cause_t cause, const char *msg) {
    uint32_t c1 = __atomic_load_n(&g_core1_iter, __ATOMIC_RELAXED);
    static uint8_t page_buf[FLASH_PAGE_SIZE] __attribute__((aligned(4)));
    int slot;
    bool need_erase;
    int prc = prep_write((uint16_t)cause, c1, msg, page_buf, &slot, &need_erase);
    if (prc != 0) return prc;

    if (need_erase) {
        int rc = flash_safe_execute(do_erase_sector, NULL, 5000);
        if (rc != PICO_OK) {
            DEV_LOG("[incident] erase failed rc=%d\n", rc);
            return -1;
        }
    }
    program_args_t args = {
        .offset   = INCIDENT_LOG_FLASH_OFFSET + (uint32_t)slot * FLASH_PAGE_SIZE,
        .page_buf = page_buf,
    };
    int rc = flash_safe_execute(do_program_page, &args, 5000);
    if (rc != PICO_OK) {
        DEV_LOG("[incident] program failed rc=%d\n", rc);
        return -1;
    }
    DEV_LOG("[incident] appended cause=%u slot=%d msg=\"%s\"\n",
            (unsigned)cause, slot, msg ? msg : "");
    return 0;
}

void incident_log_append_emergency(incident_cause_t cause, const char *msg) {
    // Core 1 is presumed wedged. flash_safe_execute would hang waiting
    // for Core 1 to enter the lockout state, so we skip it. Force-reset
    // Core 1 first so it stops touching anything, then write directly.
    multicore_reset_core1();

    uint32_t c1 = __atomic_load_n(&g_core1_iter, __ATOMIC_RELAXED);
    static uint8_t page_buf[FLASH_PAGE_SIZE] __attribute__((aligned(4)));
    int slot;
    bool need_erase;
    if (prep_write((uint16_t)cause, c1, msg, page_buf, &slot, &need_erase) != 0) return;

    uint32_t saved = save_and_disable_interrupts();
    if (need_erase) {
        flash_range_erase(INCIDENT_LOG_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    }
    flash_range_program(INCIDENT_LOG_FLASH_OFFSET +
                        (uint32_t)slot * FLASH_PAGE_SIZE,
                        page_buf, FLASH_PAGE_SIZE);
    restore_interrupts(saved);
    // Caller will reboot immediately; nothing further to do.
}

int incident_log_clear(void) {
    int rc = flash_safe_execute(do_erase_sector, NULL, 5000);
    if (rc != PICO_OK) {
        DEV_LOG("[incident] clear failed rc=%d\n", rc);
        return -1;
    }
    return 0;
}

// ---- Boot-time scan -------------------------------------------------------

static const char *cause_str(uint16_t c) {
    switch (c) {
        case INCIDENT_BOOT:              return "boot";
        case INCIDENT_CORE1_WEDGE:       return "core1-wedge";
        case INCIDENT_HW_WATCHDOG_RESET: return "hw-watchdog";
        case INCIDENT_OTA_ROLLBACK:      return "ota-rollback";
        case INCIDENT_MANUAL:            return "manual";
        default:                         return "?";
    }
}

// Latched at init for the deferred auto-record (see comment in
// incident_log_init).
static bool g_pending_hw_watchdog_record = false;

void incident_log_init(void) {
    unsigned n = incident_log_count();
    DEV_LOG("[incident] %u prior records on boot\n", n);
    for (unsigned i = 0; i < n; i++) {
        const incident_record_t *r = incident_log_get(i);
        if (!r) break;
        DEV_LOG("[incident] #%u %s uptime=%lums c1=%lu bv=%u.%u msg=\"%.*s\"\n",
                i, cause_str(r->cause),
                (unsigned long)r->uptime_ms,
                (unsigned long)r->c1_value,
                (unsigned)(r->binary_version >> 16),
                (unsigned)(r->binary_version & 0xFFFFu),
                (int)sizeof r->msg, r->msg);
    }
    // Defer the hw-watchdog-record write to post_boot_tick: flash_safe_execute
    // can't run until both cores' core_init handshake is complete.
    if (watchdog_caused_reboot()) {
        bool dup = false;
        if (n > 0) {
            const incident_record_t *last = incident_log_get(n - 1);
            if (last && last->cause == INCIDENT_CORE1_WEDGE &&
                last->uptime_ms < 60000) {
                dup = true;
            }
        }
        if (!dup) g_pending_hw_watchdog_record = true;
    }
}

void incident_log_post_boot_tick(void) {
    if (!g_pending_hw_watchdog_record) return;
    g_pending_hw_watchdog_record = false;
    incident_log_append(INCIDENT_HW_WATCHDOG_RESET, "watchdog reset");
}
