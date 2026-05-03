#include "log_buffer.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include "pico/sync.h"
#include "pico/time.h"

// Ring storage + monotonic byte counter. `total` is the absolute byte offset
// of the NEXT write; the ring contains bytes [total-LOG_BUFFER_SIZE, total).
// Any core can call log(); the spinlock serializes with the HTTP read path.
static uint8_t  g_ring[LOG_BUFFER_SIZE];
static volatile uint32_t g_total = 0;
static bool     g_inited = false;
static spin_lock_t *g_lock;
// Diagnostic — bumped at the very top of conduit_log() before any
// conditional. Pair with g_total to distinguish "conduit_log was never
// called" from "conduit_log was called but push_bytes silently dropped".
volatile uint32_t g_conduit_log_calls = 0;

#define LOG_LINE_MAX 256

static void push_bytes(const char *buf, size_t len) {
    if (!g_inited || len == 0) return;
    uint32_t irq = spin_lock_blocking(g_lock);
    for (size_t i = 0; i < len; i++) {
        g_ring[g_total & (LOG_BUFFER_SIZE - 1)] = (uint8_t)buf[i];
        g_total++;
    }
    spin_unlock(g_lock, irq);
}

void log_buffer_init(void) {
    if (g_inited) return;
    g_lock = spin_lock_instance(next_striped_spin_lock_num());
    g_inited = true;
}

void conduit_log(const char *fmt, ...) {
    g_conduit_log_calls++;
    // Each record is framed as "[<uptime_us>]\t<formatted>\n…". The prefix
    // is part of the same bytes pushed under the spinlock so a reader can
    // never see a torn record (timestamp without payload or vice versa).
    // Format into a single stack buffer — keeps the spinlock window short
    // and avoids any dynamic allocation. Lines longer than LOG_LINE_MAX
    // are truncated (still terminated / valid).
    char tmp[LOG_LINE_MAX];
    uint64_t us = to_us_since_boot(get_absolute_time());
    int prefix_n = snprintf(tmp, sizeof(tmp), "[%llu]\t", (unsigned long long)us);
    if (prefix_n < 0) return;
    if (prefix_n > (int)sizeof(tmp) - 1) prefix_n = (int)sizeof(tmp) - 1;
    va_list ap;
    va_start(ap, fmt);
    int payload_n = vsnprintf(tmp + prefix_n, sizeof(tmp) - prefix_n, fmt, ap);
    va_end(ap);
    if (payload_n < 0) payload_n = 0;
    int total = prefix_n + payload_n;
    if (total > (int)sizeof(tmp) - 1) total = (int)sizeof(tmp) - 1;
    push_bytes(tmp, (size_t)total);
}

size_t log_buffer_read(uint32_t since, uint8_t *out, size_t max,
                       uint32_t *out_next_cursor) {
    if (!g_inited || max == 0) {
        if (out_next_cursor) *out_next_cursor = g_total;
        return 0;
    }
    uint32_t irq = spin_lock_blocking(g_lock);
    uint32_t total = g_total;
    // Stale cursor — happens when a client (e.g. the browser log streamer)
    // resumes after the device rebooted: its `since` is from the previous
    // boot's total. Treat as "infinitely behind" so the fast-forward branch
    // below recovers cleanly instead of underflowing into the unwritten
    // tail of the ring.
    if (since > total) {
        since = (total > LOG_BUFFER_SIZE) ? (total - LOG_BUFFER_SIZE) : 0;
    }
    uint32_t behind = total - since;
    if (behind == 0) {
        spin_unlock(g_lock, irq);
        if (out_next_cursor) *out_next_cursor = total;
        return 0;
    }
    if (behind > LOG_BUFFER_SIZE) {
        // Client fell behind — fast-forward to the oldest retained byte.
        since = total - LOG_BUFFER_SIZE;
        behind = LOG_BUFFER_SIZE;
    }
    size_t to_copy = behind < max ? behind : max;
    for (size_t i = 0; i < to_copy; i++) {
        out[i] = g_ring[(since + i) & (LOG_BUFFER_SIZE - 1)];
    }
    uint32_t next = since + (uint32_t)to_copy;
    spin_unlock(g_lock, irq);
    if (out_next_cursor) *out_next_cursor = next;
    return to_copy;
}

uint32_t log_buffer_total_written(void) {
    return g_total;
}

uint32_t log_buffer_call_count(void) {
    return g_conduit_log_calls;
}
