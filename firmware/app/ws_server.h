#ifndef WS_SERVER_H
#define WS_SERVER_H

// Single-stream WebSocket-over-HTTPS endpoint (RFC 6455). Replaces the
// IDE's previous four-concurrent-connection model (/api/log,
// /api/data, /api/cmd, /api/status) with one bidirectional altcp_tls
// pcb at GET /api/stream. The HTTP-side Upgrade handshake lives in
// http_server.c; everything below the 101 Switching Protocols line
// (frame codec, channel multiplexing, ring drains, command dispatch)
// lives here.
//
// Wire protocol on top of RFC 6455:
//   Each WebSocket payload begins with a 1-byte channel tag, followed
//   by channel-specific bytes. The WS opcode (text vs binary) matches
//   the channel's encoding so plain WS clients tooling (e.g. browser
//   DevTools "Messages" pane) renders things sensibly.
//
//   'L' (text)   — server→client: a single log line, UTF-8, terminated
//                   with '\n' as the firmware emits it (same body bytes
//                   /api/log?stream=1 produces).
//   'D' (binary) — server→client: one or more concatenated 16-byte-header
//                   records, byte-identical to /api/data?stream=1
//                   (see data_buffer.h for wire format). Carries the
//                   firmware's KEEPALIVE_MSG_ID record too.
//   'C' (text)   — bidir:
//                   client→server: "seq=N&name=NAME&<args>" — same
//                     query-string format /api/cmd accepts today,
//                     parsed by commands.c arg helpers verbatim.
//                   server→client: JSON {"seq":N,"ok":true,"result":<obj>}
//                     OR {"seq":N,"ok":false,"error":"..."}.
//                   Special name "auth" with arg token=<value> is the
//                   first-frame authentication (browsers can't set
//                   custom WS handshake headers, so token rides this
//                   in-band).
//   'S' (text)   — server→client: JSON snapshot, same shape /api/status
//                   returns today. Pushed on auth success, on link
//                   up/down, on partition change, on OTA commit.
//   'N' (text)   — server→client: lifecycle notice, JSON
//                   {"kind":"need_auth"|"reboot_pending"|"ota_started"
//                          |"ota_done"|"link_down"|"link_up",
//                    "detail":"..."}
//
// Latency target (<100 ms RTT for client→server commands):
//   ws_server_on_bytes() dispatches inbound CMD frames synchronously
//   inside the lwIP recv callback — parse, commands_dispatch, format
//   response, altcp_write+altcp_output all on the same stack. No
//   waiting on the slow timer.
//
// Authentication:
//   conn->ws.authed starts false. Only WS_CH_NOTICE {"kind":"need_auth"}
//   is emitted until the client sends a CMD frame with name="auth"
//   and a valid token (constant-time compared against CONDUIT_AUTH_TOKEN).
//   On success, ws_server_on_authed() is invoked which emits an
//   initial STATUS snapshot and unlocks the LOG/DATA/CMD channels.
//   Tokens MUST NEVER appear in the URL — only inside an auth CMD.

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#include "pico/time.h"
#include "lwip/altcp.h"

// Channel tag byte at payload[0] for every WS frame.
#define WS_CH_LOG     'L'
#define WS_CH_DATA    'D'
#define WS_CH_CMD     'C'
#define WS_CH_STATUS  'S'
#define WS_CH_NOTICE  'N'

// Bounds. Inbound is small (CMD payloads are well under 1 KB); outbound
// telemetry can be larger but reuses the existing http_poll-style static
// scratch in ws_server.c.
#define WS_INGRESS_MAX        2048
#define WS_EGRESS_DATA_CAP    8192
#define WS_EGRESS_LOG_CAP     4096

// Server-side keepalive cadence. Matches HTTP-side STREAM_KEEPALIVE_MS
// — saved-memory project_https_keepalive_cadence_wedge.md forbids
// raising this above 500 ms on TLS conns.
#define WS_KEEPALIVE_MS       500

// Server-side health PING cadence. WebSocket PING/PONG runs on top of
// the channel-keepalive stream — gives an application-layer signal
// independent of TCP keepalive (which can't detect a wedged mbedtls).
#define WS_PING_INTERVAL_MS   30000

// RFC 6455 inbound decoder state.
typedef enum {
    WS_RX_NEED_HDR2,        // first 2 header bytes
    WS_RX_NEED_LEN16,       // 2-byte extended length
    WS_RX_NEED_LEN64,       // 8-byte extended length
    WS_RX_NEED_MASK,        // 4-byte masking key (always set client→server)
    WS_RX_NEED_PAYLOAD,     // payload bytes (unmasked into msg_buf as they arrive)
} ws_rx_state_t;

// Per-connection WebSocket state. Embedded inside http_conn_t in
// http_server.c. The reassembly buffer is borrowed from the conn's
// header_buf (HTTP_MAX_HEADER = 2048) because once we're in
// CONN_STATE_WS we never parse another HTTP request line — see the
// reuse in ws_server_on_bytes().
typedef struct {
    bool             authed;            // auth frame validated
    bool             status_dirty;      // notify_event flagged a new STATUS push
    bool             frame_in_progress; // currently mid-message (FIN=0 history)
    uint32_t         log_since;         // cursor into log_buffer
    uint32_t         data_since;        // cursor into data_buffer
    absolute_time_t  last_tx_at;        // for WS_KEEPALIVE_MS PING throttle
    absolute_time_t  last_ping_at;      // for WS_PING_INTERVAL_MS app-layer ping

    // Inbound decoder.
    ws_rx_state_t    rx_state;
    uint8_t          rx_hdr[14];        // 2-byte WS hdr + up to 8 ext-len + 4 mask key
    uint8_t          rx_hdr_have;       // bytes accumulated in rx_hdr
    uint8_t          rx_hdr_need;       // bytes still needed for current rx_state
    uint8_t          mask_key[4];

    uint8_t          fin;
    uint8_t          opcode;            // current frame's opcode (1=text,2=bin,0=cont,8=close,9=ping,10=pong)
    uint8_t          msg_opcode;        // first-frame opcode of a fragmented message
    uint32_t         payload_len;       // expected payload bytes (length field)
    uint32_t         payload_pos;       // bytes received so far in current frame
    uint16_t         msg_buf_len;       // bytes accumulated in reassembly buffer (across fragments)
} ws_state_t;

// One-time per-conn init. Called by http_server.c right after emitting
// 101 Switching Protocols. `rx_buf` is the per-conn reassembly buffer
// (in practice the http_conn_t header_buf, reused once HTTP parsing is
// done). Sends the initial NOTICE {"kind":"need_auth"} frame.
void ws_server_on_open(struct altcp_pcb *pcb, ws_state_t *s,
                       uint8_t *rx_buf, size_t rx_buf_size);

// Inbound bytes from lwIP. Drives the decoder; dispatches complete
// messages. Returns false if the connection should be closed (protocol
// error, oversize message, close frame received) — caller should
// conn_close() in that case.
bool ws_server_on_bytes(struct altcp_pcb *pcb, ws_state_t *s,
                        uint8_t *rx_buf, size_t rx_buf_size,
                        const uint8_t *data, uint16_t len);

// Periodic + opportunistic outbound flush:
//   - drains log_buffer + data_buffer into framed messages,
//   - emits keepalive PING every WS_KEEPALIVE_MS when nothing else flowed,
//   - emits app-layer PING every WS_PING_INTERVAL_MS,
//   - re-emits STATUS frame if notify_event flagged it dirty.
// Safe to call from http_recv (latency boost) or http_poll (the lwIP
// slow-timer driven path). Both run on the lwIP thread; no locking.
void ws_server_poll(struct altcp_pcb *pcb, ws_state_t *s);

// Status push hook. http_server_notify_event() in http_server.c walks
// the http_conn_pool and calls this on every CONN_STATE_WS slot.
static inline void ws_server_mark_status_dirty(ws_state_t *s) {
    if (s) s->status_dirty = true;
}

#endif // WS_SERVER_H
