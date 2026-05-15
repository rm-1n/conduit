// incident_log.h — persistent flash log for forensic events that
// survive a reboot.
//
// Use cases this is built for:
//   - Core 1 watchdog tripped (lwIP/RMII thread wedged)
//   - Core 0 watchdog tripped (caught by the bootrom — we record the
//     event on next boot via watchdog_caused_reboot())
//   - OTA finalize crash (the new image hardfaulted before commit)
//   - Manual diag dump from `/api/incidents`
//
// Storage: last 4 KB sector of flash (PICO_FLASH_SIZE_BYTES - 4096).
// One incident record per FLASH_PAGE_SIZE (256 B) page so we can
// append without erasing — 16 records per sector, then we wrap by
// erasing and starting from page 0 (oldest-evict). Flash wear is a
// non-issue: incidents are rare (target: never).
//
// The record format is intentionally crash-resistant — writeable from
// either an emergency path (Core 0 about to reboot, Core 1 already
// dead) or a normal path (anywhere on Core 0 or Core 1).

#ifndef CONDUIT_INCIDENT_LOG_H
#define CONDUIT_INCIDENT_LOG_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Cause codes — keep stable across firmware versions. Reading code
// (web /api/incidents renderer) maps these to human strings.
typedef enum {
    INCIDENT_NONE              = 0,
    INCIDENT_BOOT              = 1,   // first boot after a reset (any cause)
    INCIDENT_CORE1_WEDGE       = 2,   // Core 0 detected Core 1 stuck >N s
    INCIDENT_HW_WATCHDOG_RESET = 3,   // bootrom reports watchdog reset (Core 0 wedged)
    INCIDENT_OTA_ROLLBACK      = 4,   // bootrom reports TBYB rollback
    INCIDENT_MANUAL            = 5,   // /api/incidents POST (test path)
} incident_cause_t;

// 256 bytes total — one flash page.
typedef struct __attribute__((packed)) {
    uint32_t magic;             // 0xC0DEF1AF — distinguishes a written record
                                // from an erased page (0xFFFFFFFF).
    uint16_t version;           // record schema version (currently 1)
    uint16_t cause;             // incident_cause_t cast to u16
    uint32_t uptime_ms;         // ms since boot at the moment of record
    uint32_t c1_value;          // g_core1_iter snapshot (forensic)
    uint32_t heap_used;         // lwIP MEM_SIZE used bytes (forensic)
    uint32_t pcb_active;        // count_tcp_pcbs active count (forensic)
    uint32_t binary_version;    // (major << 16) | minor — what was running
    uint32_t reserved[7];
    char     msg[200];          // free-form context, NUL-terminated
} incident_record_t;

_Static_assert(sizeof(incident_record_t) == 256,
               "incident_record_t must equal one flash page");

// Initialize — read existing incidents, log them to serial. If this
// boot followed a hardware watchdog reset, latch a pending record
// flag (the actual flash write is deferred to
// incident_log_post_boot_tick because flash_safe_execute can't run
// until both cores have completed their core_init handshake).
void incident_log_init(void);

// Call from the main loop once per tick AFTER both cores are fully
// up. If a watchdog-caused-reset record is pending from boot, it gets
// written here. Idempotent / cheap (one volatile read + early return
// in the no-op case).
void incident_log_post_boot_tick(void);

// Append from a normal context (Core 0 or Core 1). Uses
// flash_safe_execute to coordinate XIP cache disable. Returns 0 on
// success, negative on error (most likely "Core 1 didn't respond to
// the lockout request").
int incident_log_append(incident_cause_t cause, const char *msg);

// Append from an emergency context (we're about to reboot, the
// caller has already given up on Core 1's cooperation). Resets
// Core 1 first, disables interrupts, calls flash_range_* directly.
// Side effect: Core 1 is dead after this returns. Caller is expected
// to reboot immediately.
void incident_log_append_emergency(incident_cause_t cause, const char *msg);

// Read API — used by /api/incidents.
unsigned incident_log_count(void);
const incident_record_t *incident_log_get(unsigned index);

// Clear all records — erases the sector. Auth-gated at the HTTP layer.
int incident_log_clear(void);

#ifdef __cplusplus
}
#endif

#endif
