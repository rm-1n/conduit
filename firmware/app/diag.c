// diag.c — single-line forensic heartbeat printed by Core 0.
//
// We hit a hang where Core 0 happily reported `link=1 ip=...` for hours
// while the device was unreachable from the LAN. That meant Core 1 (or
// the lwIP state Core 1 owns) had wedged silently — the PHY's BSR still
// said link, but the firmware-side path was dead, and nothing in the
// existing diagnostic told us which subsystem failed.
//
// This file gathers signals that fingerprint each likely failure mode:
//   • Core 1 liveness counter — incremented on every pass through the
//     loop wrapper in main.c. Zero delta = Core 1 deadlocked.
//   • lwIP heap (MEM_SIZE) used/max — saturation = mem_malloc starts
//     returning NULL and lwIP drops things silently.
//   • pbuf-pool used/max — same idea for the per-pool MEMP allocator.
//   • TCP PCB census (active/time-wait/listen) — monotonic growth in
//     active = client leak (browsers vanishing without FIN/RST).
//   • Link-layer RX/TX totals + delta since the last print — zero RX
//     delta with link=up means MAC stalled while PHY still reports up.
//
// Light enough for production: one printf per second, no allocations,
// no locking (Core 1 counter is atomic, lwIP stats are owned by Core 1
// but read-only access from Core 0 is safe for our purposes — at worst
// we print a value torn between updates, which is fine for a heartbeat).

#include "diag.h"

#include <stdio.h>

#include "lwip/stats.h"
#include "lwip/tcp.h"
#include "lwip/priv/tcp_priv.h"
#include "lwip/memp.h"

#include "network.h"
#include "ota.h"
#include "http_server.h"
#include "rmii_ethernet/netif.h"

// g_core1_iter lives in main.c (so the minimal-firmware build can also
// reference it without dragging diag.c in). diag.h declares it extern.

// Walk the three TCP-PCB lists and count entries. Cheap (lists are at
// most a few items) and avoids allocating.
static void count_tcp_pcbs(unsigned *active, unsigned *tw, unsigned *listen) {
    unsigned a = 0, t = 0, l = 0;
    for (struct tcp_pcb *p = tcp_active_pcbs; p; p = p->next) a++;
    for (struct tcp_pcb *p = tcp_tw_pcbs;     p; p = p->next) t++;
    // Listen PCBs are a different (smaller) struct kept in a union.
    for (struct tcp_pcb_listen *p = tcp_listen_pcbs.listen_pcbs; p; p = p->next) l++;
    *active = a; *tw = t; *listen = l;
}

void diag_print_line(void) {
    // Core 1 liveness — atomic load + delta from previous print.
    static uint32_t last_c1 = 0;
    uint32_t c1 = __atomic_load_n(&g_core1_iter, __ATOMIC_RELAXED);
    uint32_t dc1 = c1 - last_c1;
    last_c1 = c1;

    // lwIP heap and pbuf-pool fill levels. lwip_stats lives in BSS and
    // is updated in-line by the allocator hooks — no atomicity needed
    // for an observation print.
    // .mem is the heap struct itself (so we take its address).
    // .memp is `struct stats_mem *memp[MEMP_MAX]` — the array entries
    // are already pointers, no extra `&` needed.
    const struct stats_mem *m  = &lwip_stats.mem;
    const struct stats_mem *pb =  lwip_stats.memp[MEMP_PBUF_POOL];
    const struct stats_mem *tc =  lwip_stats.memp[MEMP_TCP_PCB];

    // TCP PCB census.
    unsigned tcp_a = 0, tcp_tw = 0, tcp_l = 0;
    count_tcp_pcbs(&tcp_a, &tcp_tw, &tcp_l);

    // Link-layer RX/TX packet counters (cumulative since boot) + delta
    // since last print. recv = inbound passed up the stack; xmit = sent
    // out on the wire. Either staying flat for sustained periods while
    // link reports up is the smoking gun for a wedged MAC.
    // lwIP's LINK_STATS counters are never bumped on this driver's code
    // path (the rmii driver doesn't go through ethernet_input). Use the
    // driver's own counters instead — bumped after every input handoff
    // (rxf) and at every entry to linkoutput (txa). If rxf climbs while
    // txa stays flat post-cable-cycle, lwIP isn't trying to reply (e.g.
    // SYNs aren't reaching higher layers); if both climb but the network
    // stays dead, the device's responses aren't leaving the wire.
    extern volatile uint32_t g_rmii_rx_frames;
    extern volatile uint32_t g_rmii_tx_attempts;
    // Finer-grained: rxu = unicast frames matching our MAC (switch is
    // forwarding to us); rxs = TCP SYNs to us specifically. The pair
    // disambiguates "switch lost us" from "lwIP swallowed the SYN".
    extern volatile uint32_t g_rmii_rx_to_us;
    extern volatile uint32_t g_rmii_rx_tcp_syn;
    static u32_t last_rx = 0, last_tx = 0, last_acpt = 0, last_strm = 0;
    static u32_t last_rxu = 0, last_rxs = 0;
    u32_t rx   = g_rmii_rx_frames;
    u32_t tx   = g_rmii_tx_attempts;
    u32_t rxu  = g_rmii_rx_to_us;
    u32_t rxs  = g_rmii_rx_tcp_syn;
    u32_t acpt = http_server_accepts();
    u32_t strm = http_server_streams_started();
    u32_t drx   = rx   - last_rx;
    u32_t dtx   = tx   - last_tx;
    u32_t drxu  = rxu  - last_rxu;
    u32_t drxs  = rxs  - last_rxs;
    u32_t dacpt = acpt - last_acpt;
    u32_t dstrm = strm - last_strm;
    last_rx = rx; last_tx = tx; last_acpt = acpt; last_strm = strm;
    last_rxu = rxu; last_rxs = rxs;

    // lwIP internal drop counters — pinpoint where post-cable-cycle
    // SYNs disappear. ipdrop counts IP packets dropped (wrong dest IP,
    // netif down, etc.); tcpdrop counts TCP packets dropped (no
    // matching PCB, etc.); tcperr counts TCP errors (checksum, malformed).
    // If acpt doesn't climb but ipdrop/tcpdrop/tcperr do, we know where
    // lwIP is silently rejecting the SYNs.
    u32_t ipdrop  = lwip_stats.ip.drop;
    u32_t tcpdrop = lwip_stats.tcp.drop;
    u32_t tcperr  = lwip_stats.tcp.err;
    u32_t tcpchk  = lwip_stats.tcp.chkerr;
    static u32_t last_ipdrop = 0, last_tcpdrop = 0, last_tcperr = 0, last_tcpchk = 0;
    u32_t dipdrop  = ipdrop  - last_ipdrop;
    u32_t dtcpdrop = tcpdrop - last_tcpdrop;
    u32_t dtcperr  = tcperr  - last_tcperr;
    u32_t dtcpchk  = tcpchk  - last_tcpchk;
    last_ipdrop = ipdrop; last_tcpdrop = tcpdrop; last_tcperr = tcperr; last_tcpchk = tcpchk;

    // MDIO comms reliability — bad reads (BSR=0xFFFF responses) /
    // total reads. A non-trivial baseline ratio means our bit-bang
    // is dropping bits, not just the PHY tristating during recovery.
    uint32_t mdio_total = netif_rmii_ethernet_mdio_total_reads();
    uint32_t mdio_bad   = netif_rmii_ethernet_mdio_bad_reads();

    printf("[diag] link=%d ip=%s c1=%lu(+%lu) "
           "heap=%lu/%lu pbuf=%u/%u tcp_pcb=%u/%u "
           "tcp=%ua/%ut/%ul rx=%lu(+%lu) tx=%lu(+%lu) "
           "rxu=%lu(+%lu) rxs=%lu(+%lu) "
           "acpt=%lu(+%lu) strm=%lu(+%lu) "
           "ipdrop=%lu(+%lu) tcpdrop=%lu(+%lu) tcperr=%lu(+%lu) tcpchk=%lu(+%lu) "
           "mdio=%lu/%lu wedge_rec=%lu commit_pending=%d\n",
           network_is_link_up(), network_get_ip_str(),
           (unsigned long)c1, (unsigned long)dc1,
           (unsigned long)m->used,  (unsigned long)m->avail,
           (unsigned)pb->used, (unsigned)pb->avail,
           (unsigned)tc->used, (unsigned)tc->avail,
           tcp_a, tcp_tw, tcp_l,
           (unsigned long)rx,      (unsigned long)drx,
           (unsigned long)tx,      (unsigned long)dtx,
           (unsigned long)rxu,     (unsigned long)drxu,
           (unsigned long)rxs,     (unsigned long)drxs,
           (unsigned long)acpt,    (unsigned long)dacpt,
           (unsigned long)strm,    (unsigned long)dstrm,
           (unsigned long)ipdrop,  (unsigned long)dipdrop,
           (unsigned long)tcpdrop, (unsigned long)dtcpdrop,
           (unsigned long)tcperr,  (unsigned long)dtcperr,
           (unsigned long)tcpchk,  (unsigned long)dtcpchk,
           (unsigned long)mdio_bad, (unsigned long)mdio_total,
           (unsigned long)network_get_wedge_recoveries(),
           (int)ota_commit_pending());
}
