#pragma once

#include <stddef.h>
#include <stdint.h>

// Binary companion to log_buffer. Used for efficient streaming of sensor
// data (scalars and vectors). Records are timestamped on-device and
// framed; the browser reads them from GET /api/data?stream=1 and
// persists them alongside the text log into IndexedDB / HDF5.
//
// Wire format — each record is exactly 16 + n*sizeof(dtype) bytes:
//
//    offset  size  field
//    0       1     magic       = 0xFE
//    1       1     version     = 0x01
//    2       2     msg_id      LE u16
//    4       1     dtype       u8  (conduit_dtype_t)
//    5       2     n           LE u16 (element count, not bytes)
//    7       1     reserved    0
//    8       8     uptime_us   LE u64
//    16      ...   payload     n * element_size bytes
//
// Payload is raw little-endian elements (RP2350 and typical browsers
// agree). The browser uses DataView with littleEndian=true.

// 64 KB ring. We tried bumping it after observing 39 silent
// ring-evictions in a 9-hour recording, clustering at 10–16 s of
// gap each — but the worst-case gaps were too large for any
// realistic firmware buffer to absorb (256 KB blew BSS by 192 KB;
// 128 KB by 60 KB; on a 520 KB SRAM chip already loaded with
// MEM_SIZE=128 KB lwIP heap + mbedtls slab + the rest, there's
// just no room to grow the ring usefully).
//
// The bigger lever is browser-side: the multi-second stalls that
// drove the consumer to fall behind in the first place come from
// data_store.js's Float64Array doubling-growth strategy, which
// allocates 100s of MB and memcpy's the entire array every few
// minutes at long-session sizes. Eliminating those stalls keeps
// the consumer close to live, and the existing 1.6 s ring is
// plenty for the residual short stalls.
//
// What this commit DOES keep is the eviction telemetry — every
// drop-oldest clamp in data_buffer_read now increments
// g_evictions_total / g_evicted_bytes_total, surfaced through
// /api/status so any future silent loss is visible.
#define DATA_BUFFER_SIZE       65536    // must be a power of two
#define CONDUIT_DATA_MAX_NAMES     32
#define CONDUIT_DATA_NAME_MAX      32
#define CONDUIT_DATA_RECORD_HEADER 16
#define CONDUIT_DATA_MAGIC         0xFE
#define CONDUIT_DATA_VERSION       0x01

// Reserved msg_id used by http_server's stream keepalive: a 16-byte
// header with n=0 emitted at most every 500 ms when the data ring is
// otherwise idle, so the browser's stall watchdog has bytes to chew
// on even when user code isn't transmitting. The browser parser
// (web/telemetry.js drain()) skips records with this msg_id without
// pushing to the chart or store. Treated as reserved — `transmit()`
// will never assign it to a user channel because CONDUIT_DATA_MAX_NAMES
// is 32, well below 0xFFFF.
#define CONDUIT_DATA_KEEPALIVE_MSG_ID 0xFFFF

// Keep this enum in sync with the duplicate in
// web/assets/sdk/headers/include/conduit_user.h — both are part of the
// wire format.
typedef enum {
    CONDUIT_DTYPE_I8   = 0,
    CONDUIT_DTYPE_U8   = 1,
    CONDUIT_DTYPE_I16  = 2,
    CONDUIT_DTYPE_U16  = 3,
    CONDUIT_DTYPE_I32  = 4,
    CONDUIT_DTYPE_U32  = 5,
    CONDUIT_DTYPE_I64  = 6,
    CONDUIT_DTYPE_U64  = 7,
    CONDUIT_DTYPE_F32  = 8,
    CONDUIT_DTYPE_F64  = 9,
} conduit_dtype_t;

// Element size in bytes for each conduit_dtype_t, or 0 if the dtype is unknown.
size_t conduit_dtype_size(conduit_dtype_t dtype);

// Allocate the internal spinlock + zero the schema registry. Call once,
// after stdio is initialised. Idempotent.
void data_buffer_init(void);

// Look up `name` in the schema registry. If not present, validate it
// (UPPER_SNAKE_CASE, ≤31 chars, can't start with a digit) and allocate the
// next free slot. Returns the slot id (0..CONDUIT_DATA_MAX_NAMES-1) or -1 if
// the name is invalid or the registry is full. Thread-safe.
//
// Most user code never calls this directly — the `transmit(name, T, ptr)`
// macro in conduit_user.h caches the resolved id per call site so the
// lookup happens at most once per call site per boot.
int conduit_data_lookup_or_register(const char *name);

// Hot-path entry point invoked by the `transmit(...)` macro. Caches the
// resolved id in `*id_slot` (a `static int8_t = -1;` declared by the macro
// at each call site). Pass id_slot=NULL for callers that don't want
// caching.
//
// Behaviour:
//   *id_slot >= 0  → fast path: emit record under that id.
//   *id_slot <  0  → look up name, cache id, emit. If the name is
//                    invalid or the registry is full, emit a one-time
//                    warning to conduit_log and drop the call (id_slot stays
//                    -1 so subsequent calls keep failing fast).
void _conduit_transmit_cached(int8_t *id_slot, const char *name,
                          conduit_dtype_t dtype, uint16_t n, const void *src);

// Copy up to `max` bytes starting at absolute cursor `since` into `out`.
// Same semantics as log_buffer_read: fast-forwards a stale cursor to the
// oldest retained byte; returns 0 if caught up. Record boundaries are
// NOT preserved here — the HTTP server hands raw bytes to the client and
// the browser resyncs at the next magic byte if a reconnect happens.
size_t data_buffer_read(uint32_t since, uint8_t *out, size_t max,
                        uint32_t *out_next_cursor);

// Monotonic byte count since boot. Clients bootstrap their cursor from
// this (via the X-Data-Cursor response header).
uint32_t data_buffer_total_written(void);

// Serialize the schema registry as JSON into `out`. Returns bytes
// written (not including terminator). Output looks like:
//   {"0":"AIN0","2":"IMU_ACCEL","5":"TEMP_C"}
size_t data_buffer_schema_json(char *out, size_t max);

// Diagnostics — how many times the consumer fell so far behind that
// the producer overwrote ring contents before they could be sent
// (data_buffer_read clamped the cursor forward and silently dropped
// the lost-in-between span). Both counters are reset only on reboot.
//
//   data_buffer_evictions_total       — number of read() calls that
//                                       triggered the clamp
//   data_buffer_evicted_records_total — approximate count of records
//                                       lost across all those events
//                                       (counts bytes evicted /
//                                       average-record-size; off by
//                                       small rounding when records
//                                       are mixed-size)
//
// Surfaced in /api/status so a long recording can be cross-checked
// against the HDF5 gap analysis: if eviction counter == HDF5 gap
// count, the gaps are 100% consumer-stall driven (browser fell
// behind, ring overflowed). If counter is 0 and gaps still exist,
// the device emit loop itself paused — investigate user code.
uint32_t data_buffer_evictions_total(void);
uint32_t data_buffer_evicted_bytes_total(void);
