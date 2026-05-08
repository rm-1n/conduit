// discovery.h — UDP multicast device-discovery beacon.
//
// Once initialised, broadcasts a small JSON payload to a fixed
// multicast group at 1 Hz. The conduit-cli `discover` subcommand
// listens for these to find devices by their unique-id without
// scanning the subnet. Replaces the IDE's old /24 HTTP-status sweep.
//
// Wire format: a single UDP datagram per send, containing
//
//     {"id":"<unique-id>","ip":"<dotted>","name":"","v":"<MAJOR.MINOR>"}
//
// The id is the per-device identifier (factory-provisioned; for now
// derived from pico_get_unique_board_id() until the IDENTITY
// partition lands in Phase 2). The ip is whatever lwIP currently has
// assigned. Name is an empty placeholder until the user can set a
// per-device label.
//
// Multicast group/port live in discovery.c so they can be tuned in
// one place. The current values (239.255.42.42:5354) are an
// administratively-scoped IPv4 multicast group with a port chosen to
// avoid collisions with mDNS (5353) and SSDP (1900).
//
// Threading: discovery_init() is called from Core 0 during boot,
// before Core 1 is launched. The actual send happens via lwIP
// sys_timeout, which runs from sys_check_timeouts() on Core 1 — the
// same thread that owns every other lwIP call. Never invoke
// discovery_* APIs after Core 1 is up except via sys_timeout.

#ifndef CONDUIT_DISCOVERY_H
#define CONDUIT_DISCOVERY_H

#include <stdint.h>

// Initialise the multicast UDP pcb and arm the 1 Hz heartbeat.
// Must be called AFTER network_init() so a netif and IP exist, and
// BEFORE multicore_launch_core1() so the lwIP-state mutation here
// happens on the same thread the rest of init runs on.
//
// Returns 0 on success, negative on failure (e.g. udp_new exhausted
// the PCB pool). On failure, the rest of the firmware boots normally
// — discovery is a convenience, not a hard dependency.
int discovery_init(void);

// Cumulative beacon counters. `*ok_count` increments once per
// successful udp_sendto; `*fail_count` increments once per failure
// (pbuf_alloc exhaustion or udp_sendto err_t!=ERR_OK). Both are
// monotonic 32-bit counters that wrap. Used by diag.c to fold
// discovery activity into the per-second heartbeat so the user can
// confirm sends are happening without catching boot-time logs.
//
// Safe to call from any thread — counters are plain uint32_t reads;
// staleness is bounded by one tick on the lwIP thread.
void discovery_get_stats(uint32_t *ok_count, uint32_t *fail_count);

#endif // CONDUIT_DISCOVERY_H
