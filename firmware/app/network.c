#include "network.h"
#include "pico_poe_config.h"
#ifndef PICO_POE_MINIMAL
#include "http_server.h"
#endif

#include "pico/stdlib.h"
#include "hardware/gpio.h"
#include "hardware/clocks.h"
#include "hardware/vreg.h"

#include "lwip/init.h"
#include "lwip/dhcp.h"
#include "lwip/autoip.h"
#include "lwip/ip4_addr.h"
#include "lwip/etharp.h"
#include "lwip/timeouts.h"

#include "rmii_ethernet/netif.h"
#include "lan8720a.h"

static struct netif g_netif;
static absolute_time_t g_boot_time;
static char g_ip_str[16];
static char g_mac_str[18];

// gARP (refresh upstream MAC tables) + gateway ARP request (elicits a
// unicast reply, exercising the unicast RX path). Skip if link dropped
// between schedule and fire. Runs on Core 1 (sys_check_timeouts thread).
static void announce_tick_cb(void *arg) {
    struct netif *netif = (struct netif *)arg;
    if (!netif_is_link_up(netif)) return;
    etharp_gratuitous(netif);
    const ip4_addr_t *gw = netif_ip4_gw(netif);
    if (gw && gw->addr != 0) {
        etharp_request(netif, gw);
    }
}

// Spread 4 gARP+probe kicks across 5 s after a real replug. A single
// announce can land while the upstream port is still in settle/learn
// state and get dropped before the MAC table latches.
static void schedule_garp_burst(struct netif *netif) {
    sys_timeout(500,  announce_tick_cb, netif);
    sys_timeout(1500, announce_tick_cb, netif);
    sys_timeout(3000, announce_tick_cb, netif);
    sys_timeout(5000, announce_tick_cb, netif);
}

static void link_callback(struct netif *netif) {
    bool up = netif_is_link_up(netif);
    // After a real replug the LAN8720A emits several brief (0.6-1.3 s)
    // link DOWN/UP transitions during 100Base-TX auto-neg settle. The
    // lwIP-side netif cycle is invasive (drops ARP cache, breaks active
    // TCP); only run it past a 2 s guard, comfortably above settle but
    // well below any deliberate cable swap.
    #define CABLE_REPLUG_MIN_DOWN_MS  2000
    static absolute_time_t link_down_at;
    static bool            link_down_at_valid = false;
    printf("[net] link %s\n", up ? "up" : "down");
    if (up) {
        bool real_replug = false;
        if (link_down_at_valid) {
            int64_t down_ms = absolute_time_diff_us(link_down_at,
                                                    get_absolute_time()) / 1000;
            real_replug = (down_ms >= CABLE_REPLUG_MIN_DOWN_MS);
            link_down_at_valid = false;
        }
        // Unconditional on every link-up. Any down→up phase-shifts the
        // PIO RX SM relative to the PHY's RX_DV; without a reinit every
        // subsequent frame fails FCS. ~50 µs, idempotent. MUST NOT also
        // call reset_tx_path here — TX SM sidesets RETCLK (REF_CLK to
        // the PHY); stopping it makes the RX wedge worse, not better.
        netif_rmii_ethernet_reset_rx_path();
        if (real_replug) {
            netif_set_down(netif);
            netif_set_up(netif);
        }
        // Tell upstream switches our MAC is back on this port.
        etharp_gratuitous(netif);
        if (real_replug) {
            // One immediate gARP can miss on Fritz!Box-class L2 if the
            // port is still in settle/learn when the first arrives.
            schedule_garp_burst(netif);
        }
    } else {
        // Only on FIRST down — flaps during an outage shouldn't reset
        // the clock and look like fresh disconnects.
        if (!link_down_at_valid) {
            link_down_at = get_absolute_time();
            link_down_at_valid = true;
        }
#ifndef PICO_POE_MINIMAL
        // Reap streaming PCBs immediately so the small MEMP_NUM_TCP_PCB
        // pool is free for the browser's reconnect SYNs the moment the
        // cable returns. Without this they sit in keepalive limbo for
        // ~50 s and the reconnects time out.
        http_server_on_link_down();
#endif
    }
}

static void status_callback(struct netif *netif) {
    const ip4_addr_t *ip = netif_ip4_addr(netif);
    if (ip->addr != 0) {
        snprintf(g_ip_str, sizeof(g_ip_str), "%s", ip4addr_ntoa(ip));
        printf("[net] IP: %s\n", g_ip_str);
    }
}

int network_init(void) {
    g_boot_time = get_absolute_time();

    // Set system clock to 100 MHz BEFORE arch_pico_init() —
    // the submodule has clock setup commented out, so we must do it.
    // PIO divider 100/100 = 1.0 → clean 50 MHz RMII clock, no jitter.
    set_sys_clock_khz(100000, true);

    // Initialize PoE status pin (GP27) as input with pull-down
    gpio_init(PICO_POE_POE_STATUS_PIN);
    gpio_set_dir(PICO_POE_POE_STATUS_PIN, GPIO_IN);
    gpio_pull_down(PICO_POE_POE_STATUS_PIN);

    // Board-level init (resets PHY, sets EN_1V8, configures clock, stdio_init_all)
    arch_pico_init();

    printf("[net] System clock: %lu Hz\n", (unsigned long)clock_get_hz(clk_sys));

    // Initialize lwIP
    lwip_init();

    // Initialize the RMII Ethernet interface
    if (netif_rmii_ethernet_init(&g_netif) != ERR_OK) {
        printf("[net] RMII init failed\n");
        return -1;
    }

    // Print board diagnostics
    arch_pico_info(&g_netif);

    // Read PHY status register for immediate diagnostics
    uint16_t bsr = netif_rmii_ethernet_mdio_read(phy_address, LAN8720A_BASIC_STATUS_REG);
    printf("[net] PHY BSR: 0x%04x (link=%d autoneg_done=%d)\n",
           bsr, (bsr >> 2) & 1, (bsr >> 5) & 1);

    // Format MAC address string
    snprintf(g_mac_str, sizeof(g_mac_str),
             "%02X:%02X:%02X:%02X:%02X:%02X",
             g_netif.hwaddr[0], g_netif.hwaddr[1], g_netif.hwaddr[2],
             g_netif.hwaddr[3], g_netif.hwaddr[4], g_netif.hwaddr[5]);
    printf("[net] MAC: %s\n", g_mac_str);

    // Set callbacks
    netif_set_link_callback(&g_netif, link_callback);
    netif_set_status_callback(&g_netif, status_callback);

    // Bring interface up with static IP (matching working pro-xct pattern)
    netif_set_default(&g_netif);
    {
        ip4_addr_t ip, mask, gw;
        ip4addr_aton(PICO_POE_STATIC_IP, &ip);
        ip4addr_aton(PICO_POE_STATIC_MASK, &mask);
        ip4addr_aton(PICO_POE_STATIC_GW, &gw);
        netif_set_addr(&g_netif, &ip, &mask, &gw);
    }
    netif_set_up(&g_netif);

    printf("[net] Static IP: %s\n", PICO_POE_STATIC_IP);

    return 0;
}

struct netif *network_get_netif(void) {
    return &g_netif;
}

bool network_is_link_up(void) {
    return netif_is_link_up(&g_netif);
}

bool network_has_ip(void) {
    return netif_ip4_addr(&g_netif)->addr != 0;
}

const char *network_get_ip_str(void) {
    const ip4_addr_t *ip = netif_ip4_addr(&g_netif);
    if (ip->addr != 0) {
        snprintf(g_ip_str, sizeof(g_ip_str), "%s", ip4addr_ntoa(ip));
    } else {
        snprintf(g_ip_str, sizeof(g_ip_str), "0.0.0.0");
    }
    return g_ip_str;
}

const char *network_get_mac_str(void) {
    return g_mac_str;
}

uint32_t network_get_uptime_s(void) {
    return absolute_time_diff_us(g_boot_time, get_absolute_time()) / 1000000;
}

bool network_get_poe_status(void) {
    return gpio_get(PICO_POE_POE_STATUS_PIN);
}

void network_poll(void) {
    // No-op: all lwIP work happens on Core 1 via netif_rmii_ethernet_loop
}
