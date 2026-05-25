#ifndef CONDUIT_DIAG_H
#define CONDUIT_DIAG_H

#include <stdint.h>
#include <stdbool.h>

// Core-1 liveness counter. Bumped once per netif_rmii_ethernet_poll()
// iteration by the wrapper in main.c. Core 0 reads it from the
// diagnostic line every ~1 s; if the delta is zero, Core 1 is wedged.
//
// Atomic so a stall in the middle of a write doesn't corrupt the
// observation. RELAXED ordering is fine — we only need eventual
// visibility, not synchronization with anything else.
extern volatile uint32_t g_core1_iter;

// Print one heartbeat line to USB serial. Reads:
//   • Core 1 iter counter + delta since last print (Core 1 liveness)
//   • lwIP heap used/max and pbuf-pool used/max (memory exhaustion)
//   • TCP PCB census: active / time-wait / listen (PCB leak)
//   • lwIP link RX / TX packet totals + delta (MAC stall — link
//     reports up but nothing flows)
//   • netif link state, IP, ota-commit-pending
//
// Rate-limit / scheduling is the caller's problem — this is just the
// "gather + format + printf" half. main() calls it once per
// DIAG_PRINT_EVERY tick.
void diag_print_line(void);

// Walk lwIP's three TCP-PCB lists (active, time-wait, listen) and
// fill `*active`, `*tw`, `*listen` with the counts. Cheap (lists are
// at most a few items each), no allocation. Exposed so the HTTP
// /api/status JSON builder can include the census in an out-of-band
// fetch — USB serial isn't always available when a wedge is the
// thing being diagnosed, so the same numbers must also live in JSON.
void conduit_diag_count_tcp_pcbs(unsigned *active, unsigned *tw, unsigned *listen);

#endif /* CONDUIT_DIAG_H */
