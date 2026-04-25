#ifndef __LWIPOPTS_H__
#define __LWIPOPTS_H__

// NO_SYS mode — no RTOS
#define NO_SYS                          1
#define MEM_ALIGNMENT                   4
#define LWIP_RAW                        1
#define LWIP_NETCONN                    0
#define LWIP_SOCKET                     0
#define LWIP_DHCP                       1
#define LWIP_AUTOIP                     1
#define LWIP_DHCP_AUTOIP_COOP           1
#define LWIP_ICMP                       1
#define LWIP_UDP                        1
#define LWIP_TCP                        1
#define ETH_PAD_SIZE                    0
#define LWIP_IP_ACCEPT_UDP_PORT(p)      ((p) == PP_NTOHS(67))

// Callbacks
#define LWIP_NETIF_LINK_CALLBACK        1
#define LWIP_NETIF_STATUS_CALLBACK      1

// TCP tuning
#define TCP_MSS                         (1500 - 20 - 20)
#define TCP_SND_BUF                     (4 * TCP_MSS)
#define TCP_WND                         (4 * TCP_MSS)
#define MEMP_NUM_TCP_SEG                16
#define MEMP_NUM_PBUF                   16
#define PBUF_POOL_SIZE                  16

// Memory pool — need enough for OTA upload buffering
#define MEM_SIZE                        8192

// We use raw TCP API, no httpd
#define LWIP_HTTPD_CGI                  0
#define LWIP_HTTPD_SSI                  0

#endif /* __LWIPOPTS_H__ */
