/**
 * PICO-POE Application Entry Point
 *
 * Core 0: Network init → HTTP server → diagnostics
 * Core 1: RMII Ethernet polling loop (all lwIP work happens here)
 */

#include "pico/stdlib.h"
#include "pico/stdio_usb.h"
#include "pico/multicore.h"
#include "pico/bootrom.h"
#include "pico/flash.h"
#include "hardware/watchdog.h"

#include "network.h"
#include "http_server.h"
#include "ota.h"
#include "log_buffer.h"
#include "data_buffer.h"
#include "commands.h"
#include "pico_poe_config.h"
#include "rmii_ethernet/netif.h"
#include "lan8720a.h"
#include "diag.h"

// Symbol from the rmii_ethernet driver — the inner step of its loop.
// We call this from our own wrapper instead of the driver's loop so we
// can bump g_core1_iter every iteration and Core 0 can detect a Core-1
// stall on the next heartbeat. This is the SAME work the driver's
// netif_rmii_ethernet_loop() does (poll → sys_check_timeouts inside);
// we're just adding the counter.
extern void netif_rmii_ethernet_poll(void);

// Hardware watchdog timeout. Longer than any single legitimate stall in
// the main loop (typical sleep_ms(1000) + diagnostic print). If we're
// stuck somewhere blocking for >2 s, the chip resets. Combined with
// PICO_CRT0_IMAGE_TYPE_TBYB, a reset before ota_commit() makes the ROM
// roll back to the previous partition on the next boot.
//
// 2 s (down from 4) — the longest legitimate stall in the loop is the
// sleep_ms(1000) heartbeat plus the printf, comfortably under 1.5 s on
// the worst observed run. Tighter recovery from soft Core-0 hangs.
#define WATCHDOG_TIMEOUT_MS 2000

// Arduino-style user hooks. The browser IDE (web/) compiles user C source
// into an object file that provides strong definitions for these two
// symbols; the weak defaults here are no-ops so the firmware still links
// and boots when no user code has been uploaded.
//
//   pico_poe_setup() — called once, after network/HTTP/core1 are up.
//   pico_poe_loop()  — called at 1 kHz on core 0, between watchdog pats.
//
// The loop hook runs alongside lwIP on core 1, so heavy CPU work in user
// code won't starve the ethernet/HTTP server. The rate is intentionally
// sleep-based (sleep_us) rather than hardware-timer-driven — simpler, and
// good enough for blink/GPIO/sensor-poll use cases. Users who need a
// precise periodic interrupt should set one up inside pico_poe_setup().
__attribute__((weak)) void pico_poe_setup(void) {}
__attribute__((weak)) void pico_poe_loop(void)  {}

// rom_reboot() configures the same hardware watchdog to fire after its
// delay_ms. Core 0's main loop calls watchdog_update() every 1 ms, which
// RESETS that scheduled fire so it never happens. When the HTTP or OTA
// handler (running on core 1) wants to reboot, it sets this flag; the main
// loop then stops patting and lets rom_reboot's countdown complete.
volatile bool g_reboot_pending = false;

#define USER_LOOP_PERIOD_US 1000    // 1 kHz
#define DIAG_PRINT_EVERY    1000    // once per ~1 s

// lwIP and the HTTP callbacks run on core 1, which means OTA flash writes
// are issued from core 1. flash_safe_execute on core 1 needs core 0 to be
// registered as a lockout victim. We also register core 1 so the mechanism
// is symmetric if anything on core 0 ever needs to write flash too.
static void core1_entry(void) {
    flash_safe_execute_core_init();
    // Run the same loop the driver would, but tick g_core1_iter on every
    // pass so Core 0's heartbeat can prove Core 1 is still alive.
    // netif_rmii_ethernet_poll() already calls sys_check_timeouts() at
    // the end (see firmware/lib/pico-rmii-ethernet_nce/src/rmii_ethernet.c).
    while (1) {
        netif_rmii_ethernet_poll();
        __atomic_add_fetch(&g_core1_iter, 1, __ATOMIC_RELAXED);
    }
}

int main() {
    // network_init() calls arch_pico_init() which does stdio_init_all() + sleep_ms(2000)
    // So we just call network_init() directly — it handles everything.

    if (network_init() != 0) {
        printf("[main] Network init failed, halting\n");
        while (1) tight_loop_contents();
    }

    // Initialize the runtime-console ring buffer. log() routes here (NOT
    // to USB stdio); printf stays USB-only for local debugging.
    log_buffer_init();
    // Binary data ring backing transmit(). Init early so user code in
    // pico_poe_setup() (or the first iteration of pico_poe_loop()) can
    // call transmit() without missing the auto-registration step.
    data_buffer_init();
    // Register built-in /api/cmd handlers (gpio_*, adc_read). User code
    // can poe_command_register() additional handlers from pico_poe_setup().
    commands_init();

    printf("\n=== PICO-POE v%s ===\n", PICO_POE_VERSION_STRING);

    // Latch boot_type / TBYB-pending state before anything else can touch
    // the bootrom. Needed for /api/status and /api/commit semantics.
    ota_init_boot_state();

    // Seed the runtime console with a boot banner so users see something
    // immediately when the web IDE attaches, even before their own log()
    // calls fire. Firmware calls poe_log() directly; user code uses the
    // `log` alias defined in pico_poe_user.h.
    poe_log("[poe] firmware v%s booted (%s), ip %s\n",
            PICO_POE_VERSION_STRING, ota_boot_type_str(), network_get_ip_str());

    // Start the HTTP API server (registers callbacks, no lwIP polling here)
    http_server_init();

    // Read PHY registers before launching Core 1 (avoids MDIO bus race)
    uint16_t bsr = netif_rmii_ethernet_mdio_read(phy_address, LAN8720A_BASIC_STATUS_REG);
    printf("[main] PHY BSR=0x%04x (link=%d autoneg=%d)\n",
           bsr, (bsr >> 2) & 1, (bsr >> 5) & 1);

    // Register core 0 as a flash_safe_execute victim BEFORE launching core 1.
    // OTA runs on core 1 (inside the lwIP HTTP callbacks) and needs to lock
    // out core 0 during each flash erase/program. Without this, core 1's
    // flash_safe_execute returns PICO_ERROR_NOT_PERMITTED.
    flash_safe_execute_core_init();

    // Launch Ethernet polling on Core 1 via the shim that also registers
    // core 1 as a victim (symmetric safety).
    multicore_launch_core1(core1_entry);

    printf("[main] Core 1 launched, entering diagnostic loop\n");

#ifdef PICO_POE_SIMULATE_HANG
    // Rollback sanity check: pretend we wedged just after init. Watchdog
    // will reset us before COMMIT_AFTER_TICKS, ROM rolls back to the
    // previous partition because explicit_buy never ran.
    watchdog_enable(WATCHDOG_TIMEOUT_MS, true);
    printf("[main] PICO_POE_SIMULATE_HANG set — hanging forever\n");
    while (1) tight_loop_contents();
#endif

    // Arm the hardware watchdog. If we stop patting it — because of a hang
    // anywhere on core 0 or a severe wedge on core 1 that blocks our
    // diagnostic print — the chip resets. On a TBYB boot (after OTA), a
    // reset before rom_explicit_buy rolls back to the previous partition.
    watchdog_enable(WATCHDOG_TIMEOUT_MS, true);

    // Run user-supplied one-shot setup before entering the periodic loop.
    // The web IDE ships a strong definition that overrides the weak stub
    // at the top of this file.
    pico_poe_setup();

    // Main loop — Core 0 runs user's 1 kHz loop hook, pats the watchdog,
    // and prints a diagnostic line every ~1 s. No lwIP calls from here
    // (those live on core 1). The commit that clears TBYB is intentionally
    // NOT done here: it happens only when the uploading client POSTs
    // /api/commit, proving bidirectional reachability. If that commit
    // never arrives, the watchdog keeps patting on this loop until power
    // is cycled, at which point the ROM rolls back to the previous
    // partition.
    // Network-health watchdog. If the PHY link reports DOWN continuously
    // for HEALTH_LINK_DOWN_LIMIT_MS while the device is running normally
    // (not mid-OTA, not already rebooting), we kick a reboot via the
    // standard g_reboot_pending path. The PHY poller in the RMII driver
    // flips netif up/down within 500 ms of cable changes, so a brief
    // unplug/replug never trips this; only a sustained outage does.
    // Restart is the only reliable recovery for cases like a wedged PHY
    // or a half-dead lwIP state where the link is "up" at the driver
    // but the stack can't accept new connections.
    #define HEALTH_LINK_DOWN_LIMIT_MS  60000
    absolute_time_t link_down_since = nil_time;
    bool last_link_up = network_is_link_up();
    unsigned int iter = 0;
    while (1) {
        // Atomic load so the flag written from core 1 (lwIP TCP callback)
        // is observed promptly on core 0. A plain `volatile` read was not
        // enough in practice — we kept patting the watchdog right past the
        // flag flip and the scheduled reset never fired.
        if (__atomic_load_n(&g_reboot_pending, __ATOMIC_ACQUIRE)) {
            // Stop doing anything: don't pat the watchdog, don't run the
            // user loop, don't even advance the iter counter. The reset
            // programmed by rom_reboot / watchdog_reboot will fire within
            // its scheduled delay_ms.
            static bool announced = false;
            if (!announced) { announced = true; printf("[main] reboot_pending observed — stopping watchdog pat\n"); }
            tight_loop_contents();
            continue;
        }
        watchdog_update();
        pico_poe_loop();

        // Health check — once per diag print interval (≈ 1 s) is plenty
        // of resolution for a 60-second grace window.
        if (++iter >= DIAG_PRINT_EVERY) {
            iter = 0;
            bool link_up = network_is_link_up();
            if (link_up != last_link_up) {
                printf("[health] link transition: %s\n", link_up ? "DOWN→UP" : "UP→DOWN");
                last_link_up = link_up;
                if (!link_up) link_down_since = get_absolute_time();
                else          link_down_since = nil_time;
            }
            if (!link_up && !is_nil_time(link_down_since)) {
                int64_t down_ms = absolute_time_diff_us(link_down_since, get_absolute_time()) / 1000;
                if (down_ms >= HEALTH_LINK_DOWN_LIMIT_MS && !ota_commit_pending()) {
                    printf("[health] link down for %lld ms — scheduling reboot\n", (long long)down_ms);
                    __atomic_store_n(&g_reboot_pending, true, __ATOMIC_RELEASE);
                    watchdog_reboot(0, 0, 200);
                }
            }
            diag_print_line();
        }
        sleep_us(USER_LOOP_PERIOD_US);
    }

    return 0;
}
