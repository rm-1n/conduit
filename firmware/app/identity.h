// identity.h — IDENTITY partition reader.
//
// The IDENTITY partition (id=2 in firmware/bootloader/partitions.json,
// 8 KB, family `absolute`) holds a per-device commissioning blob that
// the host-side `commission flash-identity` tool writes via picotool.
// The blob carries:
//
//   - the device's unique-id (lowercase hex of pico_get_unique_board_id)
//   - a PKCS#8 EC P-256 private key (DER)
//   - the matching X.509 cert chain (PEM, leaf + intermediates)
//
// Phase 1 of the TLS work loads the blob into RAM and exposes pointers
// via conduit_identity_get(). Phase 2 will hand those pointers to
// mbedtls + altcp_tls so the device serves HTTPS without click-through
// cert warnings, against the per-device wildcard
// `*.<unique_id>.devices.rm1n.com` issued at commissioning time.
//
// The byte layout is the contract with the host-side encoder at
// `commission/commission/identity.py` in the conduit-dns repo. Keep
// the two in lockstep — the host encoder is the spec, this decoder
// must round-trip what it produces.
//
//   offset  size   field         notes
//   ------  -----  ------------  -------------------------------------
//   0       4      magic         ASCII "CIDP"
//   4       2      version       uint16 LE, currently 1
//   6       2      reserved      0x0000
//   8       64     unique_id     nul-padded ASCII (max 63 chars + \0)
//   72      4      key_len       uint32 LE
//   76      4      cert_len      uint32 LE
//   80      key_len   key_der    PKCS#8 EC P-256 private key (DER)
//   80+kl   cert_len  cert_pem   ASCII PEM, full chain
//   ...     ...    0xFF padding  fills to byte 8160
//   8160    32     sha256        SHA-256 of bytes [0, 8160)
//   total: 8192 bytes
//
// Threading: conduit_identity_load() runs once during init on Core 0
// before Core 1 launches. The static buffer the parsed pointers alias
// into is read-only after that; conduit_identity_get() is safe from
// any thread.

#ifndef CONDUIT_IDENTITY_H
#define CONDUIT_IDENTITY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CONDUIT_IDENTITY_MAGIC          "CIDP"
#define CONDUIT_IDENTITY_MAGIC_LEN      4
#define CONDUIT_IDENTITY_VERSION        1
#define CONDUIT_IDENTITY_BLOB_SIZE      8192
#define CONDUIT_IDENTITY_HEADER_LEN     80
#define CONDUIT_IDENTITY_TRAILER_LEN    32
#define CONDUIT_IDENTITY_BODY_LEN       (CONDUIT_IDENTITY_BLOB_SIZE - CONDUIT_IDENTITY_TRAILER_LEN)
#define CONDUIT_IDENTITY_MAX_PAYLOAD    (CONDUIT_IDENTITY_BODY_LEN - CONDUIT_IDENTITY_HEADER_LEN)
#define CONDUIT_IDENTITY_UID_MAX        63

typedef struct {
    char           unique_id[CONDUIT_IDENTITY_UID_MAX + 1]; // null-terminated
    const uint8_t *key_der;        // points into the static blob buffer
    size_t         key_len;
    const char    *cert_pem;       // points into the static blob buffer
    size_t         cert_len;
} conduit_identity_t;

// Parse + validate an in-memory blob. Pure function with no IO so it's
// host-testable. `blob` MUST remain valid for as long as `out` is read,
// because the cert/key pointers in `out` alias into it. `len` must be
// exactly CONDUIT_IDENTITY_BLOB_SIZE.
//
// Validation order (cheapest first): length, magic, version, reserved,
// length-fields-fit, sha256 trailer. Returns false at the first
// failure. On success, `out` is fully populated.
bool conduit_identity_parse(const uint8_t *blob, size_t len,
                            conduit_identity_t *out);

// Locate the IDENTITY partition via the bootrom, copy 8 KB into a
// static buffer, validate, populate `out`. Idempotent — subsequent
// calls return the cached parse without re-reading flash.
//
// Returns false if the partition is missing, the blob is malformed,
// or the SHA-256 trailer doesn't match. The firmware should still
// boot in that case (over plain HTTP, no TLS); only the Phase 2 TLS
// listener depends on a successful load.
bool conduit_identity_load(conduit_identity_t *out);

// Read-only accessor. Returns NULL if conduit_identity_load() has not
// been called or has not yet returned true. Cheap; no flash access.
const conduit_identity_t *conduit_identity_get(void);

#endif // CONDUIT_IDENTITY_H
