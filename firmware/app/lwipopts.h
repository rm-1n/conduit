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
// TCP receive window — must be LARGER than the biggest TLS record
// the peer can send, otherwise mbedtls can never accumulate enough
// encrypted bytes in its input buffer to decrypt one record. With
// `MBEDTLS_SSL_IN_CONTENT_LEN = 16384`, peers (curl/OpenSSL default)
// send 16 KB plaintext records ≈ 16 KB + ~40 B TLS framing encrypted.
// 11680-byte windows (8*MSS) starved this: peer fills the window with
// a partial record, mbedtls has nothing to deliver to http_recv,
// tcp_recved is never called for those encrypted bytes, window stays
// at 0, deadlock.
//
// 16*MSS = 23360 B fits one full TLS record with comfortable slack
// (~6.5 KB). The ring buffer (firmware/app/ota_ring.h) is sized 32 KB,
// safely larger than this window.
//
// The producer/consumer OTA refactor (Core 0 drainer + deferred
// altcp_recved in http_server.c) makes any in-window throughput
// realistic — the recv callback is non-blocking, lwIP slides the
// window as Core 0 catches up.
#define TCP_WND                         (16 * TCP_MSS)
// Segment pool — generous headroom; cost is ~50 KB SRAM.
#define MEMP_NUM_TCP_SEG                96
// Pbuf pool — bumped 24 → 64 along with the TCP_WND drop. The TCP_WND
// change alone bounds *peer* in-flight bytes, but lwIP also queues
// pbufs for our own pending sends and for the small periodic
// keepalive traffic (telemetry record headers, log keepalives).
// 64 pbufs * ~1.5 KB each = ~96 KB SRAM headroom; trivial vs the
// 520 KB chip total.
#define MEMP_NUM_PBUF                   64
#define PBUF_POOL_SIZE                  64

// Bumped from lwIP default 5. The two streaming endpoints
// (/api/data?stream=1 and /api/log?stream=1) each pin a PCB for the
// life of the browser session, plus short-lived /api/status, /api/cmd,
// /api/upload, /api/commit, /api/reboot. With only 5, half-dead PCBs
// from a vanished client (no FIN/RST — browser tab put to sleep, OS
// VPN drop, etc.) accumulate and lock the device out: the LED keeps
// blinking but no new connections succeed. Keepalive (below) is the
// cleanup mechanism; the bump is a safety margin while keepalive
// probes do their work.
// Bumped 8 → 24 because OTA via the conduit CLI / web IDE opens a fresh
// TCP connection per 8 KB chunk (47 chunks for a typical app), and at 8
// PCBs the pool exhausts: lwIP starts RST'ing new SYNs and OTA dies
// with "Connection reset by peer". 24 leaves comfortable headroom for
// short-lived OTA chunks plus the two listening pcbs (HTTP + HTTPS),
// plus persistent browser streams (/api/log + /api/data). Each pcb is
// ~140 B → ~2.2 KB extra SRAM, trivial. The proper fix is HTTP/1.1
// keep-alive on the OTA path so all chunks share one TCP connection;
// that's a CLI + IDE change for a follow-up.
#define MEMP_NUM_TCP_PCB                24

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
// Bumped DOWN to 25 once as a HTTPS-OTA throughput experiment (halves
// http_poll cadence so ota_pump_ack credits the window twice as often).
// It also broke mbedtls — TLS handshake started failing on fresh
// connections, status fetches returned nothing. Likely interaction
// with mbedtls's record-level timers or the altcp_tls_mbedtls flush
// path that assumes ~50 ms tick granularity. 50 ms is the proven safe
// value; do not lower without a thorough TLS regression sweep.
//
// All TCP timeouts (RTO, persist, FIN-WAIT-2, etc.) are stored in ticks
// of TCP_SLOW_INTERVAL but computed from ms at PCB-alloc time, so
// real-time behaviour is unchanged — only resolution improves. CPU
// cost is one extra tcp_tmr() call every ~50 ms (microseconds of work
// per call).
#define TCP_TMR_INTERVAL                50

// Memory pool. Backs lwIP-internal allocations: pbufs (PBUF_RAM),
// TCP segments not in the MEMP pool, altcp per-pcb state.
//
// Historical note: this was bumped 48 → 192 KB to fix "TLS handshake
// returns ERR_MEM after ~5 OTA cycles". That diagnosis was wrong —
// mbedtls without MBEDTLS_PLATFORM_MEMORY uses libc calloc, which
// goes to the newlib heap (NOT this pool). The 192 KB bump still
// "fixed" the symptom because dragging up MEM_SIZE happened to shift
// BSS, which shrank the newlib heap and rearranged where its
// fragmenting allocations landed — a coincidence.
//
// 128 KB. Per-session lwIP heap demand under active streaming is
// ~17 KB (small mbedtls handshake/session bookkeeping that the slab
// doesn't intercept, plus pbuf chains and altcp per-pcb state). With
// 3 concurrent sessions that's ~51 KB on top of ~32 KB of static
// lwIP allocations, totalling ~84 KB under load. At 96 KB MEM_SIZE
// that left only ~14 KB headroom — a fresh HTTPS handshake's
// allocations exceeded it and the device RST'd. 128 KB gives a
// comfortable ~45 KB of free heap under realistic streaming load.
//
// BSS budget recovered by dropping mbedtls_slab.c from 4 → 3 slots
// (-25 KB) and HTTP_CONN_POOL from 8 → 5 (where the firmware really
// needs at most 2 streams + 1 OTA + 1 control + 1 transient = 5).
#define MEM_SIZE                        131072

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

// altcp + altcp_tls — http_server.c uses the altcp API for both the
// plain-HTTP listener (port 80) and the TLS listener (port 443). Both
// flags are required to compile altcp_tls_mbedtls.c into the build.
// pico_lwip_mbedtls is linked from app/CMakeLists.txt; the MBEDTLS_*
// configuration lives there too.
#define LWIP_ALTCP                      1
#define LWIP_ALTCP_TLS                  1
#define LWIP_ALTCP_TLS_MBEDTLS          1

// TLS session tickets (RFC 5077). Browser/CLI presents the ticket from
// a previous handshake; mbedtls validates it and skips the expensive
// ECDHE+ECDSA path — abbreviated handshake completes in well under
// 200 ms vs the ~2.8 s cold handshake. See mbedtls_config.h for the
// matching MBEDTLS_SSL_SESSION_TICKETS / MBEDTLS_SSL_TICKET_C flags
// the altcp glue tests for at compile time.
#define ALTCP_MBEDTLS_USE_SESSION_TICKETS  1

#endif /* __LWIPOPTS_H__ */
