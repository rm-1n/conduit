#pragma once

#include <stddef.h>
#include <stdint.h>

// Dedicated ring buffer that backs the web IDE's runtime console.
// Written to ONLY via log() below — printf stays on USB serial.
//
// Reader cursor is an absolute byte count since boot (32-bit; wraps at 4 GB
// which won't realistically happen in a session).

#define LOG_BUFFER_SIZE 8192  // must be a power of two

// Allocate the internal spinlock. Call once, after stdio is initialized.
void log_buffer_init(void);

// printf-style log into the ring buffer. Goes to the web IDE's runtime
// console ONLY — no USB serial copy, no stdio interaction. Thread-safe.
//
// Each record is prefixed on-device with "[<uptime_us>]\t" so the reader
// can recover precise timestamps regardless of transport delay. Callers
// should terminate their format string with "\n" — newlines delimit
// records and the browser-side parser treats continuation lines (lines
// that don't start with "[<digits>]\t") as belonging to the previous
// record's timestamp.
//
// Note: named conduit_log (not log) because the Pico SDK's pico_double library
// already claims the linker name `log` via --wrap=log for double-precision
// natural log. Our web IDE user header (conduit_user.h) textually aliases
// `log` to `conduit_log` so user code can still type log("...").
//
// Each record shares a 256-byte stack buffer with the timestamp prefix
// (~22 bytes), so the user payload is effectively capped at ~232 bytes.
// Longer messages are truncated.
void conduit_log(const char *fmt, ...)
    __attribute__((format(printf, 1, 2)));

// Copy up to `max` bytes starting at absolute cursor `since` into `out`.
// Returns bytes copied. If `since` is older than the ring's oldest retained
// byte, fast-forwards to that oldest byte. If `since` is ahead of the write
// cursor, returns 0.
size_t log_buffer_read(uint32_t since, uint8_t *out, size_t max,
                       uint32_t *out_next_cursor);

// Total bytes ever written. Clients bootstrap their cursor from this so they
// only see new output going forward.
uint32_t log_buffer_total_written(void);

// How many times conduit_log() has been entered. Pair with the byte total
// to distinguish "callers stopped calling" from "calls were dropped".
uint32_t log_buffer_call_count(void);
