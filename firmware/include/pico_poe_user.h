// pico_poe_user.h — public API for user code written in the PICO-POE web IDE.
//
// Include this header from your main.c to get access to helpers that are
// only useful in the IDE context: log() for the runtime console,
// transmit() for the live telemetry chart, and poe_command_register() for
// remote control endpoints.

#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Printf-style runtime-console logging.
//
//   log("hello, world\n");
//   log("tick=%u, led=%s\n", ticks, on ? "on" : "off");
//   log("temperature=%.2f C\n", celsius);
//
// Output appears in the "Runtime console" pane of the browser IDE (via
// GET /api/log on the device's HTTP API). Nothing is emitted on USB serial.
// Output is truncated after 255 formatted bytes per call; split long
// payloads into multiple calls if you need more.
//
// Internals: the real symbol is `poe_log` — the Pico SDK's pico_double
// library already claims the linker name `log` (for double-precision
// natural log, via --wrap=log). We alias `log` to `poe_log` here so user
// code reads naturally. That means if you later include <math.h> in the
// same translation unit AFTER this header, math.log will also be renamed;
// use logf()/log10() for math instead, or `#undef log` first.
void poe_log(const char *fmt, ...)
    __attribute__((format(printf, 1, 2)));

#ifndef log
#define log poe_log
#endif

// -----------------------------------------------------------------------
// Live telemetry — transmit() streams timestamped scalars and vectors to
// the browser's chart pane (and into IndexedDB for HDF5 export).
//
// One call. The NAME is the channel identifier (UPPER_SNAKE_CASE only) and
// is auto-registered the first time you call transmit() with it. T is a
// typedef that encodes both the element type AND the count.
//
// Scalar example:
//
//   F32 v;
//   v[0] = read_voltage(0);
//   transmit("AIN0", F32, v);
//
// Vector example (using a built-in shape):
//
//   I16x3 imu = { ax, ay, az };
//   transmit("IMU_ACCEL", I16x3, imu);
//
// Vector example (custom shape — typedef once, use anywhere):
//
//   typedef float QUAT[4];
//   QUAT q = { w, x, y, z };
//   transmit("ATTITUDE", QUAT, q);
//
// Constraints:
//   - Names: UPPER_SNAKE_CASE, ≤ 31 chars, must start with A-Z.
//     Invalid names emit a one-time warning and are silently dropped.
//   - At most 32 distinct names per session (POE_DATA_MAX_NAMES).
//   - One record (header + payload) must fit in the 32 KiB ring buffer.
//   - The browser assumes (dtype, n) is constant per name within a run
//     (HDF5 export depends on this).

// Wire-format dtype enum — KEEP IN SYNC with poe_dtype_t in
// firmware/app/data_buffer.h. Both are part of the wire format.
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

// Built-in scalar typedefs. Scalars are length-1 arrays so the same
// transmit() macro handles scalars and vectors uniformly. Access the
// value as `v[0]`.
typedef int8_t    I8[1];
typedef uint8_t   U8[1];
typedef int16_t   I16[1];
typedef uint16_t  U16[1];
typedef int32_t   I32[1];
typedef uint32_t  U32[1];
typedef int64_t   I64[1];
typedef uint64_t  U64[1];
typedef float     F32[1];
typedef double    F64[1];

// A few common vector shapes. Define your own with
//   `typedef <element> NAME[N];`
// for any other shape — no library change required.
typedef int16_t   I16x2[2];
typedef int16_t   I16x3[3];
typedef int16_t   I16x4[4];
typedef int32_t   I32x2[2];
typedef int32_t   I32x3[3];
typedef int32_t   I32x4[4];
typedef float     F32x2[2];
typedef float     F32x3[3];
typedef float     F32x4[4];

// Internal: the macro-emitted call. Don't invoke directly — use transmit().
void _poe_transmit_cached(int8_t *id_slot, const char *name,
                          poe_dtype_t dtype, uint16_t n, const void *src);

// transmit(name, T, ptr) — stream one record.
//   name : UPPER_SNAKE_CASE string literal
//   T    : a type token from the table above (or your own array typedef)
//   ptr  : pointer to the data (an array variable decays automatically)
//
// The macro derives the dtype enum and the element count from T at
// compile time via _Generic + sizeof. A wrong T (e.g. a struct, or an
// array of unsupported elements) is a compile-time error rather than a
// silent runtime drop.
#define transmit(name, T, ptr) do {                                      \
    static int8_t _poe_id = -1;                                          \
    _poe_transmit_cached(&_poe_id, (name),                               \
        _Generic( ((T*)0)[0][0],                                         \
            int8_t:   POE_DTYPE_I8,  uint8_t:  POE_DTYPE_U8,             \
            int16_t:  POE_DTYPE_I16, uint16_t: POE_DTYPE_U16,            \
            int32_t:  POE_DTYPE_I32, uint32_t: POE_DTYPE_U32,            \
            int64_t:  POE_DTYPE_I64, uint64_t: POE_DTYPE_U64,            \
            float:    POE_DTYPE_F32, double:   POE_DTYPE_F64),           \
        (uint16_t)(sizeof(T) / sizeof(((T*)0)[0][0])),                   \
        (ptr));                                                          \
} while (0)

// -----------------------------------------------------------------------
// Commanding — register a handler for a remote command, called when the
// browser (or the `pico-poe cmd` CLI) sends POST /api/cmd?name=<your_name>.
//
//   static int handle_buzz(const char *args, char *out, size_t out_max) {
//       int hz = poe_cmd_arg_int(args, "hz", 1000);
//       buzzer_play(hz);
//       return snprintf(out, out_max, "{\"hz\":%d}", hz);
//   }
//
//   void pico_poe_setup(void) {
//       poe_command_register("buzz", handle_buzz);
//   }
//
// The handler runs on the lwIP TCP-callback context (core 1). Keep it
// fast — it's called inline during HTTP request handling. For long-
// running work, set a flag and do the work in pico_poe_loop().
//
// Return value: number of bytes written into `out` (the JSON body of the
// 200-OK reply). A negative return signals an error and the server
// replies 500 with {"ok":false,"error":"command failed"}.
typedef int (*poe_cmd_handler_t)(const char *args, char *out, size_t out_max);
void poe_command_register(const char *name, poe_cmd_handler_t handler);

// Helpers for parsing the raw query-string `args` passed to a handler.
// Returns the int / fallback if the key is missing or malformed.
int    poe_cmd_arg_int  (const char *args, const char *key, int    fallback);
long   poe_cmd_arg_long (const char *args, const char *key, long   fallback);
float  poe_cmd_arg_float(const char *args, const char *key, float  fallback);
double poe_cmd_arg_double(const char *args, const char *key, double fallback);
// Copies the value of `key` into `out`. Returns the number of bytes
// written (excluding the terminator), or 0 if the key is missing.
size_t poe_cmd_arg_str(const char *args, const char *key,
                       char *out, size_t out_max);

// -----------------------------------------------------------------------
// Typed command callbacks — mirror of transmit(name, T, ptr).
//
// Skip the args/JSON plumbing entirely: declare a callback that takes the
// already-parsed value and returns NULL on success or a static error
// string on failure. Register it with the same shape as transmit:
//
//   const char *on_set_blink(int32_t period) {
//       if (period < 10) return "period must be >= 10";
//       blink_period_ticks = (uint32_t)period;
//       return NULL;
//   }
//
//   void pico_poe_setup(void) {
//       on_command("set_blink", I32, on_set_blink);
//   }
//
// Wire convention: the value is read from the `value` query parameter,
// e.g. POST /api/cmd?name=set_blink&value=250. The framework parses it
// into the element type of T and calls your callback. On success the
// reply is {"ok":true,"value":<v>}; a non-NULL error string yields
// {"ok":false,"error":"<msg>"} (HTTP 400).
//
// Compile-time type safety: _Generic on T's element type selects a
// per-type registration function whose signature requires the matching
// callback type. Mismatches (e.g. passing an int8_t callback for a float
// command) are caught by the compiler, not silently mis-dispatched.
//
// For commands that don't fit this single-scalar shape (multi-arg,
// vector, side-effect-only with no value), keep using
// poe_command_register() with the raw (args, out, out_max) handler.

typedef const char *(*poe_cmd_cb_i8_t) (int8_t);
typedef const char *(*poe_cmd_cb_u8_t) (uint8_t);
typedef const char *(*poe_cmd_cb_i16_t)(int16_t);
typedef const char *(*poe_cmd_cb_u16_t)(uint16_t);
typedef const char *(*poe_cmd_cb_i32_t)(int32_t);
typedef const char *(*poe_cmd_cb_u32_t)(uint32_t);
typedef const char *(*poe_cmd_cb_i64_t)(int64_t);
typedef const char *(*poe_cmd_cb_u64_t)(uint64_t);
typedef const char *(*poe_cmd_cb_f32_t)(float);
typedef const char *(*poe_cmd_cb_f64_t)(double);

// Per-type registration funcs — typically not called directly; the
// on_command() macro selects the right one via _Generic. Listed here so
// the compiler can enforce callback signature matching at the macro
// expansion site.
void _poe_register_cb_i8 (const char *name, poe_cmd_cb_i8_t  cb);
void _poe_register_cb_u8 (const char *name, poe_cmd_cb_u8_t  cb);
void _poe_register_cb_i16(const char *name, poe_cmd_cb_i16_t cb);
void _poe_register_cb_u16(const char *name, poe_cmd_cb_u16_t cb);
void _poe_register_cb_i32(const char *name, poe_cmd_cb_i32_t cb);
void _poe_register_cb_u32(const char *name, poe_cmd_cb_u32_t cb);
void _poe_register_cb_i64(const char *name, poe_cmd_cb_i64_t cb);
void _poe_register_cb_u64(const char *name, poe_cmd_cb_u64_t cb);
void _poe_register_cb_f32(const char *name, poe_cmd_cb_f32_t cb);
void _poe_register_cb_f64(const char *name, poe_cmd_cb_f64_t cb);

// on_command(name, T, cb) — typed command registration symmetric to
// transmit(name, T, ptr). T must be one of the scalar typedefs above
// (I8, U8, I16, U16, I32, U32, I64, U64, F32, F64). cb's parameter type
// must match T's element type, or you get a compile-time mismatch.
#define on_command(name, T, cb)                                          \
    _Generic(((T*)0)[0][0],                                              \
        int8_t:   _poe_register_cb_i8,  uint8_t:  _poe_register_cb_u8,   \
        int16_t:  _poe_register_cb_i16, uint16_t: _poe_register_cb_u16,  \
        int32_t:  _poe_register_cb_i32, uint32_t: _poe_register_cb_u32,  \
        int64_t:  _poe_register_cb_i64, uint64_t: _poe_register_cb_u64,  \
        float:    _poe_register_cb_f32, double:   _poe_register_cb_f64)  \
    ((name), (cb))

#ifdef __cplusplus
}
#endif
