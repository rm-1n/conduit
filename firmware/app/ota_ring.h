#ifndef OTA_RING_H
#define OTA_RING_H

#include <stdint.h>
#include <stddef.h>

// SPSC ring buffer that decouples the lwIP recv callback (Core 1
// producer) from the OTA flash writer (Core 0 consumer). Producer
// reports a partial accept when the ring fills up — http_recv uses the
// returned byte count for altcp_recved, which shrinks the advertised
// TCP window and naturally throttles the sender. No app-level
// chunking, no oversized buffer; TCP's own flow control is the
// feedback mechanism.

// Power of two, > TCP_WND with comfortable slack. With TCP_WND set to
// 16*MSS (~23 KB) so one full 16 KB TLS record always fits in-window,
// the ring needs to be safely above 23 KB. 32 KB at ~6 % of SRAM is
// cheap insurance against pathological back-pressure timing.
#define OTA_RING_SIZE 32768u

void   ota_ring_init(void);
void   ota_ring_reset(void);

// Producer (Core 1, recv callback). Copies up to `len` bytes into the
// ring; may copy fewer when free space is short. Returns the number of
// bytes actually stored. Caller MUST honor the return value when
// computing altcp_recved — bytes not stored stay unacked at the TCP
// layer and will be retransmitted by the peer.
size_t ota_ring_write(const uint8_t *data, size_t len);

// Consumer (Core 0, main loop). If at least 512 bytes are buffered,
// copies one UF2 block into out_buf and returns 512. Otherwise
// returns 0 — the consumer will retry on the next iteration. Never
// returns a partial block (the OTA write path needs whole UF2 frames).
size_t ota_ring_drain_one_block(uint8_t out_buf[512]);

size_t   ota_ring_used(void);
size_t   ota_ring_free_space(void);
uint32_t ota_ring_total_written(void);
uint32_t ota_ring_total_drained(void);
uint32_t ota_ring_short_writes(void);  // partial-accept event count

#endif // OTA_RING_H
