#ifndef OTA_H
#define OTA_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

typedef enum {
    OTA_OK = 0,
    OTA_ERR_ALREADY_IN_PROGRESS,
    OTA_ERR_NO_PARTITION,
    OTA_ERR_INVALID_UF2,
    OTA_ERR_WRONG_FAMILY,
    OTA_ERR_FLASH_ERASE,
    OTA_ERR_FLASH_WRITE,
    OTA_ERR_OVERFLOW,
    OTA_ERR_BLOCK_COUNT,
    OTA_ERR_NOT_STARTED,
} ota_err_t;

// Begin an OTA update session. Determines the inactive partition.
ota_err_t ota_begin(void);

// Producer-side ingest from the HTTP POST body. Pushes bytes into the
// SRAM ring; the actual flash erase/program is done by ota_pump() on
// Core 0. May accept FEWER bytes than requested when the ring is
// full — this is the TCP-native backpressure path. The caller MUST
// honor the return value when computing altcp_recved.
//
// Bytes not accepted stay unacked at the TCP layer (we only ack what
// the ring took); the peer will retransmit them when our advertised
// window slides forward as Core 0 drains.
size_t ota_write_chunk_ex(const uint8_t *data, size_t len);

// Back-compat wrapper: feeds bytes through ota_write_chunk_ex on a
// best-effort basis. Returns OTA_OK as long as a session is active.
// New code should use ota_write_chunk_ex directly.
ota_err_t ota_write_chunk(const uint8_t *data, size_t len);

// Consumer-side. Called from the Core 0 main loop (gated on
// ota_in_progress()). Drains ONE 512-byte UF2 block from the ring and
// runs the flash erase/program through flash_safe_execute. No-op when
// the ring has fewer than 512 bytes buffered.
void ota_pump(void);

// Producer signals "no more bytes coming" — body_received has reached
// content_length. Once called, ota_write_chunk_ex rejects further
// writes; ota_drain_complete will go true after the ring empties.
void ota_begin_drain(void);

// True when ota_begin_drain() was called AND the ring is empty.
// http_poll polls this on the DRAINING conn; sends the response and
// reboots once complete.
bool ota_drain_complete(void);

// Sticky error from the most recent failed pump. OTA_OK if none.
ota_err_t ota_last_pump_error(void);

// Verify block count, then trigger the reboot into the new partition.
// Called by http_poll on the Core 1 side once ota_drain_complete()
// returns true and ota_last_pump_error() is OTA_OK. Does not return
// on success.
ota_err_t ota_finalize_after_drain(void);

// Abort an in-progress update and clean up state.
void ota_abort(void);

// Check if an OTA update is in progress
bool ota_in_progress(void);

// Get progress: bytes written to flash so far
uint32_t ota_bytes_written(void);

// Get the last error message (static buffer)
const char *ota_error_string(ota_err_t err);

// ---- TBYB commit -----------------------------------------------------------
//
// After an OTA-triggered reboot, the image boots in "Try Before You Buy"
// mode: the RP2350 ROM will roll back to the previous partition on the
// next reset unless we call rom_explicit_buy() first. To prove the new
// image is actually reachable from a client before we commit, we defer
// the explicit_buy call until the uploading client POSTs /api/commit.
// The main loop pats the hardware watchdog independently so the device
// stays alive while waiting for that confirmation.

typedef enum {
    OTA_COMMIT_OK = 0,           // explicit_buy succeeded (or already committed this session)
    OTA_COMMIT_NOT_PENDING,      // not a TBYB boot; nothing to commit
    OTA_COMMIT_FAILED,           // rom_explicit_buy returned an error
} ota_commit_result_t;

// Called once at app startup: reads boot_info and arms the commit-pending
// flag if the boot_type indicates a flash-update reboot.
void ota_init_boot_state(void);

// True while we're running a TBYB image that has not yet been committed.
bool ota_commit_pending(void);

// Commit the current image (calls rom_explicit_buy). Idempotent: second
// call returns OTA_COMMIT_NOT_PENDING. See rom_explicit_buy notes — it
// may briefly reboot to update rollback version rows; if so, execution
// does not return from this call.
ota_commit_result_t ota_commit(void);

// Stable short string for the last boot_type from rom_get_boot_info().
// "normal", "flash_update", "bootsel", "ram_image", "pc_sp", or "unknown".
// Safe to call any time after ota_init_boot_state().
const char *ota_boot_type_str(void);

#endif // OTA_H
