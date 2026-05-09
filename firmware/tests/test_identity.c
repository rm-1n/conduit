// test_identity.c — host-side unit tests for the IDENTITY blob parser.
//
// Built by firmware/tests/Makefile with the host's clang/gcc — NOT the
// arm-none-eabi cross-compiler. Compiles identity.c with the
// CONDUIT_IDENTITY_HOSTTEST guard so the bootrom-dependent IO half is
// excluded; the pure parser plus sha256.c link cleanly on macOS or
// Linux without a Pico SDK on PATH.
//
// Coverage:
//   - golden round-trip: pack a known cert/key/uid into a blob, parse,
//     assert each field matches.
//   - sha256 known-answer: NIST FIPS 180-2 vector "abc" → ba7816bf...
//   - rejects: wrong magic, wrong version, non-zero reserved, no UID
//     terminator, oversize length fields, corrupted trailer.
//   - boundary: empty cert + empty key, max-payload cert, fully-padded
//     blob with sha computed over the body.
//
// Each case prints PASS or FAIL with a short tag, exit code is the
// number of failures so CI can gate on `./test_identity == 0`.

#include "../app/identity.h"
#include "../app/sha256.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int g_failures = 0;

#define CHECK(cond, tag) do {                                        \
    if (cond) { printf("PASS  %s\n", tag); }                         \
    else      { printf("FAIL  %s  (%s:%d)\n", tag, __FILE__, __LINE__); g_failures++; } \
} while (0)

// Build an 8 KB blob with the given fields and a correctly-computed
// SHA-256 trailer. Returns the populated buffer (caller-supplied 8192
// bytes). Padding is 0xFF up to the trailer offset.
static void build_blob(uint8_t blob[CONDUIT_IDENTITY_BLOB_SIZE],
                       const char *uid, size_t uid_len,
                       const uint8_t *key, size_t key_len,
                       const char *cert, size_t cert_len,
                       uint16_t version, uint16_t reserved) {
    memset(blob, 0xFF, CONDUIT_IDENTITY_BLOB_SIZE);
    memcpy(blob, CONDUIT_IDENTITY_MAGIC, CONDUIT_IDENTITY_MAGIC_LEN);
    blob[4] = (uint8_t)(version & 0xFF);
    blob[5] = (uint8_t)(version >> 8);
    blob[6] = (uint8_t)(reserved & 0xFF);
    blob[7] = (uint8_t)(reserved >> 8);
    // unique_id field, nul-padded
    memset(blob + 8, 0, 64);
    memcpy(blob + 8, uid, uid_len);
    // key_len, cert_len
    blob[72] = (uint8_t)(key_len & 0xFF);
    blob[73] = (uint8_t)((key_len >> 8) & 0xFF);
    blob[74] = (uint8_t)((key_len >> 16) & 0xFF);
    blob[75] = (uint8_t)((key_len >> 24) & 0xFF);
    blob[76] = (uint8_t)(cert_len & 0xFF);
    blob[77] = (uint8_t)((cert_len >> 8) & 0xFF);
    blob[78] = (uint8_t)((cert_len >> 16) & 0xFF);
    blob[79] = (uint8_t)((cert_len >> 24) & 0xFF);
    // payload
    memcpy(blob + 80, key, key_len);
    memcpy(blob + 80 + key_len, cert, cert_len);
    // trailer = sha256 of body [0, 8160)
    conduit_sha256(blob, CONDUIT_IDENTITY_BODY_LEN, blob + CONDUIT_IDENTITY_BODY_LEN);
}

static void test_sha256_known_answer(void) {
    // NIST FIPS 180-2 §B.1: "abc" → BA7816BF8F01CFEA414140DE5DAE2223
    //                              B00361A396177A9CB410FF61F20015AD
    const uint8_t expected[32] = {
        0xba,0x78,0x16,0xbf,0x8f,0x01,0xcf,0xea,0x41,0x41,0x40,0xde,0x5d,0xae,0x22,0x23,
        0xb0,0x03,0x61,0xa3,0x96,0x17,0x7a,0x9c,0xb4,0x10,0xff,0x61,0xf2,0x00,0x15,0xad,
    };
    uint8_t got[32];
    conduit_sha256("abc", 3, got);
    CHECK(memcmp(got, expected, 32) == 0, "sha256/abc");

    // Empty input — well-known: e3b0c44298fc1c149afbf4c8996fb924
    //                            27ae41e4649b934ca495991b7852b855
    const uint8_t expected_empty[32] = {
        0xe3,0xb0,0xc4,0x42,0x98,0xfc,0x1c,0x14,0x9a,0xfb,0xf4,0xc8,0x99,0x6f,0xb9,0x24,
        0x27,0xae,0x41,0xe4,0x64,0x9b,0x93,0x4c,0xa4,0x95,0x99,0x1b,0x78,0x52,0xb8,0x55,
    };
    conduit_sha256("", 0, got);
    CHECK(memcmp(got, expected_empty, 32) == 0, "sha256/empty");

    // 1 MB of 'a' — exercises the multi-block path beyond the 8 KB
    // identity blob's typical 128-block run, useful for catching
    // length-bit-counter overflow bugs.
    static uint8_t big[1024 * 1024];
    memset(big, 'a', sizeof(big));
    const uint8_t expected_megaa[32] = {
        0x9b,0xc1,0xb2,0xa2,0x88,0xb2,0x6a,0xf7,0x25,0x7a,0x36,0x27,0x7a,0xe3,0x81,0x6a,
        0x7d,0x4f,0x16,0xe8,0x9c,0x1e,0x7e,0x77,0xd0,0xa5,0xc4,0x8b,0xad,0x62,0xb3,0x60,
    };
    conduit_sha256(big, sizeof(big), got);
    CHECK(memcmp(got, expected_megaa, 32) == 0, "sha256/1MB-of-a");
}

static void test_golden_roundtrip(void) {
    // Mimics the real-world commissioning case: 16-char hex unique-id
    // (matches RP2350 board id), small EC P-256 PKCS#8 (~121 B), short
    // PEM cert chain (~2 KB).
    const char uid[] = "29166ac0e5917701";
    uint8_t key[121];
    for (size_t i = 0; i < sizeof(key); i++) key[i] = (uint8_t)(i * 7 + 3);
    char cert[2200];
    memset(cert, 0, sizeof(cert));
    static const char head[] = "-----BEGIN CERTIFICATE-----\n";
    static const char tail[] = "\n-----END CERTIFICATE-----";
    memcpy(cert, head, sizeof(head) - 1);
    for (size_t i = sizeof(head) - 1; i < sizeof(cert) - (sizeof(tail) - 1); i++) {
        cert[i] = (char)('A' + (i % 26));
    }
    memcpy(cert + sizeof(cert) - (sizeof(tail) - 1), tail, sizeof(tail) - 1);

    uint8_t blob[CONDUIT_IDENTITY_BLOB_SIZE];
    build_blob(blob, uid, strlen(uid),
               key, sizeof(key),
               cert, sizeof(cert),
               CONDUIT_IDENTITY_VERSION, 0);

    conduit_identity_t out;
    bool ok = conduit_identity_parse(blob, sizeof(blob), &out);
    CHECK(ok, "golden/parse-ok");
    if (!ok) return;
    CHECK(strcmp(out.unique_id, uid) == 0,           "golden/uid");
    CHECK(out.key_len == sizeof(key),                "golden/key_len");
    CHECK(out.cert_len == sizeof(cert),              "golden/cert_len");
    CHECK(memcmp(out.key_der, key, sizeof(key)) == 0,   "golden/key_bytes");
    CHECK(memcmp(out.cert_pem, cert, sizeof(cert)) == 0, "golden/cert_bytes");
    // Pointers alias into the blob buffer.
    CHECK(out.key_der  == blob + CONDUIT_IDENTITY_HEADER_LEN, "golden/key_ptr");
    CHECK(out.cert_pem == (const char *)(blob + CONDUIT_IDENTITY_HEADER_LEN + sizeof(key)), "golden/cert_ptr");
}

static void test_rejects(void) {
    const char uid[] = "test-device-01";
    uint8_t key[64], cert[128];
    memset(key, 0xAB, sizeof(key));
    memset(cert, 0xCD, sizeof(cert));

    uint8_t blob[CONDUIT_IDENTITY_BLOB_SIZE];
    conduit_identity_t out;

    // Wrong length
    build_blob(blob, uid, strlen(uid), key, sizeof(key), (char *)cert, sizeof(cert), CONDUIT_IDENTITY_VERSION, 0);
    CHECK(!conduit_identity_parse(blob, CONDUIT_IDENTITY_BLOB_SIZE - 1, &out), "reject/short-len");
    CHECK(!conduit_identity_parse(blob, CONDUIT_IDENTITY_BLOB_SIZE + 1, &out), "reject/long-len");
    CHECK(!conduit_identity_parse(NULL, CONDUIT_IDENTITY_BLOB_SIZE, &out),     "reject/null-blob");
    CHECK(!conduit_identity_parse(blob, CONDUIT_IDENTITY_BLOB_SIZE, NULL),     "reject/null-out");

    // Wrong magic
    build_blob(blob, uid, strlen(uid), key, sizeof(key), (char *)cert, sizeof(cert), CONDUIT_IDENTITY_VERSION, 0);
    blob[0] = 'X';
    // re-hash so trailer is still valid — isolates the magic check
    conduit_sha256(blob, CONDUIT_IDENTITY_BODY_LEN, blob + CONDUIT_IDENTITY_BODY_LEN);
    CHECK(!conduit_identity_parse(blob, sizeof(blob), &out), "reject/bad-magic");

    // Wrong version
    build_blob(blob, uid, strlen(uid), key, sizeof(key), (char *)cert, sizeof(cert), 99, 0);
    CHECK(!conduit_identity_parse(blob, sizeof(blob), &out), "reject/bad-version");

    // Non-zero reserved
    build_blob(blob, uid, strlen(uid), key, sizeof(key), (char *)cert, sizeof(cert), CONDUIT_IDENTITY_VERSION, 0xBEEF);
    CHECK(!conduit_identity_parse(blob, sizeof(blob), &out), "reject/nonzero-reserved");

    // No UID terminator (fill all 64 bytes of the field with 'A')
    build_blob(blob, uid, strlen(uid), key, sizeof(key), (char *)cert, sizeof(cert), CONDUIT_IDENTITY_VERSION, 0);
    memset(blob + 8, 'A', 64);
    conduit_sha256(blob, CONDUIT_IDENTITY_BODY_LEN, blob + CONDUIT_IDENTITY_BODY_LEN);
    CHECK(!conduit_identity_parse(blob, sizeof(blob), &out), "reject/uid-no-nul");

    // Oversize lengths (key_len + cert_len > MAX_PAYLOAD)
    build_blob(blob, uid, strlen(uid), key, sizeof(key), (char *)cert, sizeof(cert), CONDUIT_IDENTITY_VERSION, 0);
    uint32_t huge = CONDUIT_IDENTITY_MAX_PAYLOAD;  // alone equals max
    blob[72] = (uint8_t)(huge & 0xFF);
    blob[73] = (uint8_t)((huge >> 8) & 0xFF);
    blob[74] = (uint8_t)((huge >> 16) & 0xFF);
    blob[75] = (uint8_t)((huge >> 24) & 0xFF);
    blob[76] = 1; blob[77] = 0; blob[78] = 0; blob[79] = 0;  // +1 byte → over
    conduit_sha256(blob, CONDUIT_IDENTITY_BODY_LEN, blob + CONDUIT_IDENTITY_BODY_LEN);
    CHECK(!conduit_identity_parse(blob, sizeof(blob), &out), "reject/oversize-payload");

    // Corrupted trailer
    build_blob(blob, uid, strlen(uid), key, sizeof(key), (char *)cert, sizeof(cert), CONDUIT_IDENTITY_VERSION, 0);
    blob[CONDUIT_IDENTITY_BODY_LEN] ^= 0x01;
    CHECK(!conduit_identity_parse(blob, sizeof(blob), &out), "reject/bad-sha");
}

static void test_boundary(void) {
    const char uid[] = "x";
    uint8_t blob[CONDUIT_IDENTITY_BLOB_SIZE];
    conduit_identity_t out;

    // Empty key + empty cert. Valid — the parser allows zero-length
    // payload as long as header + sha are consistent.
    build_blob(blob, uid, strlen(uid), NULL, 0, NULL, 0, CONDUIT_IDENTITY_VERSION, 0);
    bool ok = conduit_identity_parse(blob, sizeof(blob), &out);
    CHECK(ok, "boundary/empty-payload-ok");
    if (ok) {
        CHECK(out.key_len == 0,  "boundary/empty-key_len");
        CHECK(out.cert_len == 0, "boundary/empty-cert_len");
    }

    // Maximum payload exactly fills the body — no padding bytes.
    static uint8_t big_cert[CONDUIT_IDENTITY_MAX_PAYLOAD];
    for (size_t i = 0; i < sizeof(big_cert); i++) big_cert[i] = (uint8_t)(i & 0x7F);
    build_blob(blob, uid, strlen(uid),
               NULL, 0,
               (const char *)big_cert, sizeof(big_cert),
               CONDUIT_IDENTITY_VERSION, 0);
    ok = conduit_identity_parse(blob, sizeof(blob), &out);
    CHECK(ok, "boundary/max-payload-ok");
    if (ok) CHECK(out.cert_len == CONDUIT_IDENTITY_MAX_PAYLOAD, "boundary/max-cert_len");

    // Maximum-length unique_id (63 chars + nul).
    char big_uid[CONDUIT_IDENTITY_UID_MAX + 1];
    memset(big_uid, 'q', CONDUIT_IDENTITY_UID_MAX);
    big_uid[CONDUIT_IDENTITY_UID_MAX] = 0;
    build_blob(blob, big_uid, CONDUIT_IDENTITY_UID_MAX,
               NULL, 0, NULL, 0,
               CONDUIT_IDENTITY_VERSION, 0);
    ok = conduit_identity_parse(blob, sizeof(blob), &out);
    CHECK(ok, "boundary/max-uid-ok");
    if (ok) CHECK(strlen(out.unique_id) == CONDUIT_IDENTITY_UID_MAX, "boundary/max-uid-len");
}

int main(void) {
    test_sha256_known_answer();
    test_golden_roundtrip();
    test_rejects();
    test_boundary();
    if (g_failures == 0) {
        printf("\nALL TESTS PASSED\n");
        return 0;
    }
    printf("\n%d test(s) FAILED\n", g_failures);
    return g_failures;
}
