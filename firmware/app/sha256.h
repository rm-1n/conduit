// sha256.h — minimal standalone SHA-256.
//
// One-shot helper used by identity.c to verify the integrity trailer
// on the IDENTITY partition blob. Vendored locally instead of pulling
// in mbedtls so Phase 1 doesn't drag the whole TLS stack into the
// firmware binary just for one hash call. Phase 2 is welcome to swap
// this out for `mbedtls_sha256` once the TLS server links mbedtls.
//
// Implementation is FIPS 180-4 SHA-256, no dependencies beyond
// <stdint.h> + <stddef.h> + <string.h>. Public-domain shape.

#ifndef CONDUIT_SHA256_H
#define CONDUIT_SHA256_H

#include <stddef.h>
#include <stdint.h>

#define CONDUIT_SHA256_DIGEST_LEN 32

// Compute SHA-256 over `data`/`len`. Writes 32 bytes into `out`.
void conduit_sha256(const void *data, size_t len,
                    uint8_t out[CONDUIT_SHA256_DIGEST_LEN]);

#endif // CONDUIT_SHA256_H
