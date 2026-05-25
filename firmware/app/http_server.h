#ifndef HTTP_SERVER_H
#define HTTP_SERVER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Initialize the HTTP server on CONDUIT_HTTP_PORT (port 80, plain HTTP).
void http_server_init(void);

// Initialize the HTTPS server on CONDUIT_HTTPS_PORT (port 443, TLS via
// altcp_tls + mbedtls). Reads the cert + key from the IDENTITY
// partition via conduit_identity_get(). Returns false if no identity
// is loaded (caller hasn't called conduit_identity_load(), or the
// partition is missing/invalid). On a self-host / uncommissioned
// board, leaving HTTPS off is the intended path — the plain HTTP
// listener stays bound regardless.
bool http_server_init_tls(void);

// Reap persistent stream PCBs (/api/log?stream=1, /api/data?stream=1)
// when the PHY link drops. Called from network.c link_callback on the
// up→down transition. OTA upload connections (CONN_STATE_BODY) and
// short-lived requests are intentionally NOT touched — only persistent
// streams need explicit cleanup. Without this, vanished-client stream
// PCBs sit in the small (MEMP_NUM_TCP_PCB=8) pool for ~50 s waiting
// for keepalive to fire, locking out the browser's reconnect SYNs.
void http_server_on_link_down(void);

// Diagnostic counters surfaced via diag.c. Cumulative since boot:
//   acpt = SYNs the listen PCB delivered to http_accept (i.e. reached
//          us through the network stack). Stays flat post-replug if
//          incoming connection attempts aren't reaching lwIP.
//   strm = connections that progressed to CONN_STATE_STREAMING (both
//          /api/log and /api/data). Useful contrast with `acpt`: if
//          acpt climbs but strm doesn't, accepts are happening but
//          the request never lands (e.g. our SYN-ACK reply isn't
//          reaching the client, so the handshake never completes).
uint32_t http_server_accepts(void);
uint32_t http_server_streams_started(void);
// Number of times the per-conn poll callback has fired since boot.
// Driven by lwIP's tcp_tmr / slow timer (~500 ms cadence per active
// pcb), so a flat value while core1_iter is still climbing is the
// "slow timer wedged" smoking gun. See `note_stream_close` + the
// stream_close_* counters for the close-attribution path that pairs
// with this.
uint32_t http_server_poll_fires(void);

// Build the device-status JSON into `out`. Same bytes /api/status
// returns. Used by both handle_status (HTTP path) and ws_server.c (WS
// push). Returns the number of bytes written (not including a
// terminator), 0 on error.
int http_server_build_status_json(char *out, size_t out_max);

// Event categories that the WS endpoint pushes as STATUS / NOTICE
// frames. Modules (network.c on link change, ota.c on commit, etc.)
// call http_server_notify_event() to flag the active WS conns; the
// next ws_server_poll() tick re-emits.
typedef enum {
    HTTP_EVT_LINK_UP,
    HTTP_EVT_LINK_DOWN,
    HTTP_EVT_OTA_STARTED,
    HTTP_EVT_OTA_DONE,
    HTTP_EVT_REBOOT_PENDING,
    HTTP_EVT_PARTITION_CHANGED,
    // NOTE: schema-change events do NOT go through this enum. They
    // can't — http_server_notify_event walks http_conn_pool (Core 1
    // state), but conduit_data_lookup_or_register runs on Core 0,
    // and the cross-core write was a race that occasionally left
    // status_dirty set on a half-torn-down conn. The Core-safe
    // path is the schema-version counter (see
    // data_buffer.h::data_buffer_schema_version()) which
    // ws_server_poll polls from Core 1.
} http_event_t;

// Walk the http_conn_pool and mark any CONN_STATE_WS slots so the next
// ws_server_poll() tick re-emits a STATUS snapshot (and optionally a
// NOTICE depending on the event kind). Safe to call from any module
// running on the lwIP thread; reads the static pool with no locking
// because all callers are serialized on that thread.
void http_server_notify_event(http_event_t event);

#endif // HTTP_SERVER_H
