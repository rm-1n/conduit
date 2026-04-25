#ifndef NETWORK_H
#define NETWORK_H

#include "lwip/netif.h"
#include <stdbool.h>
#include <stdint.h>

// Initialize the RMII Ethernet interface with DHCP + static fallback
// Returns 0 on success, -1 on failure
int network_init(void);

// Get the network interface
struct netif *network_get_netif(void);

// Check if the network link is up
bool network_is_link_up(void);

// Check if we have an IP address (DHCP or static)
bool network_has_ip(void);

// Get the current IP address as a string (static buffer)
const char *network_get_ip_str(void);

// Get the MAC address as a string (static buffer, "XX:XX:XX:XX:XX:XX")
const char *network_get_mac_str(void);

// Get uptime in seconds
uint32_t network_get_uptime_s(void);

// Check PoE status (GP27)
bool network_get_poe_status(void);

// Must be called periodically from the main loop (handles DHCP fallback)
void network_poll(void);

#endif // NETWORK_H
