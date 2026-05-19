#include "data_buffer.h"
#include "log_buffer.h"

#include <string.h>
#include <stdio.h>
#include "pico/sync.h"
#include "pico/time.h"

// Ring + monotonic write counter (absolute byte offset of the next write).
// The schema registry is a small array of null-terminated names, one slot
// per msg_id. Name slot 0 means "unregistered" — browser falls back to
// "msg_<id>" for display.
static uint8_t  g_ring[DATA_BUFFER_SIZE];
static volatile uint32_t g_total = 0;
static spin_lock_t *g_lock;
static bool     g_inited = false;

// Ring-overrun diagnostics. Both counters increment ONLY inside the
// drop-oldest clamp in data_buffer_read; they record the cases where
// the producer wrote so far ahead of the consumer that some bytes
// got overwritten before the consumer could send them.
//
//   g_evictions_total       — how many read() calls hit the clamp.
//                             Each one corresponds to ≥1 "gap" the
//                             browser observes in uptime_us.
//   g_evicted_bytes_total   — cumulative bytes silently dropped
//                             across all clamp events. Divide by
//                             ~20 (typical record size) for an
//                             approximate record count.
//
// Surfaced via /api/status (see firmware/app/http_server.c) so a
// long recording's HDF5 export can be cross-referenced: if the
// counter matches the gap count, the gaps are consumer-stall driven
// (browser fell behind, ring overflowed). If 0 and gaps exist, the
// device emit loop itself paused — look at user code or core-1
// scheduling.
static volatile uint32_t g_evictions_total     = 0;
static volatile uint32_t g_evicted_bytes_total = 0;

// Monotonic schema-registry version. Incremented on each NEW slot
// allocation in conduit_data_lookup_or_register (NOT on cache hits).
// ws_server_poll() (Core 1) reads this and compares against its
// per-conn last-seen value to know when to push a fresh STATUS frame
// with the updated data_schema. The previous design tried to call
// http_server_notify_event() directly from this file, but
// conduit_data_lookup_or_register runs on Core 0 (user code) and
// http_conn_pool is Core-1-owned state — the cross-core write was a
// race that occasionally left status_dirty set on a half-torn-down
// conn, producing intermittent WS death (chart blanks on every
// reconnect that fell back to a cold TLS handshake).
//
// A bare volatile uint32_t is sufficient signal here: a single
// 32-bit write is atomic on Cortex-M33, Core 1 only reads it (one
// direction of cross-core sharing), and a missed-by-one tick is
// fine because the next poll round will see the same delta.
static volatile uint32_t g_schema_version = 0;

static char     g_names[CONDUIT_DATA_MAX_NAMES][CONDUIT_DATA_NAME_MAX];

// Per-session "already warned about this name" set. Bounded so a tight
// loop emitting a bad name can't flood the log buffer. Pointer-equality
// match — works perfectly for string-literal names from the transmit()
// macro (the common case); for non-literal names you may see a few extra
// warnings, harmless.
#define CONDUIT_WARNED_MAX 8
static const char *g_warned[CONDUIT_WARNED_MAX];
static uint8_t g_warned_count = 0;
static uint8_t g_warned_next  = 0;

size_t conduit_dtype_size(conduit_dtype_t dtype) {
    switch (dtype) {
        case CONDUIT_DTYPE_I8:
        case CONDUIT_DTYPE_U8:   return 1;
        case CONDUIT_DTYPE_I16:
        case CONDUIT_DTYPE_U16:  return 2;
        case CONDUIT_DTYPE_I32:
        case CONDUIT_DTYPE_U32:
        case CONDUIT_DTYPE_F32:  return 4;
        case CONDUIT_DTYPE_I64:
        case CONDUIT_DTYPE_U64:
        case CONDUIT_DTYPE_F64:  return 8;
        default: return 0;
    }
}

static void push_bytes_locked(const uint8_t *buf, size_t len) {
    for (size_t i = 0; i < len; i++) {
        g_ring[g_total & (DATA_BUFFER_SIZE - 1)] = buf[i];
        g_total++;
    }
}

void data_buffer_init(void) {
    if (g_inited) return;
    g_lock = spin_lock_instance(next_striped_spin_lock_num());
    memset(g_names, 0, sizeof(g_names));
    g_inited = true;
}

// UPPER_SNAKE_CASE: non-empty, ≤ CONDUIT_DATA_NAME_MAX-1 chars, first char
// must be A-Z (not a digit, not an underscore — keeps generated HDF5
// dataset names looking sensible), all chars in [A-Z0-9_].
static bool is_valid_name(const char *name) {
    if (!name) return false;
    size_t len = 0;
    while (name[len] != '\0' && len < CONDUIT_DATA_NAME_MAX) len++;
    if (len == 0 || len > CONDUIT_DATA_NAME_MAX - 1) return false;
    if (!(name[0] >= 'A' && name[0] <= 'Z')) return false;
    for (size_t i = 0; i < len; i++) {
        char c = name[i];
        bool ok = (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
        if (!ok) return false;
    }
    return true;
}

// Returns true the first time we see a given bad-name pointer this session.
static bool warn_once(const char *name) {
    for (uint8_t i = 0; i < g_warned_count; i++) {
        if (g_warned[i] == name) return false;
    }
    if (g_warned_count < CONDUIT_WARNED_MAX) {
        g_warned[g_warned_count++] = name;
    } else {
        g_warned[g_warned_next] = name;
        g_warned_next = (uint8_t)((g_warned_next + 1) % CONDUIT_WARNED_MAX);
    }
    return true;
}

int conduit_data_lookup_or_register(const char *name) {
    if (!g_inited) return -1;
    if (!is_valid_name(name)) return -1;

    uint32_t irq = spin_lock_blocking(g_lock);
    for (uint16_t i = 0; i < CONDUIT_DATA_MAX_NAMES; i++) {
        if (g_names[i][0] == '\0') continue;
        if (strcmp(g_names[i], name) == 0) {
            spin_unlock(g_lock, irq);
            return (int)i;
        }
    }
    for (uint16_t i = 0; i < CONDUIT_DATA_MAX_NAMES; i++) {
        if (g_names[i][0] == '\0') {
            size_t n = 0;
            while (name[n] != '\0' && n < CONDUIT_DATA_NAME_MAX - 1) n++;
            memcpy(g_names[i], name, n);
            g_names[i][n] = '\0';
            // Bump BEFORE releasing the lock so a Core 1 reader sees
            // an updated registry by the time it sees the new
            // version. Single atomic 32-bit write — no cross-core
            // walk of http_conn_pool from here (the previous design
            // did that and raced with Core 1's conn teardown).
            g_schema_version++;
            spin_unlock(g_lock, irq);
            return (int)i;
        }
    }
    spin_unlock(g_lock, irq);
    return -1;
}

// Build the framed record on the stack and push the whole thing under one
// spinlock hold so partial writes can't break framing for concurrent
// readers.
static void emit_record(uint16_t msg_id, conduit_dtype_t dtype, uint16_t n, const void *src) {
    if (!src) return;
    size_t esz = conduit_dtype_size(dtype);
    if (esz == 0) return;
    size_t payload_bytes = (size_t)n * esz;
    size_t record_bytes = CONDUIT_DATA_RECORD_HEADER + payload_bytes;
    if (record_bytes > DATA_BUFFER_SIZE) return;

    uint8_t hdr[CONDUIT_DATA_RECORD_HEADER];
    uint64_t us = to_us_since_boot(get_absolute_time());
    hdr[0] = CONDUIT_DATA_MAGIC;
    hdr[1] = CONDUIT_DATA_VERSION;
    hdr[2] = (uint8_t)(msg_id & 0xFF);
    hdr[3] = (uint8_t)((msg_id >> 8) & 0xFF);
    hdr[4] = (uint8_t)dtype;
    hdr[5] = (uint8_t)(n & 0xFF);
    hdr[6] = (uint8_t)((n >> 8) & 0xFF);
    hdr[7] = 0; // reserved
    hdr[8]  = (uint8_t)(us & 0xFF);
    hdr[9]  = (uint8_t)((us >> 8) & 0xFF);
    hdr[10] = (uint8_t)((us >> 16) & 0xFF);
    hdr[11] = (uint8_t)((us >> 24) & 0xFF);
    hdr[12] = (uint8_t)((us >> 32) & 0xFF);
    hdr[13] = (uint8_t)((us >> 40) & 0xFF);
    hdr[14] = (uint8_t)((us >> 48) & 0xFF);
    hdr[15] = (uint8_t)((us >> 56) & 0xFF);

    uint32_t irq = spin_lock_blocking(g_lock);
    push_bytes_locked(hdr, CONDUIT_DATA_RECORD_HEADER);
    push_bytes_locked((const uint8_t *)src, payload_bytes);
    spin_unlock(g_lock, irq);
}

void _conduit_transmit_cached(int8_t *id_slot, const char *name,
                          conduit_dtype_t dtype, uint16_t n, const void *src) {
    if (!g_inited) return;
    if (id_slot && *id_slot >= 0) {
        emit_record((uint16_t)(uint8_t)*id_slot, dtype, n, src);
        return;
    }
    int id = conduit_data_lookup_or_register(name);
    if (id < 0) {
        if (warn_once(name)) {
            conduit_log("[poe] invalid telemetry name '%s' — must match "
                    "[A-Z][A-Z0-9_]{0,30}; or registry full (max %d)\n",
                    name ? name : "(null)", CONDUIT_DATA_MAX_NAMES);
        }
        return;
    }
    if (id_slot) *id_slot = (int8_t)id;
    emit_record((uint16_t)id, dtype, n, src);
}

size_t data_buffer_read(uint32_t since, uint8_t *out, size_t max,
                        uint32_t *out_next_cursor) {
    if (!g_inited || max == 0) {
        if (out_next_cursor) *out_next_cursor = g_total;
        return 0;
    }
    uint32_t irq = spin_lock_blocking(g_lock);
    uint32_t total = g_total;
    if (since > total) {
        since = total;
    }
    uint32_t behind = total - since;
    if (behind == 0) {
        spin_unlock(g_lock, irq);
        if (out_next_cursor) *out_next_cursor = total;
        return 0;
    }
    if (behind > DATA_BUFFER_SIZE) {
        // Producer wrote `behind - DATA_BUFFER_SIZE` bytes that the
        // consumer never got — they were overwritten in the ring
        // before the read() call arrived. Record the size of the
        // gap and the event count so /api/status can surface what
        // would otherwise be a silent drop. The increments happen
        // under the spin lock (we're still holding it from line
        // above), so the volatile reads from accessor functions
        // see consistent values.
        g_evicted_bytes_total += (behind - DATA_BUFFER_SIZE);
        g_evictions_total++;
        since = total - DATA_BUFFER_SIZE;
        behind = DATA_BUFFER_SIZE;
    }
    size_t to_copy = behind < max ? behind : max;
    for (size_t i = 0; i < to_copy; i++) {
        out[i] = g_ring[(since + i) & (DATA_BUFFER_SIZE - 1)];
    }
    uint32_t next = since + (uint32_t)to_copy;
    spin_unlock(g_lock, irq);
    if (out_next_cursor) *out_next_cursor = next;
    return to_copy;
}

uint32_t data_buffer_total_written(void) {
    return g_total;
}

uint32_t data_buffer_evictions_total(void) {
    return g_evictions_total;
}

uint32_t data_buffer_evicted_bytes_total(void) {
    return g_evicted_bytes_total;
}

uint32_t data_buffer_schema_version(void) {
    return g_schema_version;
}

size_t data_buffer_schema_json(char *out, size_t max) {
    if (max == 0) return 0;
    size_t pos = 0;
    if (pos + 1 < max) out[pos++] = '{';
    bool first = true;
    uint32_t irq = spin_lock_blocking(g_lock);
    for (uint16_t i = 0; i < CONDUIT_DATA_MAX_NAMES; i++) {
        if (g_names[i][0] == '\0') continue;
        int written = snprintf(out + pos, max - pos,
            "%s\"%u\":\"%s\"", first ? "" : ",", (unsigned)i, g_names[i]);
        if (written < 0 || (size_t)written >= max - pos) break;
        pos += (size_t)written;
        first = false;
    }
    spin_unlock(g_lock, irq);
    if (pos + 1 < max) out[pos++] = '}';
    if (pos < max) out[pos] = '\0';
    return pos;
}
