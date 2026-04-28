#pragma once

// Command/control surface — POST /api/cmd?name=<cmd>&<arg>=<val>...
//
// The device exposes ONLY commands user code registers from
// pico_poe_setup(). Use the typed `on_command(name, T, cb)` macro
// (preferred — see pico_poe_user.h) or the raw `poe_command_register`
// for handlers that take multi-arg query strings. There are no
// generic peripheral pokes (no gpio_* / adc_* over the network) —
// expose application-level intent ("set_target", "vent_open"), not
// the underlying transistors.
//
// All handlers run on the lwIP TCP-callback context (core 1). Keep
// them fast — flip a flag and do the heavy work in pico_poe_loop().

#include <stddef.h>
#include <stdint.h>

typedef int (*poe_cmd_handler_t)(const char *args, char *out, size_t out_max);

// Register the built-in handlers. Call once during init (main.c).
void commands_init(void);

// Register a user handler. Names are matched case-sensitively. If `name`
// is already registered, the new handler replaces the old one (lets
// user code override built-ins if they have a reason to). Capacity is
// fixed (POE_CMD_MAX); excess registrations are silently dropped.
void poe_command_register(const char *name, poe_cmd_handler_t handler);

// Dispatch a request. Looks up `name`, calls the handler with `args` (the
// raw query string after `name=...&`) and writes the JSON reply body
// into `out`. Returns:
//    >= 0 — bytes written to `out` (success)
//    -1   — unknown command name
//    -2   — handler returned an error (out may contain a partial body)
int commands_dispatch(const char *name, const char *args,
                      char *out, size_t out_max);

// Argument parsers for handlers. `args` is a raw query-string fragment
// (e.g. "pin=15&value=1"). Keys are matched up to '=', values up to '&'
// or end-of-string. URL-decoding is NOT performed — keep values to
// [A-Za-z0-9._+-].
int    poe_cmd_arg_int   (const char *args, const char *key, int    fallback);
long   poe_cmd_arg_long  (const char *args, const char *key, long   fallback);
float  poe_cmd_arg_float (const char *args, const char *key, float  fallback);
double poe_cmd_arg_double(const char *args, const char *key, double fallback);
size_t poe_cmd_arg_str   (const char *args, const char *key,
                          char *out, size_t out_max);

// -----------------------------------------------------------------------
// Typed command callbacks — see pico_poe_user.h `on_command(name, T, cb)`
// for the user-facing macro. The functions below are the per-type
// registration trampolines selected by _Generic at the call site; they
// store (cb, dtype) into the same table as poe_command_register and route
// dispatch through a typed adapter that parses the `value` query arg into
// the element type before invoking cb.

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
