#ifndef PICO_POE_CONFIG_H
#define PICO_POE_CONFIG_H

// =============================================================================
// PICO-POE Board Configuration
// =============================================================================

// Firmware version (increment MINOR for each release, MAJOR for breaking changes)
#define PICO_POE_VERSION_MAJOR  1
#define PICO_POE_VERSION_MINOR  1
#define PICO_POE_VERSION_PATCH  1
#define PICO_POE_VERSION_STRING "1.1.1"

// =============================================================================
// Authentication
// =============================================================================

// Pre-shared token for upload/reboot API endpoints.
// Override at compile time: -DPICO_POE_AUTH_TOKEN=\"your-secret-token\"
#ifndef PICO_POE_AUTH_TOKEN
#define PICO_POE_AUTH_TOKEN "changeme"
#endif

// =============================================================================
// Network Configuration
// =============================================================================

// DHCP timeout before falling back to static IP (milliseconds)
#define PICO_POE_DHCP_TIMEOUT_MS  10000

// Static fallback IP configuration
#define PICO_POE_STATIC_IP      "192.168.178.200"
#define PICO_POE_STATIC_MASK    "255.255.255.0"
#define PICO_POE_STATIC_GW      "192.168.178.1"

// HTTP server port
#define PICO_POE_HTTP_PORT      80

// =============================================================================
// CORS Configuration
// =============================================================================

// Allowed origin for CORS requests (GitHub Pages domain)
// Set to "*" during development, restrict to your GH Pages domain in production
#ifndef PICO_POE_CORS_ORIGIN
#define PICO_POE_CORS_ORIGIN    "*"
#endif

// =============================================================================
// Hardware Pin Mapping (PICO-POE board)
// =============================================================================

// PoE status input (TLP290 optocoupler output, active = PoE powered)
#define PICO_POE_POE_STATUS_PIN  27

// =============================================================================
// OTA Configuration
// =============================================================================

// UF2 magic numbers
#define UF2_MAGIC_START0  0x0A324655
#define UF2_MAGIC_START1  0x9E5D5157
#define UF2_MAGIC_END     0x0AB16F30

// UF2 family IDs from pico-sdk boot/uf2.h:
//   0xe48bff57 = ABSOLUTE        (unpartitioned; bootloader-style binaries)
//   0xe48bff59 = RP2350_ARM_S    (secure ARM; what our app is built as)
//   0xe48bff5a = RP2350_RISCV
//   0xe48bff5b = RP2350_ARM_NS   (non-secure ARM)
#define UF2_FAMILY_ABSOLUTE      0xe48bff57
#define UF2_FAMILY_RP2350_ARM_S  0xe48bff59
#define UF2_FAMILY_RP2350_RISCV  0xe48bff5a
#define UF2_FAMILY_RP2350_ARM_NS 0xe48bff5b

// UF2 block size
#define UF2_BLOCK_SIZE    512
#define UF2_PAYLOAD_SIZE  256

// Flash sector size for erase operations
#define PICO_POE_FLASH_SECTOR_SIZE  4096

#endif // PICO_POE_CONFIG_H
