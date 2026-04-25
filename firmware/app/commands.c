#include "commands.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#include "hardware/gpio.h"
#include "hardware/adc.h"

// GPIOs reserved by on-board peripherals. Refusing to touch these avoids
// destroying the network link or the PoE detect input from a stray HTTP
// request. Source of truth:
//   firmware/app/pio/rmii_ethernet_phy_rx.pio (RX/TX/MDIO/MDC/REFCLK/RST)
//   firmware/include/pico_poe_config.h (PoE status pin)
#define POE_GPIO_RESERVED_MASK ( \
      (1u <<  6) /* RMII RX0 */  | (1u <<  7) /* RMII RX1 */  | (1u <<  8) /* RMII CRS_DV */ \
    | (1u << 10) /* RMII TX0 */  | (1u << 11) /* RMII TX1 */  | (1u << 12) /* RMII TX_EN  */ \
    | (1u << 14) /* RMII MDIO*/  | (1u << 15) /* RMII MDC  */ | (1u << 21) /* RMII REFCLK*/ \
    | (1u << 27) /* PoE status*/ | (1u << 28) /* RMII RST  */ )

#define POE_GPIO_MAX 29  // RP2350 has GP0..GP29 usable from the user side

#define POE_CMD_MAX 24

typedef struct {
    const char *name;
    poe_cmd_handler_t handler;
} cmd_entry_t;

static cmd_entry_t g_cmds[POE_CMD_MAX];
static uint8_t     g_cmd_count = 0;
static bool        g_adc_inited = false;

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

// --- pin guard ----------------------------------------------------------

static bool gpio_pin_allowed(int pin, char *err, size_t err_max) {
    if (pin < 0 || pin > POE_GPIO_MAX) {
        snprintf(err, err_max, "pin %d out of range 0..%d", pin, POE_GPIO_MAX);
        return false;
    }
    if (POE_GPIO_RESERVED_MASK & (1u << pin)) {
        snprintf(err, err_max, "pin %d is reserved (RMII / PoE)", pin);
        return false;
    }
    return true;
}

// --- built-in handlers --------------------------------------------------

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

static int handle_gpio_init(const char *args, char *out, size_t out_max) {
    int pin = poe_cmd_arg_int(args, "pin", -1);
    char err[64];
    if (!gpio_pin_allowed(pin, err, sizeof(err))) return err_json(out, out_max, err);
    char dir[8];
    poe_cmd_arg_str(args, "dir", dir, sizeof(dir));
    bool out_dir = (strcmp(dir, "out") == 0);
    gpio_init((uint)pin);
    gpio_set_dir((uint)pin, out_dir);
    return snprintf(out, out_max, "{\"pin\":%d,\"dir\":\"%s\"}",
                    pin, out_dir ? "out" : "in");
}

static int handle_gpio_write(const char *args, char *out, size_t out_max) {
    int pin = poe_cmd_arg_int(args, "pin", -1);
    int val = poe_cmd_arg_int(args, "value", -1);
    char err[64];
    if (!gpio_pin_allowed(pin, err, sizeof(err))) return err_json(out, out_max, err);
    if (val != 0 && val != 1) return err_json(out, out_max, "value must be 0 or 1");
    gpio_put((uint)pin, val != 0);
    return snprintf(out, out_max, "{\"pin\":%d,\"value\":%d}", pin, val);
}

static int handle_gpio_read(const char *args, char *out, size_t out_max) {
    int pin = poe_cmd_arg_int(args, "pin", -1);
    char err[64];
    if (!gpio_pin_allowed(pin, err, sizeof(err))) return err_json(out, out_max, err);
    int v = gpio_get((uint)pin) ? 1 : 0;
    return snprintf(out, out_max, "{\"pin\":%d,\"value\":%d}", pin, v);
}

static int handle_gpio_toggle(const char *args, char *out, size_t out_max) {
    int pin = poe_cmd_arg_int(args, "pin", -1);
    char err[64];
    if (!gpio_pin_allowed(pin, err, sizeof(err))) return err_json(out, out_max, err);
    int v = gpio_get((uint)pin) ? 0 : 1;
    gpio_put((uint)pin, v);
    return snprintf(out, out_max, "{\"pin\":%d,\"value\":%d}", pin, v);
}

static int handle_adc_read(const char *args, char *out, size_t out_max) {
    // Channels: 0=GP26, 4=internal temp sensor. Channels 1..3 alias to
    // pins also used by RMII/PoE — refuse them.
    int ch = poe_cmd_arg_int(args, "channel", 0);
    if (!(ch == 0 || ch == 4)) {
        return err_json(out, out_max, "channel must be 0 (GP26) or 4 (temp)");
    }
    if (!g_adc_inited) {
        adc_init();
        adc_gpio_init(26);
        adc_set_temp_sensor_enabled(true);
        g_adc_inited = true;
    }
    adc_select_input((uint)ch);
    uint16_t raw = adc_read();
    return snprintf(out, out_max, "{\"channel\":%d,\"raw\":%u}", ch, (unsigned)raw);
}

// --- registration & dispatch -------------------------------------------

void poe_command_register(const char *name, poe_cmd_handler_t handler) {
    if (!name || !handler) return;
    // Replace if already registered.
    for (uint8_t i = 0; i < g_cmd_count; i++) {
        if (g_cmds[i].name && strcmp(g_cmds[i].name, name) == 0) {
            g_cmds[i].handler = handler;
            return;
        }
    }
    if (g_cmd_count >= POE_CMD_MAX) return;
    g_cmds[g_cmd_count].name    = name;
    g_cmds[g_cmd_count].handler = handler;
    g_cmd_count++;
}

void commands_init(void) {
    poe_command_register("gpio_init",   handle_gpio_init);
    poe_command_register("gpio_write",  handle_gpio_write);
    poe_command_register("gpio_read",   handle_gpio_read);
    poe_command_register("gpio_toggle", handle_gpio_toggle);
    poe_command_register("adc_read",    handle_adc_read);
}

int commands_dispatch(const char *name, const char *args,
                      char *out, size_t out_max) {
    if (!name || !out || out_max == 0) return -1;
    for (uint8_t i = 0; i < g_cmd_count; i++) {
        if (strcmp(g_cmds[i].name, name) == 0) {
            int n = g_cmds[i].handler(args ? args : "", out, out_max);
            return n < 0 ? -2 : n;
        }
    }
    return -1;
}
