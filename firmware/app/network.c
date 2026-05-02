#include "network.h"
#include "pico_poe_config.h"
#include "http_server.h"

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
// (TX SM stuck) or the Fritz!Box was ignoring them. The recovery has
// to be louder and self-triggering. 5s tick + 2 stall ticks = ~10s
// detection latency, which is acceptable for a wedge.
#define WEDGE_TICK_MS         5000
#define WEDGE_STALL_TICKS     2

static volatile uint32_t g_wedge_recoveries = 0;
uint32_t network_get_wedge_recoveries(void) { return g_wedge_recoveries; }

static void wedge_check_cb(void *arg) {
    struct netif *netif = (struct netif *)arg;

    // Driver-side counters. We read into locals because the volatile
    // values can move between the comparison checks below.
    extern volatile uint32_t g_rmii_rx_frames;
    extern volatile uint32_t g_rmii_rx_to_us;
    uint32_t rx  = g_rmii_rx_frames;
    uint32_t rxu = g_rmii_rx_to_us;

    static uint32_t last_rx = 0;
    static uint32_t last_rxu = 0;
    static uint8_t  stall_ticks = 0;
    static uint8_t  consecutive_recoveries = 0;
    static bool     was_link_up = false;
    #define WEDGE_RECOVERIES_BEFORE_PHY_RESET 2

    bool link_up = netif_is_link_up(netif);
    bool rx_climbing  = (rx  != last_rx);
    bool rxu_climbing = (rxu != last_rxu);

    if (!link_up) {
        // Link down — reset state, nothing to do until it comes back.
        stall_ticks = 0;
    } else if (!was_link_up) {
        // First tick after link came up — counters are about to start
        // moving; don't count this as a stall sample.
        stall_ticks = 0;
    } else if (rxu_climbing) {
        // Healthy: unicast is arriving. Clear the stall counter and
        // emit a routine announce + gateway-probe to refresh upstream
        // MAC tables (the gateway probe also keeps our ARP entry in
        // its table warm). Also clear the consecutive-recoveries count
        // since the path is proven good.
        stall_ticks = 0;
        consecutive_recoveries = 0;
        announce_tick_cb(netif);
    } else if (rx_climbing) {
        // Wedge fingerprint: rx climbs (broadcasts arriving, RX path
        // healthy) but rxu doesn't (unicast to us missing). Count
        // consecutive stall ticks; trigger recovery once we've seen
        // STALL_TICKS in a row to avoid false positives on a
        // momentarily quiet LAN.
        stall_ticks++;
        if (stall_ticks >= WEDGE_STALL_TICKS) {
            consecutive_recoveries++;
            if (consecutive_recoveries >= WEDGE_RECOVERIES_BEFORE_PHY_RESET) {
                // Soft recovery (TX SM reset + announce burst) has
                // already failed N times in a row without rxu
                // climbing — escalate to a full PHY hard-reset.
                // Costs ~200 ms and a brief link blip, but this is
                // the only path that's actually re-presented the
                // device on the wire after sticky upstream-MAC-table
                // failures (Fritz!Box class issues).
                printf("[net] TX wedge persists after %u soft recoveries — "
                       "escalating to PHY hard-reset\n",
                       consecutive_recoveries);
                netif_rmii_ethernet_phy_reset();
                // The link blip from PHY reset will trip
                // link_callback's down→up path, which fires its own
                // gARP burst. Reset the consecutive count so we give
                // the new link state a clean window to prove itself.
                consecutive_recoveries = 0;
            } else {
                printf("[net] TX wedge detected (rxu flat for %us, rx +%u, "
                       "soft recovery #%u) — resetting TX path + "
                       "announce/gw-probe burst\n",
                       stall_ticks * (WEDGE_TICK_MS / 1000),
                       (unsigned)(rx - last_rx),
                       consecutive_recoveries);
                netif_rmii_ethernet_reset_tx_path();
                announce_tick_cb(netif);     // immediate gARP + gw probe
                schedule_garp_burst(netif);  // 4 more spread over 5 s
            }
            __atomic_add_fetch(&g_wedge_recoveries, 1, __ATOMIC_RELAXED);
            stall_ticks = 0;
        }
    } else {
        // Truly idle LAN (no rx, no rxu). Don't count as a stall —
        // there's no traffic to compare against. Still kick an
        // announce + gateway probe so upstream entries don't age out
        // and we keep proving the unicast path works.
        announce_tick_cb(netif);
    }

    last_rx = rx;
    last_rxu = rxu;
    was_link_up = link_up;

    // Diagnostic: prove the tick is alive. If we stop seeing this print
    // every ~5s while debugging the wedge, the sys_timeout chain
    // is broken (probably pool exhaustion — see MEMP_NUM_SYS_TIMEOUT
    // in lwipopts.h).
    printf("[net] wedge tick: link=%d stall=%u rxu_d=%d rx_d=%d\n",
           link_up, stall_ticks,
           rxu_climbing ? 1 : 0, rx_climbing ? 1 : 0);

    sys_timeout(WEDGE_TICK_MS, wedge_check_cb, netif);
}

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
    // Static struct can't be initialised with compound literal `nil_time`
    // (not a constant expression), so use a `_valid` flag to mark whether
    // the timestamp has been set since boot / since the last replug.
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
        if (real_replug) {
            // Triple-recovery on a real cable replug. Direct-link
            // testing (no switch in path) showed that the netif toggle
            // alone allows ONE transmit (the gratuitous ARP) and then
            // the PIO TX state machine wedges — apparently the first
            // packet sent into the freshly-disturbed PHY corrupts the
            // SM state. Resetting the TX SM AFTER the netif toggle
            // unsticks it; we then send the gARP through a known-good
            // TX path.
            printf("[net] real cable replug — toggling netif + resetting TX SM\n");
            netif_set_down(netif);
            netif_set_up(netif);
            netif_rmii_ethernet_reset_tx_path();
        }
        // Tell upstream switches/routers that our MAC is back on this
        // port, without waiting for them to ARP for us.
        etharp_gratuitous(netif);
        if (real_replug) {
            // One immediate gARP isn't enough on a Fritz!Box: by the
            // time it leaves the wire the upstream port may still be
            // in settle/learn mode and drop it. Burst 4 more across
            // 5 s so at least one lands while the upstream is ready.
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
        // Reap streaming PCBs immediately so the small MEMP_NUM_TCP_PCB
        // pool is free for the browser's reconnect SYNs the moment the
        // cable returns. Without this they sit in keepalive limbo for
        // ~50 s and the reconnects time out.
        http_server_on_link_down();
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

    // Arm the active TX-wedge detector. Re-arms itself every tick;
    // safe to leave running across cable cycles.
    sys_timeout(WEDGE_TICK_MS, wedge_check_cb, &g_netif);

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
