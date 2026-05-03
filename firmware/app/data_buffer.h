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
//    4       1     dtype       u8  (poe_dtype_t)
//    5       2     n           LE u16 (element count, not bytes)
//    7       1     reserved    0
//    8       8     uptime_us   LE u64
//    16      ...   payload     n * element_size bytes
//
// Payload is raw little-endian elements (RP2350 and typical browsers
// agree). The browser uses DataView with littleEndian=true.

// 64 KB ring. With 1 kHz × 2 channels × 20 B/record = 40 KB/s steady
// load, this is ~1.6 s of backlog tolerance — enough to absorb a
// transient browser stall (IndexedDB flush, GC pause, tab background)
// without triggering the drop-oldest clamp in data_buffer_read. The
// throughput-side fixes (TCP_SND_BUF + http_server out[] bump) handle
// steady state; this slack handles burst-stall recovery.
#define DATA_BUFFER_SIZE       65536    // must be a power of two
#define POE_DATA_MAX_NAMES     32
#define POE_DATA_NAME_MAX      32
#define POE_DATA_RECORD_HEADER 16
#define POE_DATA_MAGIC         0xFE
#define POE_DATA_VERSION       0x01

// Reserved msg_id used by http_server's stream keepalive: a 16-byte
// header with n=0 emitted at most every 500 ms when the data ring is
// otherwise idle, so the browser's stall watchdog has bytes to chew
// on even when user code isn't transmitting. The browser parser
// (web/telemetry.js drain()) skips records with this msg_id without
// pushing to the chart or store. Treated as reserved — `transmit()`
// will never assign it to a user channel because POE_DATA_MAX_NAMES
// is 32, well below 0xFFFF.
#define POE_DATA_KEEPALIVE_MSG_ID 0xFFFF

// Keep this enum in sync with the duplicate in
// web/assets/sdk/headers/include/pico_poe_user.h — both are part of the
// wire format.
typedef enum {
    POE_DTYPE_I8   = 0,
    POE_DTYPE_U8   = 1,
    POE_DTYPE_I16  = 2,
    POE_DTYPE_U16  = 3,
    POE_DTYPE_I32  = 4,
    POE_DTYPE_U32  = 5,
    POE_DTYPE_I64  = 6,
    POE_DTYPE_U64  = 7,
    POE_DTYPE_F32  = 8,
    POE_DTYPE_F64  = 9,
} poe_dtype_t;

// Element size in bytes for each poe_dtype_t, or 0 if the dtype is unknown.
size_t poe_dtype_size(poe_dtype_t dtype);

// Allocate the internal spinlock + zero the schema registry. Call once,
// after stdio is initialised. Idempotent.
void data_buffer_init(void);

// Look up `name` in the schema registry. If not present, validate it
// (UPPER_SNAKE_CASE, ≤31 chars, can't start with a digit) and allocate the
// next free slot. Returns the slot id (0..POE_DATA_MAX_NAMES-1) or -1 if
// the name is invalid or the registry is full. Thread-safe.
//
// Most user code never calls this directly — the `transmit(name, T, ptr)`
// macro in pico_poe_user.h caches the resolved id per call site so the
// lookup happens at most once per call site per boot.
int poe_data_lookup_or_register(const char *name);

// Hot-path entry point invoked by the `transmit(...)` macro. Caches the
// resolved id in `*id_slot` (a `static int8_t = -1;` declared by the macro
// at each call site). Pass id_slot=NULL for callers that don't want
// caching.
//
// Behaviour:
//   *id_slot >= 0  → fast path: emit record under that id.
//   *id_slot <  0  → look up name, cache id, emit. If the name is
//                    invalid or the registry is full, emit a one-time
//                    warning to poe_log and drop the call (id_slot stays
//                    -1 so subsequent calls keep failing fast).
void _poe_transmit_cached(int8_t *id_slot, const char *name,
                          poe_dtype_t dtype, uint16_t n, const void *src);

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
