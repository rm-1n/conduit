// test_ota_ring.c — host-side unit tests for the OTA ring buffer.
//
// Compiled with -DOTA_RING_HOSTTEST so the spinlock is shimmed to a
// no-op (single-threaded host harness). Verifies the partial-accept,
// full-block-drain, and wrap-around invariants the firmware relies on.
//
// Each case prints PASS or FAIL with a short tag; exit code is the
// number of failures so CI gates on `./test_ota_ring == 0`.

#include "../app/ota_ring.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int g_failures = 0;

#define CHECK(cond, tag) do {                                               \
    if (cond) { printf("PASS  %s\n", tag); }                                \
    else { printf("FAIL  %s  (%s:%d)\n", tag, __FILE__, __LINE__); g_failures++; } \
} while (0)

static void reset_state(void) {
    ota_ring_reset();
}

static void test_init_empty(void) {
    ota_ring_init();
    reset_state();
    CHECK(ota_ring_used() == 0,                       "init_empty: used == 0");
    CHECK(ota_ring_free_space() == OTA_RING_SIZE,     "init_empty: free == OTA_RING_SIZE");
}

static void test_write_then_drain_one_block(void) {
    ota_ring_init();
    reset_state();
    uint8_t in[512], out[512];
    for (int i = 0; i < 512; i++) in[i] = (uint8_t)(i & 0xff);
    size_t wrote = ota_ring_write(in, 512);
    CHECK(wrote == 512,                               "drain_one: full write accepted");
    size_t drained = ota_ring_drain_one_block(out);
    CHECK(drained == 512,                             "drain_one: drain returned 512");
    CHECK(memcmp(in, out, 512) == 0,                  "drain_one: contents match");
    CHECK(ota_ring_used() == 0,                       "drain_one: ring empty after");
}

static void test_drain_returns_zero_under_block(void) {
    ota_ring_init();
    reset_state();
    uint8_t in[511] = {0};
    uint8_t out[512];
    size_t wrote = ota_ring_write(in, 511);
    CHECK(wrote == 511,                               "under_block: 511 accepted");
    size_t drained = ota_ring_drain_one_block(out);
    CHECK(drained == 0,                               "under_block: drain refuses partial");
    CHECK(ota_ring_used() == 511,                     "under_block: bytes still buffered");
    uint8_t one = 0;
    ota_ring_write(&one, 1);
    drained = ota_ring_drain_one_block(out);
    CHECK(drained == 512,                             "under_block: drain succeeds at 512");
}

static void test_write_drain_interleave(void) {
    ota_ring_init();
    reset_state();
    uint32_t baseline_short = ota_ring_short_writes();
    uint8_t in[700];
    uint8_t out[512];
    size_t total_in = 0, total_out = 0;
    for (int iter = 0; iter < 100; iter++) {
        for (int i = 0; i < 700; i++) in[i] = (uint8_t)((iter + i) & 0xff);
        total_in += ota_ring_write(in, 700);
        while (ota_ring_used() >= 512) {
            size_t d = ota_ring_drain_one_block(out);
            if (d == 0) break;
            total_out += d;
        }
    }
    CHECK(total_in == 70000,                          "interleave: total_in == 70000");
    CHECK(total_out == 69632,                         "interleave: total_out == 69632 (136*512)");
    CHECK(ota_ring_used() == total_in - total_out,    "interleave: used balances");
    CHECK(ota_ring_short_writes() == baseline_short,  "interleave: no short writes (drained between)");
}

static void test_partial_accept_when_full(void) {
    ota_ring_init();
    reset_state();
    uint32_t baseline_short = ota_ring_short_writes();
    uint8_t big[OTA_RING_SIZE];
    for (size_t i = 0; i < OTA_RING_SIZE; i++) big[i] = (uint8_t)(i & 0xff);
    size_t wrote = ota_ring_write(big, OTA_RING_SIZE);
    CHECK(wrote == OTA_RING_SIZE,                     "partial_full: filled to capacity");
    uint8_t pad[1000] = {0};
    size_t rej = ota_ring_write(pad, 1000);
    CHECK(rej == 0,                                   "partial_full: second write rejected");
    CHECK(ota_ring_short_writes() == baseline_short + 1, "partial_full: short_writes++ on rejection");
    uint8_t out[512];
    size_t drained = ota_ring_drain_one_block(out);
    CHECK(drained == 512,                             "partial_full: drain freed 512");
    size_t partial = ota_ring_write(pad, 1000);
    CHECK(partial == 512,                             "partial_full: third write took exactly 512");
    CHECK(ota_ring_short_writes() == baseline_short + 2, "partial_full: short_writes++ on partial");
}

static void test_wraparound(void) {
    ota_ring_init();
    reset_state();
    // Fill most of the ring, drain most of it, then write across the
    // wrap boundary and verify byte-by-byte against the producer's
    // pattern. Catches off-by-one errors in the bit-mask wrap.
    uint8_t out[512];
    uint8_t big[16000];
    for (size_t i = 0; i < 16000; i++) big[i] = (uint8_t)(i & 0xff);
    size_t wrote = ota_ring_write(big, 16000);
    CHECK(wrote == 16000,                             "wrap: filled 16000");
    size_t drained_total = 0;
    for (int i = 0; i < 31; i++) {
        size_t d = ota_ring_drain_one_block(out);
        if (d == 0) break;
        // Each block should match big[drained_total .. +512].
        if (memcmp(out, big + drained_total, 512) != 0) {
            CHECK(0,                                  "wrap: block-content drift mid-drain");
            return;
        }
        drained_total += d;
    }
    CHECK(drained_total == 31 * 512,                  "wrap: drained 31 blocks");
    CHECK(ota_ring_used() == 16000 - drained_total,   "wrap: used = 128 after partial drain");
    // Now write 1024 more bytes. At this point head ~ 17024 (>16384) so
    // the writes wrap. Pattern continues from 16000.
    uint8_t more[1024];
    for (size_t i = 0; i < 1024; i++) more[i] = (uint8_t)((16000 + i) & 0xff);
    size_t w2 = ota_ring_write(more, 1024);
    CHECK(w2 == 1024,                                 "wrap: post-wrap write accepted");
    // Drain 2 blocks: first 384 bytes still tail of `big`, then bytes
    // from `more`. Build expected pattern.
    uint8_t expected[1024];
    memcpy(expected, big + drained_total, 16000 - drained_total);                 // 128 bytes
    memcpy(expected + (16000 - drained_total), more, 1024 - (16000 - drained_total)); // 896 bytes
    uint8_t got[1024];
    size_t d1 = ota_ring_drain_one_block(got);
    size_t d2 = ota_ring_drain_one_block(got + 512);
    CHECK(d1 == 512 && d2 == 512,                     "wrap: two post-wrap blocks drained");
    CHECK(memcmp(got, expected, 1024) == 0,           "wrap: post-wrap bytes intact");
}

static void test_reset_clears_state(void) {
    ota_ring_init();
    reset_state();
    uint8_t in[1000] = {0};
    ota_ring_write(in, 1000);
    uint8_t out[512];
    ota_ring_drain_one_block(out);
    CHECK(ota_ring_used() == 488,                     "reset: pre-reset used == 488");
    ota_ring_reset();
    CHECK(ota_ring_used() == 0,                       "reset: used == 0 after reset");
    CHECK(ota_ring_free_space() == OTA_RING_SIZE,     "reset: free restored");
}

int main(void) {
    test_init_empty();
    test_write_then_drain_one_block();
    test_drain_returns_zero_under_block();
    test_write_drain_interleave();
    test_partial_accept_when_full();
    test_wraparound();
    test_reset_clears_state();
    printf("\n%d failures\n", g_failures);
    return g_failures;
}
