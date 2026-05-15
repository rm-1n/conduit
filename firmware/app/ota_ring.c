// ota_ring.c — see ota_ring.h for the contract.
//
// Mirrors the spinlock-protected SPSC pattern in log_buffer.c and
// data_buffer.c: monotonic absolute-byte head/tail counters, bit-mask
// wrap on power-of-two storage, single spinlock guarding both ends.
// Lock holds are short (<= 512-byte memcpy ≈ 5 µs on RP2350) so
// contention is negligible even at line-rate ingress.
//
// Host build (firmware/tests/test_ota_ring.c) compiles with
// -DOTA_RING_HOSTTEST so we don't need pico/sync.h on the host
// toolchain.

#include "ota_ring.h"

#include <string.h>

#ifdef OTA_RING_HOSTTEST
typedef int spin_lock_t;
static spin_lock_t g_lock_storage = 0;
static inline uint32_t spin_lock_blocking(spin_lock_t *l) { (void)l; return 0; }
static inline void     spin_unlock(spin_lock_t *l, uint32_t irq) { (void)l; (void)irq; }
static inline spin_lock_t *spin_lock_instance(int n) { (void)n; return &g_lock_storage; }
static inline int      next_striped_spin_lock_num(void) { return 0; }
#else
#include "pico/sync.h"
#endif

_Static_assert((OTA_RING_SIZE & (OTA_RING_SIZE - 1)) == 0,
               "OTA_RING_SIZE must be a power of two");

// Future-proofing: if someone bumps TCP_WND past the ring size the
// design breaks silently — backpressure would fire on every packet and
// we'd be back to the old throughput. Catch it at compile time.
#ifdef TCP_WND
_Static_assert(OTA_RING_SIZE > TCP_WND,
               "OTA_RING_SIZE must exceed TCP_WND so a full window fits with slack");
#endif

#define UF2_BLOCK_BYTES 512u

static uint8_t  g_ring[OTA_RING_SIZE] __attribute__((aligned(4)));
static volatile uint32_t g_head = 0;     // next write offset (monotonic)
static volatile uint32_t g_tail = 0;     // next read offset  (monotonic)
static volatile uint32_t g_short_writes = 0;
static spin_lock_t *g_lock = NULL;
static int g_inited = 0;

void ota_ring_init(void) {
    if (g_inited) return;
    g_lock = spin_lock_instance(next_striped_spin_lock_num());
    g_inited = 1;
}

void ota_ring_reset(void) {
    if (!g_inited) return;
    uint32_t irq = spin_lock_blocking(g_lock);
    g_head = 0;
    g_tail = 0;
    // Note: g_short_writes is monotonic-since-boot for diag clarity.
    spin_unlock(g_lock, irq);
}

size_t ota_ring_write(const uint8_t *data, size_t len) {
    if (!g_inited || len == 0) return 0;
    uint32_t irq = spin_lock_blocking(g_lock);
    uint32_t used = g_head - g_tail;
    uint32_t free = OTA_RING_SIZE - used;
    size_t   take = (len < free) ? len : free;
    for (size_t i = 0; i < take; i++) {
        g_ring[(g_head + i) & (OTA_RING_SIZE - 1)] = data[i];
    }
    g_head += (uint32_t)take;
    if (take < len) g_short_writes++;
    spin_unlock(g_lock, irq);
    return take;
}

size_t ota_ring_drain_one_block(uint8_t out_buf[512]) {
    if (!g_inited || out_buf == NULL) return 0;
    uint32_t irq = spin_lock_blocking(g_lock);
    uint32_t used = g_head - g_tail;
    if (used < UF2_BLOCK_BYTES) {
        spin_unlock(g_lock, irq);
        return 0;
    }
    for (size_t i = 0; i < UF2_BLOCK_BYTES; i++) {
        out_buf[i] = g_ring[(g_tail + i) & (OTA_RING_SIZE - 1)];
    }
    g_tail += UF2_BLOCK_BYTES;
    spin_unlock(g_lock, irq);
    return UF2_BLOCK_BYTES;
}

size_t ota_ring_used(void) {
    if (!g_inited) return 0;
    uint32_t irq = spin_lock_blocking(g_lock);
    uint32_t used = g_head - g_tail;
    spin_unlock(g_lock, irq);
    return used;
}

size_t ota_ring_free_space(void) {
    if (!g_inited) return OTA_RING_SIZE;
    uint32_t irq = spin_lock_blocking(g_lock);
    uint32_t used = g_head - g_tail;
    spin_unlock(g_lock, irq);
    return OTA_RING_SIZE - used;
}

uint32_t ota_ring_total_written(void) {
    return __atomic_load_n(&g_head, __ATOMIC_RELAXED);
}

uint32_t ota_ring_total_drained(void) {
    return __atomic_load_n(&g_tail, __ATOMIC_RELAXED);
}

uint32_t ota_ring_short_writes(void) {
    return __atomic_load_n(&g_short_writes, __ATOMIC_RELAXED);
}
