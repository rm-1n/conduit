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

volatile uint32_t g_core1_iter = 0;

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
    static u32_t last_rx = 0, last_tx = 0;
    u32_t rx = lwip_stats.link.recv;
    u32_t tx = lwip_stats.link.xmit;
    u32_t drx = rx - last_rx;
    u32_t dtx = tx - last_tx;
    last_rx = rx; last_tx = tx;

    printf("[diag] link=%d ip=%s c1=%lu(+%lu) "
           "heap=%lu/%lu pbuf=%u/%u tcp_pcb=%u/%u "
           "tcp=%ua/%ut/%ul rx=%lu(+%lu) tx=%lu(+%lu) commit_pending=%d\n",
           network_is_link_up(), network_get_ip_str(),
           (unsigned long)c1, (unsigned long)dc1,
           (unsigned long)m->used,  (unsigned long)m->avail,
           (unsigned)pb->used, (unsigned)pb->avail,
           (unsigned)tc->used, (unsigned)tc->avail,
           tcp_a, tcp_tw, tcp_l,
           (unsigned long)rx, (unsigned long)drx,
           (unsigned long)tx, (unsigned long)dtx,
           (int)ota_commit_pending());
}
