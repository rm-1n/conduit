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

// Slot counts — 3 covers the steady-state concurrent TLS session
// count (2 long-lived streams + 1 short-lived control req).
//
// Transient overshoots (e.g. OTA precheck while streams are alive)
// will return NULL from the slab; altcp_mbedtls_setup propagates
// ERR_MEM and RSTs the new SYN, which the peer's retry layer handles.
// That's GRACEFUL — vs. heap saturation which RSTs every concurrent
// session at once. Trading off slab capacity for MEM_SIZE budget is
// the right call: heap saturation = "stream pane goes dark", slab
// exhaustion = "one retry needed".
//
// 3 slots × (16640 + 8448) ≈ 75 KB static SRAM. The extra 25 KB
// (vs 4 slots) gets reinvested in MEM_SIZE (see lwipopts.h).
#define CONDUIT_SLAB_SLOTS 3

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

    // Fallback for small mbedtls allocations (handshake state,
    // ciphersuite info, session scratch). Sized at < 1 KB each but
    // ~10 KB total per active TLS session. Goes to lwIP heap — must
    // stay symmetric with the SDK's own tls_malloc/tls_free path that
    // wraps the first cert-chain allocations during boot (we install
    // OUR hook AFTER altcp_tls_create_config*, so any pointer mbedtls
    // hands us afterwards may have come from either allocator and the
    // pointer arithmetic has to match).
    //
    // Heap pressure is addressed via MEM_SIZE bump in lwipopts.h
    // rather than re-routing mbedtls's small allocs to libc — see
    // commit message for the failed-boot diagnosis on the libc route.
    stats.passthrough++;
    void *p = mem_malloc((mem_size_t)total);
    if (p) memset(p, 0, total);
    return p;
}

void conduit_mbedtls_free(void *ptr) {
    if (!ptr) return;

    // Pointer-equality match against slot bases. Non-slot pointers
    // came from the lwIP-heap fallback path.
    for (int i = 0; i < CONDUIT_SLAB_SLOTS; i++) {
        if (ptr == in_slab[i])  { in_used[i]  = false; return; }
        if (ptr == out_slab[i]) { out_used[i] = false; return; }
    }
    mem_free(ptr);
}

void conduit_mbedtls_slab_stats(conduit_mbedtls_slab_stats_t *out) {
    if (out) *out = stats;
}
