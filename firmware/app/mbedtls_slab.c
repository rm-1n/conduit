// mbedtls_slab.c — see mbedtls_slab.h for rationale.

#include "mbedtls_slab.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "lwip/mem.h"

// Pull in our project mbedtls config so MBEDTLS_SSL_*_CONTENT_LEN
// resolve to the same values mbedtls itself sees.
#include "mbedtls/build_info.h"

// mbedtls 3.x's IN/OUT buffer length is
//   HEADER_LEN(13) + PAYLOAD_OVERHEAD + IN_CONTENT_LEN
// where PAYLOAD_OVERHEAD = max IV + max MAC + padding + explicit IV.
// The exact macro lives in library/ssl_misc.h, which is mbedtls-internal
// and not on our include path. We pre-compute a safe upper bound using
// public macros and match by RANGE: any allocation between
// CONTENT_LEN + 1 and CONTENT_LEN + SAFETY is treated as the IN/OUT
// buffer. SAFETY = 256 covers the worst-case overhead in any cipher
// suite we have configured (AEAD: 16 IV + 16 explicit IV + 16 tag;
// CBC: 16 IV + 48 MAC + 256 padding) plus headroom for mbedtls
// internals to grow.
#define CONDUIT_SLAB_SAFETY      256
#define CONDUIT_SLAB_IN_SIZE     (MBEDTLS_SSL_IN_CONTENT_LEN  + CONDUIT_SLAB_SAFETY)
#define CONDUIT_SLAB_OUT_SIZE    (MBEDTLS_SSL_OUT_CONTENT_LEN + CONDUIT_SLAB_SAFETY)

// A request hits the IN slab if size ∈ [IN_CONTENT_LEN+1, IN_SIZE].
// Strictly greater than CONTENT_LEN because mbedtls always wraps a
// content buffer with at least the 13-byte record header before
// allocating; anything ≤ CONTENT_LEN is some other smaller allocation.
#define IN_MATCH(sz)  ((sz) >  (size_t)MBEDTLS_SSL_IN_CONTENT_LEN  && \
                       (sz) <= (size_t)CONDUIT_SLAB_IN_SIZE)
#define OUT_MATCH(sz) ((sz) >  (size_t)MBEDTLS_SSL_OUT_CONTENT_LEN && \
                       (sz) <= (size_t)CONDUIT_SLAB_OUT_SIZE)

// Slot counts — sized for the worst observed concurrency:
//   1 OTA upload conn + 1 in-flight short control req
//   (status/commit/probe) + 2 long-lived streams (telemetry, console).
// = 4 concurrent TLS sessions. We do NOT need to size for the
// post-OTA stream-reopen transient because the IDE's pause-before-OTA
// sequence FINs both streams BEFORE the upload starts (see
// streams_gate.test.mjs); by the time the post-OTA stability probe
// fires and streams resume, the closed sessions have already had their
// slabs freed in altcp_mbedtls_dealloc → conduit_mbedtls_free.
//
// Each slot pair (16640 + 8448) = ~25 KB. 4 slots = ~100 KB static
// SRAM; comfortable against the RP2350's 520 KB total once MEM_SIZE
// is dropped back to 96 KB (see lwipopts.h).
#define CONDUIT_SLAB_SLOTS 4

// Static slabs. Aligned(8) so each row starts on an 8-byte boundary —
// mbedtls's internal buffer pointers are byte-addressed but downstream
// code can do aligned word loads.
static uint8_t in_slab[CONDUIT_SLAB_SLOTS][CONDUIT_SLAB_IN_SIZE]
    __attribute__((aligned(8)));
static uint8_t out_slab[CONDUIT_SLAB_SLOTS][CONDUIT_SLAB_OUT_SIZE]
    __attribute__((aligned(8)));

static bool in_used[CONDUIT_SLAB_SLOTS];
static bool out_used[CONDUIT_SLAB_SLOTS];

static conduit_mbedtls_slab_stats_t stats;

// All callbacks fire on the lwIP thread (Core 1); NO_SYS=1, no preemption.
// No locking needed.

void *conduit_mbedtls_calloc(size_t c, size_t len) {
    size_t total = c * len;
    if (total == 0) return NULL;

    if (IN_MATCH(total)) {
        for (int i = 0; i < CONDUIT_SLAB_SLOTS; i++) {
            if (!in_used[i]) {
                in_used[i] = true;
                memset(in_slab[i], 0, total);
                stats.in_hits++;
                return in_slab[i];
            }
        }
        stats.exhausted_in++;
        return NULL;
    }

    if (OUT_MATCH(total)) {
        for (int i = 0; i < CONDUIT_SLAB_SLOTS; i++) {
            if (!out_used[i]) {
                out_used[i] = true;
                memset(out_slab[i], 0, total);
                stats.out_hits++;
                return out_slab[i];
            }
        }
        stats.exhausted_out++;
        return NULL;
    }

    stats.passthrough++;
    void *p = mem_malloc((mem_size_t)total);
    if (p) memset(p, 0, total);
    return p;
}

void conduit_mbedtls_free(void *ptr) {
    if (!ptr) return;

    // Pointer-equality match against slot bases. mbedtls only ever
    // returns a pointer we handed it; non-slot pointers indicate the
    // allocation came from mem_malloc and we hand it back to lwIP.
    for (int i = 0; i < CONDUIT_SLAB_SLOTS; i++) {
        if (ptr == in_slab[i])  { in_used[i]  = false; return; }
        if (ptr == out_slab[i]) { out_used[i] = false; return; }
    }
    mem_free(ptr);
}

void conduit_mbedtls_slab_stats(conduit_mbedtls_slab_stats_t *out) {
    if (out) *out = stats;
}
