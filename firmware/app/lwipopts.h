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
// Multicast TX requires IGMP for the device to advertise group
// membership on the LAN (per RFC 1112). The discovery module sends
// to 239.255.42.42:5354 once per second so the conduit-cli can find
// the device by unique-id; without IGMP the upstream switch may
// drop the multicast frames before they leave the wire.
#define LWIP_IGMP                       1
#define ETH_PAD_SIZE                    0
#define LWIP_IP_ACCEPT_UDP_PORT(p)      ((p) == PP_NTOHS(67))

// Callbacks
#define LWIP_NETIF_LINK_CALLBACK        1
#define LWIP_NETIF_STATUS_CALLBACK      1

// TCP tuning
//
// At 1 kHz × 2 channels × ~20 B/record = 40 KB/s telemetry, http_poll
// must drain ~4 KB per ~100 ms slow-timer tick (TCP_TMR_INTERVAL=50,
// slow timer = 2× = 100 ms). The previous TCP_SND_BUF of 4×MSS = 5840 B
// was *technically* enough per tick, but the in-memory `out[2048]` cap
// in http_server.c capped real throughput at 2 KB/tick = 20 KB/s, half
// the production rate. The 32 KB data ring then overflowed at ~1.6 s
// and `data_buffer_read` clamped its cursor forward, dropping samples
// — the browser sees this as periodic ~50 ms uptime_us voids. Bumping
// the send buffer + segment pool gives http_poll headroom to push a
// full ~12 KB per tick (with the matching out[8192] bump) and still
// leaves slack for retransmits.
#define TCP_MSS                         (1500 - 20 - 20)
#define TCP_SND_BUF                     (12 * TCP_MSS)
#define TCP_WND                         (12 * TCP_MSS)
#define MEMP_NUM_TCP_SEG                48
#define MEMP_NUM_PBUF                   24
#define PBUF_POOL_SIZE                  24

// Bumped from lwIP default 5. The two streaming endpoints
// (/api/data?stream=1 and /api/log?stream=1) each pin a PCB for the
// life of the browser session, plus short-lived /api/status, /api/cmd,
// /api/upload, /api/commit, /api/reboot. With only 5, half-dead PCBs
// from a vanished client (no FIN/RST — browser tab put to sleep, OS
// VPN drop, etc.) accumulate and lock the device out: the LED keeps
// blinking but no new connections succeed. Keepalive (below) is the
// cleanup mechanism; the bump is a safety margin while keepalive
// probes do their work.
#define MEMP_NUM_TCP_PCB                8

// lwIP's default LWIP_NUM_SYS_TIMEOUT_INTERNAL on this build is 2
// (LWIP_TCP + LWIP_ARP). That's only enough for the cyclic system
// timers and leaves no room for app-scheduled sys_timeout calls
// (our wedge_check_cb tick + 4 burst gARPs after a cable replug).
// When the pool exhausts, sys_timeout silently drops the request,
// which we caught when the wedge auto-recovery stopped re-arming
// after its first fire. 16 is comfortable headroom.
#define MEMP_NUM_SYS_TIMEOUT            16

// TCP keepalive — opt-in per PCB via SOF_KEEPALIVE. http_server.c
// turns it on for /api/data?stream=1 and /api/log?stream=1 because
// those are the connections that can sit idle from the device's POV
// (server pushes, client just consumes). Defaults below: probe after
// 30 s idle, then every 5 s, drop the PCB after 4 missed acks. So a
// vanished client costs us ~50 s, then the PCB is reclaimed.
#define LWIP_TCP_KEEPALIVE              1

// Tighter TCP timer cadence so /api/log and /api/data streaming flushes
// happen every ~100 ms instead of every ~500 ms (tcp_poll runs off the
// slow timer = 2 × TCP_TMR_INTERVAL). At 250 Hz emit rates this turns the
// browser-visible "data dump every 500 ms" cadence into smooth 25-record
// batches every 100 ms — chart renders cleanly without visible step jumps.
//
// All TCP timeouts (RTO, persist, FIN-WAIT-2, etc.) are stored in ticks of
// TCP_SLOW_INTERVAL but computed from ms at PCB-alloc time, so real-time
// behaviour is unchanged — only resolution improves. CPU cost is one extra
// tcp_tmr() call every ~50 ms (microseconds of work per call).
#define TCP_TMR_INTERVAL                50

// Memory pool — need enough for OTA upload buffering
#define MEM_SIZE                        8192

// Stats — explicit so the firmware-side diag.c heartbeat can read
// real numbers for heap, MEMP pools, and link layer. Defaults are
// supposed to be on, but a chained #include or compiler define can
// silently zero them; pinning here keeps the diag stream meaningful.
#define LWIP_STATS                      1
#define MEM_STATS                       1
#define MEMP_STATS                      1
#define LINK_STATS                      1
#define TCP_STATS                       1

// We use raw TCP API, no httpd
#define LWIP_HTTPD_CGI                  0
#define LWIP_HTTPD_SSI                  0

#endif /* __LWIPOPTS_H__ */
