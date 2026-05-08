// discovery.c — see discovery.h for the contract.

#include "discovery.h"
#include "network.h"
#include "conduit_config.h"
#include "dev_log.h"

#include "pico/unique_id.h"

#include "lwip/udp.h"
#include "lwip/pbuf.h"
#include "lwip/ip4_addr.h"
#include "lwip/timeouts.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

// Administratively-scoped IPv4 multicast group. 239.0.0.0/8 is the
// "site-local" range that won't be forwarded past organisation
// borders (RFC 2365), which is what we want — discovery only needs
// to reach the same LAN. Port chosen to avoid mDNS (5353) and SSDP
// (1900). If the chosen value collides with something the user runs,
// they can change both ends together (firmware here + the conduit
// CLI's `discover` subcommand).
#define DISCOVERY_MCAST_ADDR "239.255.42.42"
#define DISCOVERY_MCAST_PORT 5354
#define DISCOVERY_PERIOD_MS  1000

// Cap the JSON payload buffer at a safe-for-MTU size. The actual
// content is well under 200 bytes; the rest is slack against future
// fields.
#define DISCOVERY_MAX_PAYLOAD 256

static struct udp_pcb *g_pcb = NULL;
static ip_addr_t       g_group;
static char            g_id_buf[2 * PICO_UNIQUE_BOARD_ID_SIZE_BYTES + 1]; // hex + NUL

// One-shot initialiser for the device-id string. Mirrors http_server.c's
// get_board_id() so the discovery payload's id matches the value in
// /api/status's board_id field. Replaced in Phase 2 by the IDENTITY
// partition's persisted unique-id.
static void load_device_id(void) {
    pico_unique_board_id_t id;
    pico_get_unique_board_id(&id);
    size_t pos = 0;
    for (int i = 0; i < PICO_UNIQUE_BOARD_ID_SIZE_BYTES &&
                    pos + 2 < sizeof(g_id_buf); i++) {
        pos += snprintf(g_id_buf + pos, sizeof(g_id_buf) - pos,
                        "%02x", id.id[i]);
    }
    g_id_buf[sizeof(g_id_buf) - 1] = '\0';
}

// Build + send one heartbeat. Called from sys_check_timeouts on
// Core 1, so all the lwIP calls below are on the correct thread.
static void discovery_tick(void *arg);

// Diagnostic counters — logged on the first success and on every
// transition into / out of an error state so a quiet `conduit serial`
// makes it obvious whether sends are firing at all.
// Also exposed via discovery_get_stats() so diag.c can fold them
// into the per-second heartbeat line (visible in --dev builds).
static uint32_t g_send_ok_count   = 0;
static uint32_t g_send_fail_count = 0;
static err_t    g_last_send_err   = ERR_OK;
static bool     g_first_ok_logged = false;

void discovery_get_stats(uint32_t *ok_count, uint32_t *fail_count) {
    if (ok_count)   *ok_count   = g_send_ok_count;
    if (fail_count) *fail_count = g_send_fail_count;
}

static void send_one(void) {
    if (!g_pcb) return;
    // Skip when no IP — sending pre-DHCP/static-init produces a
    // useless 0.0.0.0 advertisement.
    if (!network_has_ip()) return;

    char payload[DISCOVERY_MAX_PAYLOAD];
    int  n = snprintf(payload, sizeof(payload),
        "{\"id\":\"%s\",\"ip\":\"%s\",\"name\":\"\",\"v\":\"%s\"}",
        g_id_buf,
        network_get_ip_str(),
        CONDUIT_VERSION_STRING);
    if (n <= 0) return;
    if ((size_t)n >= sizeof(payload)) n = (int)sizeof(payload) - 1;

    struct pbuf *p = pbuf_alloc(PBUF_TRANSPORT, (u16_t)n, PBUF_RAM);
    if (!p) {
        g_send_fail_count++;
        // pool exhausted — log only on the transition so we don't spam
        if (g_last_send_err != ERR_MEM) {
            DEV_LOG("[discovery] pbuf_alloc failed (pool exhausted)\n");
            g_last_send_err = ERR_MEM;
        }
        return;
    }
    memcpy(p->payload, payload, (size_t)n);
    err_t err = udp_sendto(g_pcb, p, &g_group, DISCOVERY_MCAST_PORT);
    pbuf_free(p);

    if (err == ERR_OK) {
        g_send_ok_count++;
        if (!g_first_ok_logged) {
            DEV_LOG("[discovery] first send ok: %d bytes → %s:%d\n",
                   n, DISCOVERY_MCAST_ADDR, DISCOVERY_MCAST_PORT);
            g_first_ok_logged = true;
        } else if (g_last_send_err != ERR_OK) {
            DEV_LOG("[discovery] send recovered after err=%d (ok count=%lu)\n",
                   g_last_send_err, (unsigned long)g_send_ok_count);
        }
        g_last_send_err = ERR_OK;
    } else {
        g_send_fail_count++;
        if (err != g_last_send_err) {
            DEV_LOG("[discovery] udp_sendto failed: err=%d\n", err);
            g_last_send_err = err;
        }
    }
}

static void discovery_tick(void *arg) {
    (void)arg;
    send_one();
    // Re-arm. sys_timeout cancels itself when it fires, so we have
    // to re-register every cycle. lwIP's sys-timeout pool is sized
    // by MEMP_NUM_SYS_TIMEOUT (16 in lwipopts.h) — comfortably above
    // the simultaneous-callbacks count even with the gARP burst path.
    sys_timeout(DISCOVERY_PERIOD_MS, discovery_tick, NULL);
}

int discovery_init(void) {
    load_device_id();

    if (!ip4addr_aton(DISCOVERY_MCAST_ADDR, ip_2_ip4(&g_group))) {
        // Compile-time misconfiguration; bail safely.
        return -1;
    }
    IP_SET_TYPE_VAL(g_group, IPADDR_TYPE_V4);

    g_pcb = udp_new();
    if (!g_pcb) return -2;

    // Bind to ephemeral src port — we never receive replies, only
    // send. Bind to ANY so the kernel picks the right egress
    // interface based on the dest's routing.
    err_t err = udp_bind(g_pcb, IP_ANY_TYPE, 0);
    if (err != ERR_OK) {
        udp_remove(g_pcb);
        g_pcb = NULL;
        return -3;
    }

    // TTL of 1 keeps the multicast on the local LAN — exactly the
    // discovery scope we want. Routers won't forward.
    udp_set_multicast_ttl(g_pcb, 1);

    // First send fires after one period rather than immediately, to
    // give the netif a moment to settle past `network_init()`.
    sys_timeout(DISCOVERY_PERIOD_MS, discovery_tick, NULL);

    DEV_LOG("[discovery] beacon armed: id=%s group=%s:%d period=%dms\n",
           g_id_buf, DISCOVERY_MCAST_ADDR, DISCOVERY_MCAST_PORT,
           DISCOVERY_PERIOD_MS);
    return 0;
}
