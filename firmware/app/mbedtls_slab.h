// mbedtls_slab.h — static slab allocator for mbedtls's two per-session
// big buffers (IN ~16 KB, OUT ~8 KB).
//
// The lwIP heap (MEM_SIZE = 192 KB) fragments after ~5 OTA cycles because
// each fresh TLS handshake calloc's a 16 KB + 8 KB pair, the connection
// closes, the pair is freed, but lwIP's mem_malloc cannot reliably hand
// back a contiguous 16 KB block to the next handshake. Aggregate free is
// fine, contiguous free is not — `mbedtls_ssl_setup()` returns ERR_MEM
// and the HTTPS endpoint goes silent ("Device did not respond").
//
// Pulling these two sizes off the lwIP heap and into fixed slots
// eliminates the fragmentation at its source. Every other (smaller)
// mbedtls allocation still goes through mem_malloc, where small
// allocations don't fragment the heap meaningfully.
//
// Install with `mbedtls_platform_set_calloc_free(conduit_mbedtls_calloc,
// conduit_mbedtls_free)` AFTER `altcp_tls_create_config_*` returns —
// pico-sdk's `altcp_mbedtls_mem_init` sets the hooks to its own
// `tls_malloc/tls_free` and we want our hooks to win.

#ifndef CONDUIT_MBEDTLS_SLAB_H
#define CONDUIT_MBEDTLS_SLAB_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

void *conduit_mbedtls_calloc(size_t c, size_t len);
void  conduit_mbedtls_free(void *ptr);

// Diagnostic counters surfaced via /api/cmd diag and conduit_diag.c so
// regressions are visible: if `miss` climbs, mbedtls is requesting a
// size we don't recognize and we've fallen back to mem_malloc — likely
// because mbedtls's MBEDTLS_SSL_*_BUFFER_LEN formula changed under us
// or someone bumped MBEDTLS_SSL_*_CONTENT_LEN without updating slab.h.
typedef struct {
    unsigned in_hits;        // 16 KB slab grants
    unsigned out_hits;       // 8 KB slab grants
    unsigned passthrough;    // < both sizes, routed to mem_malloc
    unsigned exhausted_in;   // 16 KB slab full, returned NULL
    unsigned exhausted_out;  // 8 KB slab full, returned NULL
} conduit_mbedtls_slab_stats_t;

void conduit_mbedtls_slab_stats(conduit_mbedtls_slab_stats_t *out);

#ifdef __cplusplus
}
#endif

#endif // CONDUIT_MBEDTLS_SLAB_H
