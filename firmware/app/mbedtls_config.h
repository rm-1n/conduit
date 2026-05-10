// firmware/app/mbedtls_config.h
//
// Picked up by pico-sdk's pico_mbedtls trampoline (`pico_mbedtls_config.h`
// does `#include "mbedtls_config.h"` and expects the user project to put
// THIS file on the include path — see app/CMakeLists.txt). Without this
// file, mbedtls config resolution fails outright.
//
// Trim is tuned for one job: TLS server with the per-device EC P-256
// cert + chain from the IDENTITY partition. ECDHE-ECDSA + AES-128-GCM,
// SHA-256, X.509 cert parse. RSA stays enabled because mbedtls's TLS
// stack drags in a few RSA-touching helpers even on ECC-only paths,
// and the few hundred KB savings aren't worth chasing for v1.
//
// Pattern adapted from pico-sdk's test/kitchen_sink/mbedtls_config.h —
// known-good for mbedtls 3.x on RP2350.

#include <limits.h>

// ---- Platform glue --------------------------------------------------------

#define MBEDTLS_NO_PLATFORM_ENTROPY
#define MBEDTLS_ENTROPY_HARDWARE_ALT          // pico_mbedtls.c provides hardware entropy via the rosc
#define MBEDTLS_ALLOW_PRIVATE_ACCESS
#define MBEDTLS_HAVE_TIME
#define MBEDTLS_PLATFORM_C
#define MBEDTLS_PLATFORM_MS_TIME_ALT          // pico_mbedtls.c plugs in a millisecond clock

// ---- Buffers --------------------------------------------------------------

// Halve the default 16 KB buffers — our largest single response is the
// cert chain (~3 KB) plus framing. 8 KB leaves comfortable headroom and
// reclaims 16 KB of SRAM versus defaults.
#define MBEDTLS_SSL_OUT_CONTENT_LEN    8192
#define MBEDTLS_SSL_IN_CONTENT_LEN     8192

// Smaller AES tables save flash — TLS handshakes aren't throughput-bound.
#define MBEDTLS_AES_FEWER_TABLES
#define MBEDTLS_SHA256_SMALLER

// ---- Cipher suites: ECDHE-ECDSA + AES-128-GCM + SHA-256 -------------------

#define MBEDTLS_SSL_TLS_C
#define MBEDTLS_SSL_SRV_C
#define MBEDTLS_SSL_CLI_C                     // Required by altcp_tls_mbedtls.c even for server-only use
#define MBEDTLS_SSL_PROTO_TLS1_2
#define MBEDTLS_SSL_SERVER_NAME_INDICATION

#define MBEDTLS_KEY_EXCHANGE_ECDHE_ECDSA_ENABLED

// ---- Crypto primitives ----------------------------------------------------

#define MBEDTLS_AES_C
#define MBEDTLS_GCM_C
#define MBEDTLS_CIPHER_C
#define MBEDTLS_CIPHER_MODE_CBC               // Some mbedtls TLS internals reach for CBC paths

#define MBEDTLS_MD_C
#define MBEDTLS_MD5_C                         // Pulled in by mbedtls TLS internals
#define MBEDTLS_SHA1_C                        // ditto
#define MBEDTLS_SHA224_C
#define MBEDTLS_SHA256_C
// SHA-384 is its own flag in mbedtls 3.x even though the implementation
// is in the SHA-512 module. Required so the ECDSA-SHA384 OID gets
// registered in oid.c — Let's Encrypt's intermediates (R3/R10) sign
// leaves with ecdsa-with-SHA384, and without this flag mbedtls fails
// the cert with X509_UNKNOWN_SIG_ALG | OID_NOT_FOUND (-0x262E).
#define MBEDTLS_SHA384_C
#define MBEDTLS_SHA512_C                      // Pulled in by some x509 / pk paths

#define MBEDTLS_BIGNUM_C
#define MBEDTLS_ECP_C
#define MBEDTLS_ECDSA_C
#define MBEDTLS_ECDH_C
// The leaf uses P-256 (server's own key from the IDENTITY blob); the
// LE intermediate (E7) has a P-384 public key. We don't verify the
// chain on-device, but mbedtls still has to *parse* the intermediate
// cert to accept it into the chain config — that requires the curve
// it's keyed on. Without P-384, the intermediate parse fails and the
// whole chain is rejected with X509_UNKNOWN_SIG_ALG / VERIFY_FAILED.
#define MBEDTLS_ECP_DP_SECP256R1_ENABLED
#define MBEDTLS_ECP_DP_SECP384R1_ENABLED

#define MBEDTLS_PK_C
#define MBEDTLS_PK_PARSE_C                    // Parse PKCS#8 EC privkey from IDENTITY blob
#define MBEDTLS_PKCS1_V15
#define MBEDTLS_RSA_C                         // mbedtls TLS internals reach for RSA helpers; can't disable cleanly

#define MBEDTLS_OID_C
#define MBEDTLS_ASN1_PARSE_C
#define MBEDTLS_ASN1_WRITE_C
#define MBEDTLS_PKCS5_C

// ---- X.509 ---------------------------------------------------------------

#define MBEDTLS_X509_USE_C
#define MBEDTLS_X509_CRT_PARSE_C              // Parse cert chain from IDENTITY blob

// PEM parsing — required for mbedtls_x509_crt_parse() to take its
// PEM-decode branch on the cert chain we ship in the IDENTITY blob.
// Without these, the cert is treated as raw DER and rejected with
// MBEDTLS_ERR_X509_INVALID_FORMAT (-0x2180). MBEDTLS_BASE64_C is
// the dependency the PEM module pulls in to decode the base64 body
// between the BEGIN/END CERTIFICATE markers.
#define MBEDTLS_PEM_PARSE_C
#define MBEDTLS_BASE64_C

// ---- DRBG + entropy ------------------------------------------------------

#define MBEDTLS_CTR_DRBG_C
#define MBEDTLS_ENTROPY_C
#define MBEDTLS_ERROR_C
