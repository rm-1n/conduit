#include "commands.h"
#include "data_buffer.h"        // poe_dtype_t

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <inttypes.h>

#define POE_CMD_MAX 24

// A command entry has either a low-level handler (raw args+out) OR a
// typed callback (parsed value, NULL/error-string return). Mutually
// exclusive: typed entries set handler=NULL and let commands_dispatch
// route through invoke_typed.
typedef struct {
    const char *name;
    poe_cmd_handler_t handler;     // NULL when typed_cb is set
    void              *typed_cb;   // cast back via typed_dtype
    poe_dtype_t        typed_dtype;
} cmd_entry_t;

static cmd_entry_t g_cmds[POE_CMD_MAX];
static uint8_t     g_cmd_count = 0;

// --- arg parsing ---------------------------------------------------------

// Find the value substring for `key=` inside `args`. Returns a pointer to
// the first byte of the value (past the '='), and writes its length into
// *value_len. Returns NULL if not found.
static const char *find_value(const char *args, const char *key, size_t *value_len) {
    if (!args || !key) return NULL;
    size_t klen = strlen(key);
    const char *p = args;
    while (*p) {
        // Skip leading '&' separators.
        while (*p == '&') p++;
        if (!*p) break;
        if (strncmp(p, key, klen) == 0 && p[klen] == '=') {
            const char *v = p + klen + 1;
            const char *end = strchr(v, '&');
            *value_len = end ? (size_t)(end - v) : strlen(v);
            return v;
        }
        const char *amp = strchr(p, '&');
        if (!amp) break;
        p = amp + 1;
    }
    return NULL;
}

int poe_cmd_arg_int(const char *args, const char *key, int fallback) {
    size_t vlen = 0;
    const char *v = find_value(args, key, &vlen);
    if (!v || vlen == 0 || vlen >= 16) return fallback;
    char buf[16];
    memcpy(buf, v, vlen);
    buf[vlen] = '\0';
    char *endp = NULL;
    long n = strtol(buf, &endp, 0);
    if (endp == buf) return fallback;
    return (int)n;
}

long poe_cmd_arg_long(const char *args, const char *key, long fallback) {
    size_t vlen = 0;
    const char *v = find_value(args, key, &vlen);
    if (!v || vlen == 0 || vlen >= 32) return fallback;
    char buf[32];
    memcpy(buf, v, vlen);
    buf[vlen] = '\0';
    char *endp = NULL;
    long n = strtol(buf, &endp, 0);
    if (endp == buf) return fallback;
    return n;
}

float poe_cmd_arg_float(const char *args, const char *key, float fallback) {
    size_t vlen = 0;
    const char *v = find_value(args, key, &vlen);
    if (!v || vlen == 0 || vlen >= 32) return fallback;
    char buf[32];
    memcpy(buf, v, vlen);
    buf[vlen] = '\0';
    char *endp = NULL;
    float n = strtof(buf, &endp);
    if (endp == buf) return fallback;
    return n;
}

double poe_cmd_arg_double(const char *args, const char *key, double fallback) {
    size_t vlen = 0;
    const char *v = find_value(args, key, &vlen);
    if (!v || vlen == 0 || vlen >= 32) return fallback;
    char buf[32];
    memcpy(buf, v, vlen);
    buf[vlen] = '\0';
    char *endp = NULL;
    double n = strtod(buf, &endp);
    if (endp == buf) return fallback;
    return n;
}

size_t poe_cmd_arg_str(const char *args, const char *key,
                       char *out, size_t out_max) {
    if (!out || out_max == 0) return 0;
    size_t vlen = 0;
    const char *v = find_value(args, key, &vlen);
    if (!v || vlen == 0) { out[0] = '\0'; return 0; }
    if (vlen > out_max - 1) vlen = out_max - 1;
    memcpy(out, v, vlen);
    out[vlen] = '\0';
    return vlen;
}

// --- error helper -------------------------------------------------------

// Handler error path: write the bare message into `out` (the http layer
// quotes it into {"ok":false,"error":"..."}), and return -1 so the
// dispatcher routes us through that error path. JSON-quoted output here
// would get double-quoted by the wrapper.
static int err_json(char *out, size_t out_max, const char *msg) {
    if (!out || out_max == 0) return -1;
    size_t n = strlen(msg);
    if (n > out_max - 1) n = out_max - 1;
    memcpy(out, msg, n);
    out[n] = '\0';
    return -1;
}

// --- registration & dispatch -------------------------------------------

// Find an existing slot by name, or claim a fresh one. Returns NULL if
// the table is full and `name` isn't already registered.
static cmd_entry_t *cmd_slot(const char *name) {
    for (uint8_t i = 0; i < g_cmd_count; i++) {
        if (g_cmds[i].name && strcmp(g_cmds[i].name, name) == 0) {
            return &g_cmds[i];
        }
    }
    if (g_cmd_count >= POE_CMD_MAX) return NULL;
    cmd_entry_t *e = &g_cmds[g_cmd_count++];
    e->name = name;
    return e;
}

void poe_command_register(const char *name, poe_cmd_handler_t handler) {
    if (!name || !handler) return;
    cmd_entry_t *e = cmd_slot(name);
    if (!e) return;
    e->handler     = handler;
    e->typed_cb    = NULL;        // mark as low-level (handler wins)
    e->typed_dtype = 0;
}

// Common path for typed registration. The element type info is needed
// at dispatch time to parse the `value` query arg into the right C type
// before calling the user's typed callback.
static void register_typed(const char *name, void *cb, poe_dtype_t dtype) {
    if (!name || !cb) return;
    cmd_entry_t *e = cmd_slot(name);
    if (!e) return;
    e->handler     = NULL;        // typed path takes over
    e->typed_cb    = cb;
    e->typed_dtype = dtype;
}

void _poe_register_cb_i8 (const char *name, poe_cmd_cb_i8_t  cb) { register_typed(name, (void *)cb, POE_DTYPE_I8);  }
void _poe_register_cb_u8 (const char *name, poe_cmd_cb_u8_t  cb) { register_typed(name, (void *)cb, POE_DTYPE_U8);  }
void _poe_register_cb_i16(const char *name, poe_cmd_cb_i16_t cb) { register_typed(name, (void *)cb, POE_DTYPE_I16); }
void _poe_register_cb_u16(const char *name, poe_cmd_cb_u16_t cb) { register_typed(name, (void *)cb, POE_DTYPE_U16); }
void _poe_register_cb_i32(const char *name, poe_cmd_cb_i32_t cb) { register_typed(name, (void *)cb, POE_DTYPE_I32); }
void _poe_register_cb_u32(const char *name, poe_cmd_cb_u32_t cb) { register_typed(name, (void *)cb, POE_DTYPE_U32); }
void _poe_register_cb_i64(const char *name, poe_cmd_cb_i64_t cb) { register_typed(name, (void *)cb, POE_DTYPE_I64); }
void _poe_register_cb_u64(const char *name, poe_cmd_cb_u64_t cb) { register_typed(name, (void *)cb, POE_DTYPE_U64); }
void _poe_register_cb_f32(const char *name, poe_cmd_cb_f32_t cb) { register_typed(name, (void *)cb, POE_DTYPE_F32); }
void _poe_register_cb_f64(const char *name, poe_cmd_cb_f64_t cb) { register_typed(name, (void *)cb, POE_DTYPE_F64); }

void commands_init(void) {
    // No built-in commands. The device exposes only what user code
    // registers via on_command(name, T, cb) — application-level
    // intent ("set_target", "vent_open"), not generic peripheral
    // pokes. Kept as a function so main.c's call site stays stable
    // and a future maintainer can add cross-cutting handlers here
    // without changing the wiring.
}

// Adapter for typed callbacks: parse the `value` query arg into the
// element type, invoke cb, render success/error reply. Handler-style
// return convention: >=0 bytes written on success, -1 on error (with
// the bare error message in `out`, which the http layer JSON-escapes).
static int invoke_typed(const cmd_entry_t *e, const char *args,
                        char *out, size_t out_max) {
    const char *err = NULL;
    int written = 0;

    switch (e->typed_dtype) {
        case POE_DTYPE_I8: {
            int8_t v = (int8_t)poe_cmd_arg_int(args, "value", 0);
            err = ((poe_cmd_cb_i8_t)e->typed_cb)(v);
            if (!err) written = snprintf(out, out_max, "{\"ok\":true,\"value\":%d}", (int)v);
            break;
        }
        case POE_DTYPE_U8: {
            uint8_t v = (uint8_t)poe_cmd_arg_int(args, "value", 0);
            err = ((poe_cmd_cb_u8_t)e->typed_cb)(v);
            if (!err) written = snprintf(out, out_max, "{\"ok\":true,\"value\":%u}", (unsigned)v);
            break;
        }
        case POE_DTYPE_I16: {
            int16_t v = (int16_t)poe_cmd_arg_int(args, "value", 0);
            err = ((poe_cmd_cb_i16_t)e->typed_cb)(v);
            if (!err) written = snprintf(out, out_max, "{\"ok\":true,\"value\":%d}", (int)v);
            break;
        }
        case POE_DTYPE_U16: {
            uint16_t v = (uint16_t)poe_cmd_arg_int(args, "value", 0);
            err = ((poe_cmd_cb_u16_t)e->typed_cb)(v);
            if (!err) written = snprintf(out, out_max, "{\"ok\":true,\"value\":%u}", (unsigned)v);
            break;
        }
        case POE_DTYPE_I32: {
            int32_t v = (int32_t)poe_cmd_arg_long(args, "value", 0);
            err = ((poe_cmd_cb_i32_t)e->typed_cb)(v);
            if (!err) written = snprintf(out, out_max, "{\"ok\":true,\"value\":%" PRId32 "}", v);
            break;
        }
        case POE_DTYPE_U32: {
            uint32_t v = (uint32_t)poe_cmd_arg_long(args, "value", 0);
            err = ((poe_cmd_cb_u32_t)e->typed_cb)(v);
            if (!err) written = snprintf(out, out_max, "{\"ok\":true,\"value\":%" PRIu32 "}", v);
            break;
        }
        case POE_DTYPE_I64: {
            // poe_cmd_arg_long returns long, which is 32-bit on Pico's
            // arm-none-eabi by default. strtoll path covers true 64-bit.
            size_t vlen = 0;
            const char *vs = find_value(args, "value", &vlen);
            int64_t v = 0;
            if (vs && vlen && vlen < 24) {
                char buf[24]; memcpy(buf, vs, vlen); buf[vlen] = '\0';
                v = (int64_t)strtoll(buf, NULL, 0);
            }
            err = ((poe_cmd_cb_i64_t)e->typed_cb)(v);
            if (!err) written = snprintf(out, out_max, "{\"ok\":true,\"value\":%" PRId64 "}", v);
            break;
        }
        case POE_DTYPE_U64: {
            size_t vlen = 0;
            const char *vs = find_value(args, "value", &vlen);
            uint64_t v = 0;
            if (vs && vlen && vlen < 24) {
                char buf[24]; memcpy(buf, vs, vlen); buf[vlen] = '\0';
                v = (uint64_t)strtoull(buf, NULL, 0);
            }
            err = ((poe_cmd_cb_u64_t)e->typed_cb)(v);
            if (!err) written = snprintf(out, out_max, "{\"ok\":true,\"value\":%" PRIu64 "}", v);
            break;
        }
        case POE_DTYPE_F32: {
            float v = poe_cmd_arg_float(args, "value", 0.0f);
            err = ((poe_cmd_cb_f32_t)e->typed_cb)(v);
            if (!err) written = snprintf(out, out_max, "{\"ok\":true,\"value\":%g}", (double)v);
            break;
        }
        case POE_DTYPE_F64: {
            double v = poe_cmd_arg_double(args, "value", 0.0);
            err = ((poe_cmd_cb_f64_t)e->typed_cb)(v);
            if (!err) written = snprintf(out, out_max, "{\"ok\":true,\"value\":%g}", v);
            break;
        }
        default:
            return err_json(out, out_max, "internal: unknown typed dtype");
    }

    if (err) return err_json(out, out_max, err);
    return written;
}

int commands_dispatch(const char *name, const char *args,
                      char *out, size_t out_max) {
    if (!name || !out || out_max == 0) return -1;
    for (uint8_t i = 0; i < g_cmd_count; i++) {
        if (strcmp(g_cmds[i].name, name) == 0) {
            int n = g_cmds[i].handler
                ? g_cmds[i].handler(args ? args : "", out, out_max)
                : invoke_typed(&g_cmds[i], args ? args : "", out, out_max);
            return n < 0 ? -2 : n;
        }
    }
    return -1;
}

