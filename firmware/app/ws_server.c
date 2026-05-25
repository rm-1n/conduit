// RFC 6455 frame codec + channel dispatcher for /api/stream.
//
// Sits below http_server.c's HTTP Upgrade handshake. Once that emits
// 101 Switching Protocols and flips the conn into CONN_STATE_WS, every
// byte from this peer goes through ws_server_on_bytes() and every
// outbound flush goes through ws_server_poll(). No HTTP parsing past
// the Upgrade.
//
// Sizing invariants:
//   - WS_INGRESS_MAX = 2 KB: max inbound message after reassembly. CMD
//     payloads are well under 1 KB in practice. Reuses the per-conn
//     header_buf (HTTP_MAX_HEADER = 2048) as the reassembly buffer —
//     we're done with HTTP request parsing on this conn, and that
//     keeps the per-conn footprint flat vs. the HTTP-only design.
//   - Outbound frames built from static `out[8192]` scratch on the
//     lwIP thread (same pattern http_poll uses, so the two never
//     execute concurrently on the same conn).
//   - WS_INGRESS_MAX (2048) is well under MBEDTLS_SSL_IN_CONTENT_LEN
//     (16384), so no inbound WS frame can ever straddle a TLS record.
//
// Single-thread invariant: every entry point here is called from the
// lwIP TCP/IP thread (Core 1) — no locking required.

#include "ws_server.h"
#include "conduit_config.h"
#include "log_buffer.h"
#include "data_buffer.h"
#include "commands.h"
#include "http_server.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>

// RFC 6455 opcodes.
#define WS_OP_CONT   0x0
#define WS_OP_TEXT   0x1
#define WS_OP_BIN    0x2
#define WS_OP_CLOSE  0x8
#define WS_OP_PING   0x9
#define WS_OP_PONG   0xA

// RFC 6455 close status codes we emit.
#define WS_CLOSE_NORMAL       1000
#define WS_CLOSE_PROTOCOL     1002
#define WS_CLOSE_TOO_BIG      1009
#define WS_CLOSE_POLICY       1008  // unauthenticated client trying to push past need_auth

// One outbound scratch — shared across all conns because the lwIP
// thread runs handlers serially. Sized for the largest payload we
// might emit (a 8 KB batch from data_buffer with a 1-byte channel
// tag and the 4-byte WS frame header).
#define WS_OUT_SCRATCH  (WS_EGRESS_DATA_CAP + 16)
static uint8_t g_out_scratch[WS_OUT_SCRATCH];

// --------------------------------------------------------------------------
// Frame emission helpers
// --------------------------------------------------------------------------

// Build an RFC 6455 server frame header into `hdr` and return its length.
// Server→client frames are never masked, so the MASK bit stays 0.
// Caller must ensure `hdr` is at least 10 bytes (the maximum header
// size we'd emit — we never produce 64-bit lengths since our cap is
// well under 64 KB, but the helper allows it for completeness).
static size_t ws_build_header(uint8_t hdr[10], uint8_t opcode, uint32_t payload_len) {
    hdr[0] = 0x80 | (opcode & 0x0F);   // FIN=1, opcode
    if (payload_len < 126) {
        hdr[1] = (uint8_t)payload_len;
        return 2;
    } else if (payload_len <= 0xFFFF) {
        hdr[1] = 126;
        hdr[2] = (uint8_t)(payload_len >> 8);
        hdr[3] = (uint8_t)(payload_len & 0xFF);
        return 4;
    } else {
        // Unused at the moment but kept for symmetry — WS_EGRESS_DATA_CAP
        // is 8 KB so we never hit this branch.
        hdr[1] = 127;
        hdr[2] = 0; hdr[3] = 0; hdr[4] = 0; hdr[5] = 0;
        hdr[6] = (uint8_t)((payload_len >> 24) & 0xFF);
        hdr[7] = (uint8_t)((payload_len >> 16) & 0xFF);
        hdr[8] = (uint8_t)((payload_len >> 8)  & 0xFF);
        hdr[9] = (uint8_t)(payload_len         & 0xFF);
        return 10;
    }
}

// Low-level emit: prepend a 1-byte channel tag to `body`, build the WS
// header for (1 + body_len) bytes total, write header+tag+body, flush.
// Returns true on success; false if altcp_write rebuffed (e.g. ERR_MEM
// — caller may retry later).
//
// CRITICAL: this used to do two separate altcp_writes (header with
// TCP_WRITE_FLAG_MORE, then body). If the second write returned
// ERR_MEM, the header sat queued in lwIP's segment list and got
// silently concatenated to the next emit's header on the wire — the
// browser's RFC 6455 parser would see corrupt framing and close the
// conn. Now we check `altcp_sndbuf` for the FULL frame up front and
// concatenate the header + tag + body into the shared g_out_scratch
// before a single altcp_write call, eliminating the partial-write
// window entirely.
static bool ws_emit(struct altcp_pcb *pcb, uint8_t opcode,
                    uint8_t channel, const uint8_t *body, size_t body_len) {
    uint8_t hdr[10];
    uint32_t payload_total = (uint32_t)(1 + body_len);
    size_t hdr_len = ws_build_header(hdr, opcode, payload_total);
    size_t frame_len = hdr_len + payload_total;        // hdr + tag + body
    if (frame_len > altcp_sndbuf(pcb)) {
        // Send buffer can't hold the full frame right now. Caller
        // retries on the next slow-timer tick.
        return false;
    }
    if (frame_len > sizeof(g_out_scratch)) {
        // Frame larger than our scratch — should never happen because
        // ws_drain_* caps payloads at WS_EGRESS_*_CAP < scratch size.
        return false;
    }
    // Shift body FIRST, then write the header. ws_drain_log/data
    // populate g_out_scratch and call us with body=g_out_scratch, so
    // src and dst overlap (dst starts hdr_len+1 bytes higher). memmove
    // copies from the high end down for forward-overlapping ranges,
    // which is exactly the order we need.
    if (body_len > 0) memmove(g_out_scratch + hdr_len + 1, body, body_len);
    memcpy(g_out_scratch, hdr, hdr_len);
    g_out_scratch[hdr_len] = channel;
    err_t e = altcp_write(pcb, g_out_scratch, frame_len, TCP_WRITE_FLAG_COPY);
    if (e != ERR_OK) return false;
    altcp_output(pcb);
    return true;
}

// Emit a WS control frame (no channel tag — RFC 6455 control frames
// have a small caller-controlled payload directly).
static bool ws_emit_control(struct altcp_pcb *pcb, uint8_t opcode,
                            const uint8_t *body, size_t body_len) {
    if (body_len > 125) return false;            // RFC 6455 §5.5
    if ((2 + body_len) > altcp_sndbuf(pcb)) return false;
    uint8_t buf[2 + 125];
    buf[0] = 0x80 | (opcode & 0x0F);
    buf[1] = (uint8_t)body_len;
    if (body_len > 0) memcpy(buf + 2, body, body_len);
    err_t e = altcp_write(pcb, buf, 2 + body_len, TCP_WRITE_FLAG_COPY);
    if (e != ERR_OK) return false;
    altcp_output(pcb);
    return true;
}

static void ws_send_close(struct altcp_pcb *pcb, uint16_t code) {
    uint8_t body[2] = { (uint8_t)(code >> 8), (uint8_t)(code & 0xFF) };
    ws_emit_control(pcb, WS_OP_CLOSE, body, 2);
}

static void ws_send_ping(struct altcp_pcb *pcb) {
    static const uint8_t payload[] = { 'p', 'i', 'n', 'g' };
    ws_emit_control(pcb, WS_OP_PING, payload, sizeof payload);
}

static void ws_send_pong(struct altcp_pcb *pcb, const uint8_t *body, size_t len) {
    ws_emit_control(pcb, WS_OP_PONG, body, len);
}

// --------------------------------------------------------------------------
// Channel-level emit wrappers
// --------------------------------------------------------------------------

static bool ws_emit_text(struct altcp_pcb *pcb, uint8_t channel,
                         const char *body, size_t len) {
    return ws_emit(pcb, WS_OP_TEXT, channel, (const uint8_t *)body, len);
}

static bool ws_emit_binary(struct altcp_pcb *pcb, uint8_t channel,
                           const uint8_t *body, size_t len) {
    return ws_emit(pcb, WS_OP_BIN, channel, body, len);
}

// --------------------------------------------------------------------------
// Status snapshot
// --------------------------------------------------------------------------
//
// Mirrors the body handle_status() builds in http_server.c. Kept in
// sync by design — both call the same network_*/ota_* getters. The
// shared helper is exported from http_server.c (see
// http_server_build_status_json) so a future field bump touches one
// place.

static void ws_push_status(struct altcp_pcb *pcb, ws_state_t *s) {
    // Must match HTTP_MAX_RESPONSE in http_server.c — same builder,
    // same fields, same data_schema splice. 768 was silently truncating
    // the body once the Phase 0 diag block landed; bumped in lockstep.
    char body[2048];
    int n = http_server_build_status_json(body, sizeof(body));
    if (n <= 0) return;
    if (!ws_emit_text(pcb, WS_CH_STATUS, body, (size_t)n)) return;
    s->status_dirty = false;
    // The data_schema embedded in this STATUS body reflects the
    // registry at THIS moment. Snapshot the version we just pushed so
    // ws_server_poll() doesn't re-push immediately on a stale check.
    s->schema_version_seen = data_buffer_schema_version();
    s->last_tx_at = get_absolute_time();
}

static void ws_push_notice(struct altcp_pcb *pcb, ws_state_t *s,
                           const char *kind, const char *detail) {
    char body[192];
    int n;
    if (detail && detail[0]) {
        n = snprintf(body, sizeof(body),
                     "{\"kind\":\"%s\",\"detail\":\"%s\"}", kind, detail);
    } else {
        n = snprintf(body, sizeof(body), "{\"kind\":\"%s\"}", kind);
    }
    if (n <= 0) return;
    if (n >= (int)sizeof(body)) n = (int)sizeof(body) - 1;
    if (ws_emit_text(pcb, WS_CH_NOTICE, body, (size_t)n)) {
        s->last_tx_at = get_absolute_time();
    }
}

// --------------------------------------------------------------------------
// CMD frame dispatch
// --------------------------------------------------------------------------

// Pull `seq=N&` off the head of the query-string-formatted CMD payload.
// On success: *seq is set and *args_after points to the rest of the
// string (just past the '&', NUL-terminated by caller). Returns true.
// If seq is missing/invalid, returns false and the caller treats the
// frame as malformed.
static bool extract_seq(const char *qs, uint32_t *seq, const char **args_after) {
    if (strncmp(qs, "seq=", 4) != 0) return false;
    const char *v = qs + 4;
    char *endp = NULL;
    unsigned long n = strtoul(v, &endp, 10);
    if (endp == v) return false;
    *seq = (uint32_t)n;
    if (*endp == '&') *args_after = endp + 1;
    else if (*endp == '\0') *args_after = endp;
    else return false;
    return true;
}

// Pull `name=NAME&` from `args`. Writes up to name_max-1 bytes plus NUL
// into `name`, and points *args_after past the '&' (or at the trailing
// NUL if name was the last field). Returns true on success.
static bool extract_name(const char *args, char *name, size_t name_max,
                         const char **args_after) {
    if (strncmp(args, "name=", 5) != 0) return false;
    const char *v = args + 5;
    const char *end = strchr(v, '&');
    size_t len = end ? (size_t)(end - v) : strlen(v);
    if (len == 0 || len >= name_max) return false;
    memcpy(name, v, len);
    name[len] = '\0';
    *args_after = end ? end + 1 : v + len;
    return true;
}

// Constant-time token compare against CONDUIT_AUTH_TOKEN. Identical
// algorithm to http_server.c's parse_request_line auth path (lines
// 1056-1064), kept inline so the WS auth path doesn't depend on
// HTTP-side internals.
static bool auth_token_ok(const char *token) {
    size_t expected_len = strlen(CONDUIT_AUTH_TOKEN);
    size_t actual_len = token ? strlen(token) : 0;
    volatile uint8_t result = 0;
    size_t cmp_len = (actual_len < expected_len) ? expected_len : actual_len;
    for (size_t i = 0; i < cmp_len; i++) {
        char a = (i < actual_len) ? token[i] : 0;
        char b = (i < expected_len) ? CONDUIT_AUTH_TOKEN[i] : 0;
        result |= (uint8_t)(a ^ b);
    }
    result |= (uint8_t)(actual_len != expected_len);
    return result == 0;
}

// Send a CMD response. `seq` is echoed. If `ok`, `result_json` is
// inlined verbatim into the "result" field — it MUST already be valid
// JSON (commands_dispatch's handlers produce this). If !ok,
// `result_json` holds the bare error message which we JSON-escape.
static void ws_send_cmd_reply(struct altcp_pcb *pcb, ws_state_t *s,
                              uint32_t seq, bool ok, const char *payload, int payload_len) {
    static char body[768];
    int n;
    if (ok) {
        n = snprintf(body, sizeof(body),
                     "{\"seq\":%u,\"ok\":true,\"result\":%.*s}",
                     (unsigned)seq, payload_len, payload);
    } else {
        char esc[256];
        size_t ei = 0;
        for (int i = 0; i < payload_len && payload[i] != '\0' && ei + 2 < sizeof(esc); i++) {
            char c = payload[i];
            if (c == '"' || c == '\\') { esc[ei++] = '\\'; esc[ei++] = c; }
            else if ((unsigned char)c < 0x20) { /* drop control chars */ }
            else esc[ei++] = c;
        }
        esc[ei] = '\0';
        n = snprintf(body, sizeof(body),
                     "{\"seq\":%u,\"ok\":false,\"error\":\"%s\"}",
                     (unsigned)seq, esc);
    }
    if (n <= 0) return;
    if (n >= (int)sizeof(body)) n = (int)sizeof(body) - 1;
    if (ws_emit_text(pcb, WS_CH_CMD, body, (size_t)n)) {
        s->last_tx_at = get_absolute_time();
    }
}

// Handle an authenticated CMD frame. payload is NUL-terminated, holds
// "seq=N&name=NAME&<args>".
static void ws_dispatch_cmd(struct altcp_pcb *pcb, ws_state_t *s,
                            const char *payload) {
    uint32_t seq = 0;
    const char *args_after_seq = NULL;
    if (!extract_seq(payload, &seq, &args_after_seq)) {
        // No seq — without it we can't correlate a response. Drop with
        // a NOTICE so the client sees something landed but malformed.
        ws_push_notice(pcb, s, "bad_frame", "missing seq");
        return;
    }
    char name[64];
    const char *args = NULL;
    if (!extract_name(args_after_seq, name, sizeof(name), &args)) {
        ws_send_cmd_reply(pcb, s, seq, false, "missing name", 12);
        return;
    }

    // Auth gate. Pre-auth, only name="auth" is dispatched; everything
    // else gets a policy error.
    if (!s->authed) {
        if (strcmp(name, "auth") != 0) {
            ws_send_cmd_reply(pcb, s, seq, false, "auth required", 13);
            return;
        }
        char token[128];
        size_t tlen = conduit_cmd_arg_str(args, "token", token, sizeof(token));
        if (tlen == 0 || !auth_token_ok(token)) {
            ws_send_cmd_reply(pcb, s, seq, false, "invalid token", 13);
            // Don't kill the connection — let the client retry.
            return;
        }
        s->authed = true;
        // Echo success so the client knows auth landed before STATUS arrives.
        ws_send_cmd_reply(pcb, s, seq, true, "{\"authed\":true}", 15);
        // Push the initial status snapshot and reset cursors to the
        // current tail of each ring — the client wants live data, not
        // replay of pre-connect backlog.
        s->log_since = log_buffer_total_written();
        s->data_since = data_buffer_total_written();
        ws_push_status(pcb, s);
        return;
    }

    // Authenticated — normal dispatch.
    static char result[512];
    int written = commands_dispatch(name, args, result, sizeof(result));
    if (written == -1) {
        ws_send_cmd_reply(pcb, s, seq, false, "unknown command", 15);
    } else if (written < 0) {
        ws_send_cmd_reply(pcb, s, seq, false, result, (int)strnlen(result, sizeof(result)));
    } else {
        ws_send_cmd_reply(pcb, s, seq, true, result, written);
    }
}

// --------------------------------------------------------------------------
// Inbound message handling
// --------------------------------------------------------------------------

// A complete message (possibly reassembled from multiple fragments) is
// ready in rx_buf[0 .. msg_buf_len). msg_opcode is the opcode of the
// first frame (TEXT or BINARY). Dispatch on the channel tag at byte 0.
static void ws_handle_message(struct altcp_pcb *pcb, ws_state_t *s,
                              uint8_t *rx_buf) {
    if (s->msg_buf_len < 1) return;
    uint8_t channel = rx_buf[0];
    const uint8_t *body = rx_buf + 1;
    size_t body_len = s->msg_buf_len - 1;

    if (channel == WS_CH_CMD) {
        // CMD payloads are text — NUL-terminate inside the buffer
        // (rx_buf has 1 byte of headroom because WS_INGRESS_MAX is one
        // less than the HTTP header_buf it borrows from). Defensive:
        // bound by rx_buf usable size minus tag byte.
        if (body_len >= WS_INGRESS_MAX - 1) body_len = WS_INGRESS_MAX - 2;
        ((uint8_t *)body)[body_len] = '\0';
        ws_dispatch_cmd(pcb, s, (const char *)body);
    } else {
        // Unknown channel from client is a protocol soft-error.
        // Reply with a NOTICE rather than tearing down the conn —
        // tolerates a slightly-newer client that sends a future
        // channel we don't recognize yet.
        ws_push_notice(pcb, s, "bad_channel", "");
    }
}

// Frame fully received (payload_pos == payload_len). Dispatch control
// frames inline; data frames extend msg_buf_len and, on FIN, hand the
// reassembled message to the channel dispatcher. Returns false if the
// caller should close the connection (received CLOSE).
static bool ws_frame_complete(struct altcp_pcb *pcb, ws_state_t *s, uint8_t *rx_buf) {
    bool keep_open = true;
    if (s->opcode == WS_OP_PING) {
        // Pong-payload is the same bytes that just arrived (already
        // unmasked into rx_buf at offset msg_buf_len).
        ws_send_pong(pcb, rx_buf + s->msg_buf_len, s->payload_len);
    } else if (s->opcode == WS_OP_PONG) {
        // No-op — used to gate stall watchdog on the client side.
    } else if (s->opcode == WS_OP_CLOSE) {
        ws_send_close(pcb, WS_CLOSE_NORMAL);
        keep_open = false;
    } else {
        // Data frame (TEXT, BIN, or CONT). Bytes are already in the
        // reassembly buffer at offset msg_buf_len; bump the count.
        s->msg_buf_len = (uint16_t)(s->msg_buf_len + s->payload_len);
        if (s->fin) {
            ws_handle_message(pcb, s, rx_buf);
            s->msg_buf_len = 0;
            s->frame_in_progress = false;
        }
    }
    s->rx_state = WS_RX_NEED_HDR2;
    s->rx_hdr_have = 0;
    s->payload_len = 0;
    s->payload_pos = 0;
    return keep_open;
}

// Consume one byte through the RFC 6455 decoder. Returns:
//   true   = continue feeding bytes
//   false  = protocol error / oversize / close — caller should close
static bool ws_rx_byte(struct altcp_pcb *pcb, ws_state_t *s,
                       uint8_t *rx_buf, size_t rx_buf_size, uint8_t b) {
    switch (s->rx_state) {
    case WS_RX_NEED_HDR2: {
        s->rx_hdr[s->rx_hdr_have++] = b;
        if (s->rx_hdr_have < 2) return true;
        s->fin = (s->rx_hdr[0] >> 7) & 0x1;
        // RSV1..3 must be 0; reject otherwise.
        if (s->rx_hdr[0] & 0x70) return false;
        s->opcode = s->rx_hdr[0] & 0x0F;
        // Header byte 1: MASK + 7-bit length. Client→server frames
        // MUST be masked per RFC 6455 §5.1.
        if ((s->rx_hdr[1] & 0x80) == 0) return false;
        uint8_t len7 = s->rx_hdr[1] & 0x7F;
        // Control frames (opcode 8/9/10) must be ≤125 bytes and not
        // fragmented (FIN=1).
        if (s->opcode >= 0x8) {
            if (!s->fin || len7 > 125) return false;
        }
        if (len7 < 126) {
            s->payload_len = len7;
            s->rx_state = WS_RX_NEED_MASK;
            s->rx_hdr_have = 0;
        } else if (len7 == 126) {
            s->rx_state = WS_RX_NEED_LEN16;
            s->rx_hdr_have = 0;
        } else {
            s->rx_state = WS_RX_NEED_LEN64;
            s->rx_hdr_have = 0;
        }
        return true;
    }

    case WS_RX_NEED_LEN16:
        s->rx_hdr[s->rx_hdr_have++] = b;
        if (s->rx_hdr_have < 2) return true;
        s->payload_len = ((uint32_t)s->rx_hdr[0] << 8) | s->rx_hdr[1];
        s->rx_state = WS_RX_NEED_MASK;
        s->rx_hdr_have = 0;
        return true;

    case WS_RX_NEED_LEN64:
        s->rx_hdr[s->rx_hdr_have++] = b;
        if (s->rx_hdr_have < 8) return true;
        // Top 4 bytes must be zero (cap well below 4 GiB).
        if (s->rx_hdr[0] || s->rx_hdr[1] || s->rx_hdr[2] || s->rx_hdr[3]) return false;
        s->payload_len = ((uint32_t)s->rx_hdr[4] << 24) |
                         ((uint32_t)s->rx_hdr[5] << 16) |
                         ((uint32_t)s->rx_hdr[6] <<  8) |
                          (uint32_t)s->rx_hdr[7];
        s->rx_state = WS_RX_NEED_MASK;
        s->rx_hdr_have = 0;
        return true;

    case WS_RX_NEED_MASK: {
        s->mask_key[s->rx_hdr_have++] = b;
        if (s->rx_hdr_have < 4) return true;
        s->payload_pos = 0;

        // Size budget. Control frames live in rx_buf at offset
        // msg_buf_len for the duration of dispatch (they don't extend
        // msg_buf_len); data frames extend it. Either way the high
        // water mark is msg_buf_len + payload_len.
        uint32_t projected;
        if (s->opcode == WS_OP_CONT) {
            projected = (uint32_t)s->msg_buf_len + s->payload_len;
        } else if (s->opcode >= 0x8) {
            projected = (uint32_t)s->msg_buf_len + s->payload_len;
        } else {
            if (s->frame_in_progress) return false;  // new data frame mid-fragmentation
            projected = s->payload_len;
        }
        if (projected > (uint32_t)rx_buf_size) {
            ws_send_close(pcb, WS_CLOSE_TOO_BIG);
            return false;
        }

        // Reset reassembly state for a fresh data frame.
        if (s->opcode != WS_OP_CONT && s->opcode < 0x8) {
            s->msg_buf_len = 0;
            s->msg_opcode = s->opcode;
            s->frame_in_progress = !s->fin;
        } else if (s->opcode == WS_OP_CONT) {
            if (!s->frame_in_progress) return false;  // CONT with no prior partial
        }

        if (s->payload_len == 0) {
            // Empty payload — frame is already complete.
            return ws_frame_complete(pcb, s, rx_buf);
        }
        s->rx_state = WS_RX_NEED_PAYLOAD;
        return true;
    }

    case WS_RX_NEED_PAYLOAD: {
        uint8_t pt = b ^ s->mask_key[s->payload_pos & 3];
        rx_buf[s->msg_buf_len + s->payload_pos] = pt;
        s->payload_pos++;
        if (s->payload_pos < s->payload_len) return true;
        return ws_frame_complete(pcb, s, rx_buf);
    }
    }
    return false;
}

// --------------------------------------------------------------------------
// Outbound: ring drains + keepalive + status push
// --------------------------------------------------------------------------

// Drain log_buffer into a WS_CH_LOG text frame. Returns true if
// anything was written.
static bool ws_drain_log(struct altcp_pcb *pcb, ws_state_t *s) {
    u16_t avail = altcp_sndbuf(pcb);
    if (avail < 8) return false;            // header + tag + at least 1 byte
    uint32_t total = log_buffer_total_written();
    if (total == s->log_since) return false;
    size_t cap = (avail < WS_EGRESS_LOG_CAP + 8) ? (size_t)avail - 8 : WS_EGRESS_LOG_CAP;
    if (cap > sizeof(g_out_scratch) - 8) cap = sizeof(g_out_scratch) - 8;
    uint32_t next = s->log_since;
    size_t n = log_buffer_read(s->log_since, g_out_scratch, cap, &next);
    s->log_since = next;
    if (n == 0) return false;
    if (!ws_emit_text(pcb, WS_CH_LOG, (const char *)g_out_scratch, n)) return false;
    s->last_tx_at = get_absolute_time();
    return true;
}

// Drain data_buffer into a WS_CH_DATA binary frame. Returns true if
// anything was written.
static bool ws_drain_data(struct altcp_pcb *pcb, ws_state_t *s) {
    u16_t avail = altcp_sndbuf(pcb);
    if (avail < 8) return false;
    uint32_t total = data_buffer_total_written();
    if (total == s->data_since) return false;
    size_t cap = (avail < WS_EGRESS_DATA_CAP + 8) ? (size_t)avail - 8 : WS_EGRESS_DATA_CAP;
    if (cap > sizeof(g_out_scratch) - 8) cap = sizeof(g_out_scratch) - 8;
    uint32_t next = s->data_since;
    size_t n = data_buffer_read(s->data_since, g_out_scratch, cap, &next);
    s->data_since = next;
    if (n == 0) return false;
    if (!ws_emit_binary(pcb, WS_CH_DATA, g_out_scratch, n)) return false;
    s->last_tx_at = get_absolute_time();
    return true;
}

// Emit a synthetic keepalive DATA frame (16-byte zero-payload record
// with reserved msg_id) so the browser's stall watchdog sees bytes.
// Same byte shape as http_server.c's HTTP-side keepalive (which the
// telemetry.js parser already drops via KEEPALIVE_MSG_ID).
static void ws_emit_idle_keepalive(struct altcp_pcb *pcb, ws_state_t *s) {
    uint8_t hdr[CONDUIT_DATA_RECORD_HEADER];
    hdr[0] = CONDUIT_DATA_MAGIC;
    hdr[1] = CONDUIT_DATA_VERSION;
    hdr[2] = (uint8_t)(CONDUIT_DATA_KEEPALIVE_MSG_ID & 0xFF);
    hdr[3] = (uint8_t)((CONDUIT_DATA_KEEPALIVE_MSG_ID >> 8) & 0xFF);
    hdr[4] = (uint8_t)CONDUIT_DTYPE_U8;
    hdr[5] = 0; hdr[6] = 0;
    hdr[7] = 0;
    uint64_t now_us = (uint64_t)to_us_since_boot(get_absolute_time());
    for (int i = 0; i < 8; i++) hdr[8 + i] = (uint8_t)(now_us >> (8 * i));
    if (ws_emit_binary(pcb, WS_CH_DATA, hdr, sizeof hdr)) {
        s->last_tx_at = get_absolute_time();
    }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

void ws_server_on_open(struct altcp_pcb *pcb, ws_state_t *s,
                       uint8_t *rx_buf, size_t rx_buf_size) {
    ws_server_on_open_with_prefix(pcb, s, rx_buf, rx_buf_size, NULL, 0);
}

// See ws_server.h for the rationale. Builds the post-handshake byte
// stream — [optional HTTP 101 prefix][WS NOTICE frame for need_auth]
// — into g_out_scratch and issues ONE altcp_write so the TLS layer
// only ever produces a single application record. Without the
// coalesce, the second altcp_write occasionally lands in a different
// TLS record whose plaintext bytes get garbled (the symptom is
// `non-zero RSV bits` rejection on the client's first frame parse).
void ws_server_on_open_with_prefix(struct altcp_pcb *pcb, ws_state_t *s,
                                   uint8_t *rx_buf, size_t rx_buf_size,
                                   const uint8_t *prefix, size_t prefix_len) {
    (void)rx_buf;
    (void)rx_buf_size;
    memset(s, 0, sizeof *s);
    s->rx_state = WS_RX_NEED_HDR2;
    s->last_tx_at = get_absolute_time();
    s->last_ping_at = get_absolute_time();

    // Build the initial NOTICE body in a small stack buffer so we
    // can compute its frame size up front and lay out the combined
    // scratch precisely.
    char notice_body[64];
    int notice_len = snprintf(notice_body, sizeof(notice_body),
                              "{\"kind\":\"need_auth\"}");
    if (notice_len <= 0) return;
    if (notice_len >= (int)sizeof(notice_body)) notice_len = (int)sizeof(notice_body) - 1;

    // WS frame for the NOTICE: header + channel byte + body.
    uint8_t ws_hdr[10];
    uint32_t ws_payload_total = (uint32_t)(1 + notice_len);   // channel tag + body
    size_t ws_hdr_len = ws_build_header(ws_hdr, WS_OP_TEXT, ws_payload_total);
    size_t ws_frame_len = ws_hdr_len + ws_payload_total;

    size_t total = prefix_len + ws_frame_len;
    if (total > sizeof(g_out_scratch)) return;     // should never happen on the open path
    if (total > altcp_sndbuf(pcb))      return;    // ditto: sndbuf is full MSS on a fresh accept

    size_t off = 0;
    if (prefix && prefix_len > 0) {
        memcpy(g_out_scratch + off, prefix, prefix_len);
        off += prefix_len;
    }
    memcpy(g_out_scratch + off, ws_hdr, ws_hdr_len);
    off += ws_hdr_len;
    g_out_scratch[off++] = WS_CH_NOTICE;
    memcpy(g_out_scratch + off, notice_body, (size_t)notice_len);
    off += (size_t)notice_len;

    err_t e = altcp_write(pcb, g_out_scratch, off, TCP_WRITE_FLAG_COPY);
    if (e != ERR_OK) return;
    altcp_output(pcb);
    s->last_tx_at = get_absolute_time();
}

bool ws_server_on_bytes(struct altcp_pcb *pcb, ws_state_t *s,
                        uint8_t *rx_buf, size_t rx_buf_size,
                        const uint8_t *data, uint16_t len) {
    for (uint16_t i = 0; i < len; i++) {
        if (!ws_rx_byte(pcb, s, rx_buf, rx_buf_size, data[i])) {
            return false;
        }
    }
    // Opportunistic flush: any inbound activity is a chance to drain
    // the rings without waiting for the slow timer. This is the
    // <100 ms latency hook on the server→client side for clients that
    // are also sending (e.g. a CMD reply piggybacks with the next
    // batch of LOG/DATA).
    ws_server_poll(pcb, s);
    return true;
}

void ws_server_poll(struct altcp_pcb *pcb, ws_state_t *s) {
    if (!s->authed) {
        // Pre-auth: no streams flow. The browser sent its WebSocket
        // open, we sent need_auth; we're waiting for an auth CMD.
        return;
    }

    // Schema-version cross-core hook. data_buffer.c bumps the
    // counter whenever a new (msg_id, name) slot is allocated. We
    // read it here on Core 1 — the only side that touches the
    // ws_state_t fields — and push a refreshed STATUS so the IDE's
    // inlined data_schema picks up the new entry in-band, avoiding
    // its unknown-msgId → cold-TLS HTTPS-refresh fallback. The
    // Core-0 producer NEVER walks http_conn_pool from here, so the
    // earlier race that left status_dirty set on a half-torn-down
    // conn is gone.
    if (data_buffer_schema_version() != s->schema_version_seen) {
        s->status_dirty = true;
    }

    if (s->status_dirty) {
        ws_push_status(pcb, s);
    }

    bool wrote = false;
    if (ws_drain_log(pcb, s)) wrote = true;
    if (ws_drain_data(pcb, s)) wrote = true;

    // Idle keepalive on the DATA channel: when neither ring produced
    // bytes and the WS connection has been silent for WS_KEEPALIVE_MS,
    // emit a single synthetic data frame so the browser's stall
    // watchdog sees lastByteMs ticking. Mirrors the HTTP-side cadence
    // — saved memory project_https_keepalive_cadence_wedge.md forbids
    // raising STREAM_KEEPALIVE_MS above 500 ms.
    if (!wrote && time_reached(delayed_by_ms(s->last_tx_at, WS_KEEPALIVE_MS))) {
        ws_emit_idle_keepalive(pcb, s);
    }

    // App-layer PING every WS_PING_INTERVAL_MS. Catches a wedged
    // mbedtls that TCP keepalive can't see (TLS records still flow at
    // the TCP level even when the mbedtls reassembler is stuck).
    if (time_reached(delayed_by_ms(s->last_ping_at, WS_PING_INTERVAL_MS))) {
        ws_send_ping(pcb);
        s->last_ping_at = get_absolute_time();
    }
}
