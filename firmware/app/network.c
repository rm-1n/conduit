#include "network.h"
#include "pico_poe_config.h"

#include "pico/stdlib.h"
#include "hardware/gpio.h"
#include "hardware/clocks.h"
#include "hardware/vreg.h"

#include "lwip/init.h"
#include "lwip/dhcp.h"
#include "lwip/autoip.h"
#include "lwip/ip4_addr.h"

#include "rmii_ethernet/netif.h"
#include "lan8720a.h"

static struct netif g_netif;
static absolute_time_t g_boot_time;
static char g_ip_str[16];
static char g_mac_str[18];

static void link_callback(struct netif *netif) {
    printf("[net] link %s\n", netif_is_link_up(netif) ? "up" : "down");
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
