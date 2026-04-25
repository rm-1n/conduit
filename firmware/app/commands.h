#pragma once

// Command/control surface — POST /api/cmd?name=<cmd>&<arg>=<val>...
//
// Built-in handlers (see commands.c): gpio_init, gpio_write, gpio_read,
// gpio_toggle, adc_read. User code can register additional handlers from
// pico_poe_setup() via poe_command_register(). All handlers run on the
// lwIP TCP-callback context (core 1) — keep them fast.

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
// [A-Za-z0-9._-].
int    poe_cmd_arg_int (const char *args, const char *key, int  fallback);
long   poe_cmd_arg_long(const char *args, const char *key, long fallback);
size_t poe_cmd_arg_str (const char *args, const char *key,
                        char *out, size_t out_max);
