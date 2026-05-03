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

// One announce + one gateway probe. The gARP refreshes upstream switch
// MAC tables (broadcast frame, src=our MAC). The gateway probe is an
// ARP REQUEST asking the gateway to identify itself — its reply is
// unicast addressed to our MAC, which (a) forces the upstream switch
// to handle a unicast-to-us frame again and (b) lets us self-test the
// unicast RX path: if our rxu counter doesn't tick after we elicit a
// reply, we know the wedge is still in place even after the kick.
//
// Both skipped if link dropped between scheduling and firing.
// Runs on the lwIP thread (Core 1) since sys_check_timeouts is driven
// from there.
static void announce_tick_cb(void *arg) {
    struct netif *netif = (struct netif *)arg;
    if (!netif_is_link_up(netif)) return;
    etharp_gratuitous(netif);
    const ip4_addr_t *gw = netif_ip4_gw(netif);
    if (gw && gw->addr != 0) {
        etharp_request(netif, gw);
    }
}

// After a real cable replug or wedge-detect recovery, fire a burst of
// (gARP + gateway-probe) over ~5 s instead of a single immediate kick.
//
// Why: testing on a Fritz!Box showed that after multiple replug cycles
// the device wedged with link=1, broadcasts climbing (rx healthy), but
// rxu / acpt frozen — i.e. NO unicast frames addressed to our MAC
// arrived. Either the upstream switch's MAC table didn't latch our
// announce (port still in settle/learn when it fired), or the frame
// itself never made it onto the wire because the PIO TX SM was still
// recovering from the prior link-down DMA abort. Spreading 4 kicks
// across 5 s gives the upstream multiple chances to lock our MAC.
// Each kick includes the gateway-probe so we get an externally-
// elicited unicast reply — the cleanest signal the path is alive.
static void schedule_garp_burst(struct netif *netif) {
    sys_timeout(500,  announce_tick_cb, netif);
    sys_timeout(1500, announce_tick_cb, netif);
    sys_timeout(3000, announce_tick_cb, netif);
    sys_timeout(5000, announce_tick_cb, netif);
}

// Active TX-wedge detector + recovery. Self-rearms every TICK_MS.
//
// What it does each tick:
//   1. Sends a gARP if link is up — this serves as both "switch MAC
//      table refresh" (so quiet upstreams don't age out our entry)
//      AND a TX-path liveness probe.
//   2. Reads driver counters (g_rmii_rx_frames, g_rmii_rx_to_us) and
//      checks for the wedge fingerprint: "link claims up, broadcasts
//      arriving, but no unicast addressed to us for STALL_TICKS in a
//      row." That means the upstream switch has lost our MAC entry
//      AND our gARPs aren't refreshing it (either they're not leaving
//      the wire because the PIO TX SM is wedged, or the upstream is
//      ignoring the announces). Both responses are the same: kick the
//      TX SM and fire a burst of gARPs.
//
// Why active polling instead of passive heartbeat: in testing, a
// passive 30s gARP heartbeat would fire after cable replug but not
// recover the upstream — either the gARPs weren't reaching the wire
// (TX SM stuck) or the Fritz!Box was ignoring them. The recovery
// has to be louder and self-triggering.
//
// g_wedge_recoveries kept as a counter for backward-compat (diag.c
// surfaces it; once that reference is removed too this can go).
static volatile uint32_t g_wedge_recoveries = 0;
uint32_t network_get_wedge_recoveries(void) { return g_wedge_recoveries; }

// REMOVED 2026-05-03: wedge_check_cb. The whole wedge-detect-and-
// recover apparatus (PHY link cycle on rxu stall, BCR.PowerDown
// kick on sustained link-down) was built when the MDIO bit-bang
// returned 60 % bad reads at 50 kHz MDC — we couldn't trust BSR,
// so we layered active recovery on top. Lowering MDC to 25 kHz
// made the bit-bang reliable, and live testing then showed the
// recoveries themselves were causing cascading link flaps that
// hurt more than helped. The driver's own 500 ms BSR poll +
// link_callback handle real link transitions correctly now.

static void link_callback(struct netif *netif) {
    bool up = netif_is_link_up(netif);
    // Distinguish a real cable replug from PHY auto-neg flapping.
    // After a real replug, the LAN8720A produces several brief
    // (0.6-1.3 s) link DOWN/UP transitions while it settles into
    // 100Base-TX with the link partner. The recovery (netif toggle +
    // TX SM reset) is invasive — firing it on every flap leaves lwIP
    // in a confused state. 2 s is comfortably above the auto-neg
    // settle window and well below any plausible deliberate cable
    // swap, so we only run recovery on the first transition that's
    // had >=2 s of confirmed link-down.
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
        // ALWAYS reset the RX path on link-up, regardless of how
        // long the link was down. The PIO RX SM clocks off our
        // generated REF_CLK and samples RX0/RX1/CRS_DV from the
        // PHY; any down→up transition (real cable replug OR
        // brief auto-neg settle flap) phase-shifts the SM relative
        // to RX_DV. Every subsequent frame then fails FCS — visible
        // as g_rmii_rx_crc_errors climbing while rxu / rxs stay
        // flat. Multi-cycle test 2026-05-03: with the reset gated
        // behind real_replug (≥2 s down), quick replugs (down<2 s)
        // wedged for 3.8–11 s; with the reset on every link-up,
        // recovery is consistently <500 ms (median 253 ms). Cost
        // is ~50 µs and the reset is idempotent, so firing it on
        // auto-neg flaps is harmless.
        //
        // We MUST NOT call reset_tx_path here: the TX SM sidesets
        // RETCLK (= REF_CLK to the PHY) every cycle. Stopping it
        // momentarily kills REF_CLK, which forces the PHY's RX
        // path to re-sync from scratch — making the wedge worse,
        // not better.
        netif_rmii_ethernet_reset_rx_path();
        if (real_replug) {
            // The lwIP-side state cycle is heavier (clears ARP
            // cache, drops netif state) and IS disruptive to any
            // active TCP connection. Keep it gated behind the
            // ≥2 s `real_replug` guard so brief auto-neg flaps
            // don't tear down working sessions.
            netif_set_down(netif);
            netif_set_up(netif);
        }
        // Tell upstream switches/routers that our MAC is back on this
        // port. With reliable MDIO + reset_tx_path above, this gARP
        // actually leaves the wire and the switch re-learns us.
        etharp_gratuitous(netif);
        if (real_replug) {
            // One immediate gARP isn't enough on some upstreams
            // (Fritz!Box-class L2): the port may still be in
            // settle/learn mode when the first gARP arrives. Burst
            // 4 more spaced across 5 s so at least one lands while
            // the upstream is ready.
            schedule_garp_burst(netif);
        }
    } else {
        // Record when the link went down — used to gate the toggle
        // above on the next link-up. Only set on the FIRST down so
        // subsequent flaps during a real outage don't reset the clock
        // and make every flap look like a "fresh" disconnect.
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
