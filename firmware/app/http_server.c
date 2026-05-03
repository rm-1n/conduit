/**
 * Raw TCP HTTP server for CONDUIT.
 *
 * Implements a minimal HTTP/1.1 server using lwIP raw TCP API.
 * Routes:
 *   OPTIONS *           → CORS + Private Network Access preflight
 *   GET  /api/status    → JSON device status
 *   POST /api/upload    → UF2 firmware upload (auth required)
 *   POST /api/reboot    → Controlled reboot (auth required)
 *   *                   → 404
 *
 * All responses include CORS and PNA headers.
 */

#include "http_server.h"
#include "network.h"
#include "ota.h"
#include "conduit_config.h"
#include "log_buffer.h"
#include "data_buffer.h"
#include "commands.h"
#include "rmii_ethernet/netif.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#include "lwip/tcp.h"
#include "lwip/pbuf.h"
#include "pico/unique_id.h"
#include "pico/stdlib.h"
#include "pico/bootrom.h"
#include "boot/picoboot_constants.h"
#include "boot/picobin.h"
#include "hardware/watchdog.h"

// Maximum HTTP header size we'll parse
#define HTTP_MAX_HEADER  2048
// Maximum response size
#define HTTP_MAX_RESPONSE 1024

typedef enum {
    CONN_STATE_HEADER,     // Accumulating headers
    CONN_STATE_BODY,       // Receiving POST body
    CONN_STATE_WAITING,    // /api/log long-poll: holding until data or deadline
    CONN_STATE_STREAMING,  // /api/log?stream=1: persistent push of new bytes
    CONN_STATE_DONE,       // Response sent, waiting for close
} conn_state_t;

typedef enum {
    METHOD_UNKNOWN = 0,
    METHOD_GET,
    METHOD_POST,
    METHOD_OPTIONS,
} http_method_t;

typedef enum {
    ROUTE_UNKNOWN = 0,
    ROUTE_STATUS,
    ROUTE_UPLOAD,
    ROUTE_REBOOT,
    ROUTE_COMMIT,
    ROUTE_LOG,
    ROUTE_DATA,         // /api/data — binary record stream
    ROUTE_DATA_SCHEMA,  // /api/data_schema — id→name JSON
    ROUTE_CMD,          // /api/cmd — POST command dispatch (auth)
} route_t;

typedef struct {
    conn_state_t state;
    http_method_t method;
    route_t route;
    bool authenticated;
    bool ota_start;    // X-OTA-Start: 1 — call ota_begin before streaming
    bool ota_finish;   // X-OTA-Finish: 1 — call ota_finish after body
    uint32_t content_length;
    uint32_t body_received;
    char header_buf[HTTP_MAX_HEADER];
    uint16_t header_len;
    bool headers_complete;
    // /api/log long-poll state (only meaningful when state == WAITING).
    uint32_t log_since;
    absolute_time_t log_deadline;
    // /api/data stream flag. STREAMING covers both /api/log?stream=1 and
    // /api/data?stream=1; this bit tells http_poll which ring to drain.
    bool data_stream;
    // Wall-clock of the last byte http_poll wrote to this PCB (real
    // record bytes OR a keepalive). When STREAMING ring is empty for
    // STREAM_KEEPALIVE_MS we emit a tiny in-band marker so the
    // browser's 1 s stall watchdog has something to count against —
    // without this, a quiet device looks identical to a wedged TX
    // path and the indicator flaps "no data" forever.
    absolute_time_t last_tx_at;
} http_conn_t;

// --------------------------------------------------------------------------
// CORS / PNA headers appended to every response
// --------------------------------------------------------------------------
static const char *cors_headers =
    "Access-Control-Allow-Origin: " CONDUIT_CORS_ORIGIN "\r\n"
    "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
    "Access-Control-Allow-Headers: X-Auth-Token, Content-Type, "
        "X-OTA-Start, X-OTA-Finish\r\n"
    "Access-Control-Allow-Private-Network: true\r\n"
    "Access-Control-Max-Age: 86400\r\n";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

static void get_board_id(char *out, size_t max) {
    pico_unique_board_id_t id;
    pico_get_unique_board_id(&id);
    size_t pos = 0;
    for (int i = 0; i < PICO_UNIQUE_BOARD_ID_SIZE_BYTES && pos + 2 < max; i++) {
        pos += snprintf(out + pos, max - pos, "%02x", id.id[i]);
    }
}

// Case-insensitive header search. Returns pointer to value (after ": ") or NULL.
static const char *find_header(const char *headers, const char *name) {
    size_t name_len = strlen(name);
    const char *p = headers;
    while (*p) {
        // Compare header name case-insensitively
        if (strncasecmp(p, name, name_len) == 0 && p[name_len] == ':') {
            const char *val = p + name_len + 1;
            while (*val == ' ') val++;
            return val;
        }
        // Skip to next line
        const char *nl = strstr(p, "\r\n");
        if (!nl) break;
        p = nl + 2;
    }
    return NULL;
}

// Get value of a header as a string, up to delimiter (usually \r\n)
static size_t copy_header_value(const char *val, char *out, size_t max) {
    size_t i = 0;
    while (val[i] && val[i] != '\r' && val[i] != '\n' && i < max - 1) {
        out[i] = val[i];
        i++;
    }
    out[i] = '\0';
    return i;
}

// Forward decls.
static err_t http_poll(void *arg, struct tcp_pcb *pcb);
static void conn_close(struct tcp_pcb *pcb, http_conn_t *conn);
static void enable_keepalive(struct tcp_pcb *pcb);

// --------------------------------------------------------------------------
// Streaming-connection registry
// --------------------------------------------------------------------------
// Tracks currently-open /api/log?stream=1 and /api/data?stream=1 PCBs
// so http_server_on_link_down() can abort them all on cable unplug.
// Without this, vanished-client streamers sit in the small
// MEMP_NUM_TCP_PCB pool for ~50 s (keepalive probe duration) and the
// browser's reconnect SYNs get refused because the pool is full.
typedef struct {
    struct tcp_pcb *pcb;
    http_conn_t    *conn;
} stream_reg_entry_t;

#define STREAM_REG_SIZE  MEMP_NUM_TCP_PCB
static stream_reg_entry_t stream_registry[STREAM_REG_SIZE];

// HTTP-server-specific diagnostic counters surfaced via diag.c. See the
// header for what each tracks and how to interpret deltas across a
// cable cycle.
static volatile uint32_t g_accepts_total         = 0;
static volatile uint32_t g_streams_started_total = 0;

uint32_t http_server_accepts(void)         { return g_accepts_total; }
uint32_t http_server_streams_started(void) { return g_streams_started_total; }

static void register_streaming(struct tcp_pcb *pcb, http_conn_t *conn) {
    for (int i = 0; i < STREAM_REG_SIZE; i++) {
        if (stream_registry[i].pcb == NULL) {
            stream_registry[i].pcb  = pcb;
            stream_registry[i].conn = conn;
            return;
        }
    }
}

// Idempotent. Matches by pcb when available, otherwise by conn (http_err
// only has the conn pointer because lwIP has already freed the pcb by
// the time the err callback fires).
static void unregister_streaming(struct tcp_pcb *pcb, http_conn_t *conn) {
    for (int i = 0; i < STREAM_REG_SIZE; i++) {
        if ((pcb && stream_registry[i].pcb == pcb) ||
            (conn && stream_registry[i].conn == conn)) {
            stream_registry[i].pcb  = NULL;
            stream_registry[i].conn = NULL;
            return;
        }
    }
}

// --------------------------------------------------------------------------
// Response builders
// --------------------------------------------------------------------------

static err_t send_response(struct tcp_pcb *pcb, const char *status,
                           const char *content_type, const char *body, size_t body_len) {
    char hdr[512];
    int hdr_len = snprintf(hdr, sizeof(hdr),
        "HTTP/1.1 %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %u\r\n"
        "Connection: close\r\n"
        "%s"
        "\r\n",
        status, content_type, (unsigned)body_len, cors_headers);

    tcp_write(pcb, hdr, hdr_len, TCP_WRITE_FLAG_COPY);
    if (body && body_len > 0) {
        tcp_write(pcb, body, body_len, TCP_WRITE_FLAG_COPY);
    }
    tcp_output(pcb);
    return ERR_OK;
}

static err_t send_json(struct tcp_pcb *pcb, const char *status, const char *json) {
    return send_response(pcb, status, "application/json", json, strlen(json));
}

static err_t send_error(struct tcp_pcb *pcb, const char *status, const char *message) {
    char buf[256];
    int len = snprintf(buf, sizeof(buf), "{\"error\":\"%s\"}", message);
    return send_response(pcb, status, "application/json", buf, len);
}

static err_t send_cors_preflight(struct tcp_pcb *pcb) {
    return send_response(pcb, "204 No Content", "text/plain", NULL, 0);
}

// --------------------------------------------------------------------------
// Route handlers
// --------------------------------------------------------------------------

static void handle_status(struct tcp_pcb *pcb) {
    char board_id[32];
    get_board_id(board_id, sizeof(board_id));

    // Detect which A/B partition we booted from.
    // rom_get_boot_info returns >= 0 on success.
    char active_partition = '?';
    boot_info_t boot_info;
    if (rom_get_boot_info(&boot_info) >= 0) {
        switch (boot_info.partition) {
            case 0:  active_partition = 'A'; break;
            case 1:  active_partition = 'B'; break;
            case -1: active_partition = '-'; break; // unpartitioned / direct boot
            default: active_partition = '?'; break;
        }
    }

    char json[HTTP_MAX_RESPONSE];
    int len = snprintf(json, sizeof(json),
        "{"
        "\"version\":\"%s\","
        "\"ip\":\"%s\","
        "\"mac\":\"%s\","
        "\"uptime\":%u,"
        "\"link\":%s,"
        "\"poe\":%s,"
        "\"partition\":\"%c\","
        "\"board_id\":\"%s\","
        "\"ota_in_progress\":%s,"
        "\"ota_bytes_written\":%u,"
        "\"rx_drops\":%u,"
        "\"boot_type\":\"%s\","
        "\"tbyb_pending\":%s,"
        "\"device\":\"conduit\""
        "}",
        CONDUIT_VERSION_STRING,
        network_get_ip_str(),
        network_get_mac_str(),
        network_get_uptime_s(),
        network_is_link_up() ? "true" : "false",
        network_get_poe_status() ? "true" : "false",
        active_partition,
        board_id,
        ota_in_progress() ? "true" : "false",
        ota_bytes_written(),
        (unsigned)netif_rmii_ethernet_rx_drops(),
        ota_boot_type_str(),
        ota_commit_pending() ? "true" : "false");

    send_json(pcb, "200 OK", json);
}

static void handle_upload_begin(struct tcp_pcb *pcb, http_conn_t *conn) {
    if (!conn->authenticated) {
        send_error(pcb, "403 Forbidden", "invalid or missing auth token");
        conn->state = CONN_STATE_DONE;
        return;
    }

    // Three valid request shapes:
    //   X-OTA-Start   → begin a new session, then stream body bytes.
    //   X-OTA-Finish  → stream body bytes into an already-open session,
    //                   and call ota_finish() at end-of-body.
    //   (neither)     → stream body bytes into an already-open session,
    //                   keep it open.
    // Legacy one-shot uploads should set BOTH X-OTA-Start and X-OTA-Finish.
    if (conn->ota_start) {
        ota_err_t err = ota_begin();
        if (err != OTA_OK) {
            send_error(pcb, "500 Internal Server Error", ota_error_string(err));
            conn->state = CONN_STATE_DONE;
            return;
        }
    } else if (!ota_in_progress()) {
        send_error(pcb, "409 Conflict", "no OTA session in progress");
        conn->state = CONN_STATE_DONE;
        return;
    }

    conn->state = CONN_STATE_BODY;
}

static void handle_upload_data(struct tcp_pcb *pcb, http_conn_t *conn,
                               const uint8_t *data, size_t len) {
    ota_err_t err = ota_write_chunk(data, len);
    if (err != OTA_OK) {
        send_error(pcb, "422 Unprocessable Entity", ota_error_string(err));
        conn->state = CONN_STATE_DONE;
        return;
    }

    conn->body_received += len;

    if (conn->content_length > 0 && conn->body_received >= conn->content_length) {
        if (conn->ota_finish) {
            err = ota_finish();
            if (err != OTA_OK) {
                send_error(pcb, "422 Unprocessable Entity", ota_error_string(err));
            } else {
                send_json(pcb, "200 OK", "{\"ok\":true,\"message\":\"update complete, rebooting\"}");
            }
        } else {
            // Intermediate chunk — ack with current progress, keep OTA open.
            char body[96];
            int n = snprintf(body, sizeof(body),
                "{\"ok\":true,\"bytes_written\":%u}", (unsigned)ota_bytes_written());
            send_response(pcb, "200 OK", "application/json", body, (size_t)n);
        }
        conn->state = CONN_STATE_DONE;
    }
}

static void handle_reboot(struct tcp_pcb *pcb, http_conn_t *conn) {
    if (!conn->authenticated) {
        send_error(pcb, "403 Forbidden", "invalid or missing auth token");
        conn->state = CONN_STATE_DONE;
        return;
    }

    send_json(pcb, "200 OK", "{\"ok\":true,\"message\":\"rebooting\"}");
    conn->state = CONN_STATE_DONE;

    // Reboot after a short delay to let the response send.
    //
    // g_reboot_pending tells main() (on core 0) to stop calling
    // watchdog_update() — rom_reboot / watchdog_reboot program the same
    // watchdog LOAD register to fire the reset after delay_ms, and if the
    // main loop pats the dog during that window the countdown is reset
    // before it can fire. See memory:project_rom_reboot_watchdog_race.
    sleep_ms(200);
    extern volatile bool g_reboot_pending;
    __atomic_store_n(&g_reboot_pending, true, __ATOMIC_RELEASE);
    watchdog_reboot(0, 0, 100);
    // Busy-wait while the watchdog counts down.
    while (1) tight_loop_contents();
}

// Send the log response for a given `since`. Used by both the immediate
// path and the long-poll deadline path. log_out is static because both
// callers run on the lwIP tcpip thread, so calls are serialized.
static void send_log_response(struct tcp_pcb *pcb, uint32_t since) {
    static uint8_t log_out[4096];
    uint32_t next_cursor = since;
    size_t n = log_buffer_read(since, log_out, sizeof(log_out), &next_cursor);

    char hdr[768];
    int hdr_len = snprintf(hdr, sizeof(hdr),
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        "Content-Length: %u\r\n"
        "X-Log-Cursor: %u\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n"
        "%s"
        "Access-Control-Expose-Headers: X-Log-Cursor\r\n"
        "\r\n",
        (unsigned)n, (unsigned)next_cursor, cors_headers);
    // snprintf returns the length it WOULD have written if the buffer were
    // unbounded; clamp so we never tcp_write bytes past the buffer end.
    if (hdr_len < 0) hdr_len = 0;
    if (hdr_len > (int)sizeof(hdr)) hdr_len = (int)sizeof(hdr);
    tcp_write(pcb, hdr, hdr_len, TCP_WRITE_FLAG_COPY);
    if (n > 0) tcp_write(pcb, log_out, n, TCP_WRITE_FLAG_COPY);
    tcp_output(pcb);
}

// Send the streaming-mode response headers — no Content-Length, no
// Transfer-Encoding; the body extends until we close the connection.
// HTTP/1.1 § 3.3.3 case 7 allows this when Connection: close is set, and
// browsers consume it via fetch().body.getReader() with no special framing.
static void send_log_stream_headers(struct tcp_pcb *pcb, uint32_t start_cursor) {
    char hdr[768];
    int hdr_len = snprintf(hdr, sizeof(hdr),
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        "X-Log-Cursor: %u\r\n"
        "Cache-Control: no-store\r\n"
        // Disables proxy buffering on nginx/caddy paths (harmless otherwise);
        // ensures intermediaries flush each tcp_write through immediately.
        "X-Accel-Buffering: no\r\n"
        "Connection: close\r\n"
        "%s"
        "Access-Control-Expose-Headers: X-Log-Cursor\r\n"
        "\r\n",
        (unsigned)start_cursor, cors_headers);
    if (hdr_len < 0) hdr_len = 0;
    if (hdr_len > (int)sizeof(hdr)) hdr_len = (int)sizeof(hdr);
    tcp_write(pcb, hdr, hdr_len, TCP_WRITE_FLAG_COPY);
    tcp_output(pcb);
}

// Return the chunk of the log ring buffer the caller hasn't seen yet.
// GET /api/log                       → empty body, X-Log-Cursor: <current>.
// GET /api/log?since=N               → bytes [N, next_cursor) immediately.
// GET /api/log?since=N&wait_ms=M     → long-poll: hold up to M ms (≤30_000),
//                                      respond on first byte OR deadline.
// GET /api/log?since=N&stream=1      → persistent stream: connection stays
//                                      open and the firmware writes new
//                                      bytes as conduit_log() produces them,
//                                      until the client closes. Client
//                                      tracks cursor by counting received
//                                      bytes (initial position is the
//                                      X-Log-Cursor header on the response).
// Client updates its cursor from X-Log-Cursor. If the client fell behind
// more than LOG_BUFFER_SIZE bytes the firmware fast-forwards to the oldest
// retained byte.
//
// No auth required — this endpoint is read-only and only exposes printf
// output, which is already echoed on USB serial.
static void handle_log(struct tcp_pcb *pcb, http_conn_t *conn) {
    // Parse ?since=N, ?wait_ms=M, ?stream=1 from the request line.
    uint32_t since = 0;
    uint32_t wait_ms = 0;
    bool have_since = false;
    bool stream = false;
    {
        const char *space = strchr(conn->header_buf, ' ');
        const char *q = space ? strchr(space + 1, '?') : NULL;
        const char *end = space ? strchr(space + 1, ' ') : NULL;
        if (q && end && q < end) {
            const char *p = q + 1;
            while (p < end) {
                if (strncmp(p, "since=", 6) == 0) {
                    since = (uint32_t)strtoul(p + 6, NULL, 10);
                    have_since = true;
                } else if (strncmp(p, "wait_ms=", 8) == 0) {
                    wait_ms = (uint32_t)strtoul(p + 8, NULL, 10);
                    // Cap so a pathological client can't park a TCP PCB
                    // indefinitely. 30s > browser long-poll window (~20s).
                    if (wait_ms > 30000) wait_ms = 30000;
                } else if (strncmp(p, "stream=1", 8) == 0) {
                    stream = true;
                }
                const char *amp = memchr(p, '&', end - p);
                if (!amp) break;
                p = amp + 1;
            }
        }
    }
    if (!have_since) since = log_buffer_total_written();

    if (stream) {
        // Persistent push. Tell the client the starting cursor in headers,
        // then keep the connection open — http_poll drains new bytes onto
        // the wire each tick. Disable Nagle so a single short log line
        // (≪ MSS) doesn't sit in the send buffer waiting for company.
        //
        // Clamp `since` to current total: after a device reboot the
        // browser may carry an old cursor that's far past the now-zeroed
        // ring counter. Storing that stale value as conn->log_since wedges
        // the stream — http_poll calls log_buffer_read which clamps its
        // local since but never writes back, so conn->log_since stays
        // huge and zero-byte reads spin forever until total catches up.
        uint32_t total = log_buffer_total_written();
        if (since > total) since = total;
        send_log_stream_headers(pcb, since);
        conn->log_since = since;
        conn->state = CONN_STATE_STREAMING;
        tcp_nagle_disable(pcb);
        enable_keepalive(pcb);
        register_streaming(pcb, conn);
        g_streams_started_total++;
        tcp_poll(pcb, http_poll, 1);
        return;
    }

    // If the client asked to wait and there's nothing new, park the
    // connection — the tcp_poll callback will resume it when data arrives
    // or the deadline is reached. tcp_poll fires every `interval` ticks of
    // the lwIP coarse timer (TCP_SLOW_INTERVAL, typically 500ms), so
    // interval=1 gives us ~500ms resolution — fine for interactive logs.
    if (wait_ms > 0 && log_buffer_total_written() == since) {
        conn->log_since = since;
        conn->log_deadline = make_timeout_time_ms(wait_ms);
        conn->state = CONN_STATE_WAITING;
        tcp_poll(pcb, http_poll, 1);
        return;
    }

    send_log_response(pcb, since);
    conn->state = CONN_STATE_DONE;
}

// Send the response headers for /api/data?stream=1. Content is octet-
// stream; body extends to close. X-Data-Cursor hands the client its
// starting byte offset so it can track position across reconnects.
static void send_data_stream_headers(struct tcp_pcb *pcb, uint32_t start_cursor) {
    char hdr[768];
    int hdr_len = snprintf(hdr, sizeof(hdr),
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/octet-stream\r\n"
        "X-Data-Cursor: %u\r\n"
        "Cache-Control: no-store\r\n"
        "X-Accel-Buffering: no\r\n"
        "Connection: close\r\n"
        "%s"
        "Access-Control-Expose-Headers: X-Data-Cursor\r\n"
        "\r\n",
        (unsigned)start_cursor, cors_headers);
    if (hdr_len < 0) hdr_len = 0;
    if (hdr_len > (int)sizeof(hdr)) hdr_len = (int)sizeof(hdr);
    tcp_write(pcb, hdr, hdr_len, TCP_WRITE_FLAG_COPY);
    tcp_output(pcb);
}

// GET /api/data?stream=1[&since=N] — persistent binary push of poe_data
// records. Wire format is documented in data_buffer.h. Unlike /api/log
// this endpoint has no long-poll mode: the browser's parser relies on
// immediate framing recovery at the magic-byte boundary.
static void handle_data(struct tcp_pcb *pcb, http_conn_t *conn) {
    uint32_t since = 0;
    bool have_since = false;
    bool stream = false;
    {
        const char *space = strchr(conn->header_buf, ' ');
        const char *q = space ? strchr(space + 1, '?') : NULL;
        const char *end = space ? strchr(space + 1, ' ') : NULL;
        if (q && end && q < end) {
            const char *p = q + 1;
            while (p < end) {
                if (strncmp(p, "since=", 6) == 0) {
                    since = (uint32_t)strtoul(p + 6, NULL, 10);
                    have_since = true;
                } else if (strncmp(p, "stream=1", 8) == 0) {
                    stream = true;
                }
                const char *amp = memchr(p, '&', end - p);
                if (!amp) break;
                p = amp + 1;
            }
        }
    }
    if (!have_since) since = data_buffer_total_written();

    if (stream) {
        // Clamp `since` to current total — see handle_log for the full
        // explanation of why a stale browser-side cursor would wedge the
        // stream after a device reboot.
        uint32_t total = data_buffer_total_written();
        if (since > total) since = total;
        send_data_stream_headers(pcb, since);
        conn->log_since = since;          // reused field; holds data-ring cursor
        conn->data_stream = true;
        conn->state = CONN_STATE_STREAMING;
        tcp_nagle_disable(pcb);
        enable_keepalive(pcb);
        register_streaming(pcb, conn);
        g_streams_started_total++;
        tcp_poll(pcb, http_poll, 1);
        return;
    }

    // Non-stream: one-shot dump of everything retained since `since`.
    static uint8_t out[4096];
    uint32_t next_cursor = since;
    size_t n = data_buffer_read(since, out, sizeof(out), &next_cursor);
    char hdr[640];
    int hdr_len = snprintf(hdr, sizeof(hdr),
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/octet-stream\r\n"
        "Content-Length: %u\r\n"
        "X-Data-Cursor: %u\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n"
        "%s"
        "Access-Control-Expose-Headers: X-Data-Cursor\r\n"
        "\r\n",
        (unsigned)n, (unsigned)next_cursor, cors_headers);
    if (hdr_len < 0) hdr_len = 0;
    if (hdr_len > (int)sizeof(hdr)) hdr_len = (int)sizeof(hdr);
    tcp_write(pcb, hdr, hdr_len, TCP_WRITE_FLAG_COPY);
    if (n > 0) tcp_write(pcb, out, n, TCP_WRITE_FLAG_COPY);
    tcp_output(pcb);
    conn->state = CONN_STATE_DONE;
}

// GET /api/data_schema — returns {"id":"name", …} so the browser can label
// each record stream with a human-readable name when exporting HDF5.
static void handle_data_schema(struct tcp_pcb *pcb, http_conn_t *conn) {
    char body[512];
    size_t n = data_buffer_schema_json(body, sizeof(body));
    send_response(pcb, "200 OK", "application/json", body, n);
    conn->state = CONN_STATE_DONE;
}

static void handle_commit(struct tcp_pcb *pcb, http_conn_t *conn) {
    if (!conn->authenticated) {
        send_error(pcb, "403 Forbidden", "invalid or missing auth token");
        conn->state = CONN_STATE_DONE;
        return;
    }

    ota_commit_result_t r = ota_commit();
    const char *body;
    const char *status;
    switch (r) {
        case OTA_COMMIT_OK:
            status = "200 OK";
            body = "{\"ok\":true,\"committed\":true}";
            break;
        case OTA_COMMIT_NOT_PENDING:
            // Returning 200 on idempotent no-op so retries don't look like
            // a protocol error. The caller can tell by committed=false.
            status = "200 OK";
            body = "{\"ok\":true,\"committed\":false,\"message\":\"not in TBYB mode\"}";
            break;
        case OTA_COMMIT_FAILED:
        default:
            status = "500 Internal Server Error";
            body = "{\"ok\":false,\"error\":\"rom_explicit_buy failed\"}";
            break;
    }
    send_json(pcb, status, body);
    conn->state = CONN_STATE_DONE;
}

// POST /api/cmd?name=<cmd>&<arg>=<val>... — auth-required dispatch into
// the commands module. Reply is JSON: 200 {"ok":true,"result":<obj>} on
// success, 4xx/5xx with {"ok":false,"error":"..."} otherwise.
//
// Args go in the query string to keep the firmware free of a JSON parser
// (matches the /api/log query-string style). Handler-side parsers live
// in commands.c.
static void handle_cmd(struct tcp_pcb *pcb, http_conn_t *conn) {
    if (!conn->authenticated) {
        send_error(pcb, "403 Forbidden", "invalid or missing auth token");
        conn->state = CONN_STATE_DONE;
        return;
    }

    // Locate the query string and pull out name=... up to '&' or path-end.
    const char *space = strchr(conn->header_buf, ' ');
    const char *q = space ? strchr(space + 1, '?') : NULL;
    const char *path_end = space ? strchr(space + 1, ' ') : NULL;
    if (!q || !path_end || q >= path_end) {
        send_error(pcb, "400 Bad Request", "missing query string");
        conn->state = CONN_STATE_DONE;
        return;
    }
    const char *qs = q + 1;
    size_t qs_len = (size_t)(path_end - qs);
    if (qs_len == 0 || qs_len >= 1024) {
        send_error(pcb, "400 Bad Request", "bad query string");
        conn->state = CONN_STATE_DONE;
        return;
    }

    // Snapshot the query string so we can null-terminate it (the request
    // line ends with a space, not a NUL, in the header_buf).
    char qs_buf[1024];
    memcpy(qs_buf, qs, qs_len);
    qs_buf[qs_len] = '\0';

    // Extract `name=<...>` (must be the first or any param).
    char name[64] = {0};
    {
        const char *p = qs_buf;
        while (*p) {
            if (strncmp(p, "name=", 5) == 0) {
                const char *v = p + 5;
                const char *end = strchr(v, '&');
                size_t n = end ? (size_t)(end - v) : strlen(v);
                if (n == 0 || n >= sizeof(name)) break;
                memcpy(name, v, n);
                name[n] = '\0';
                break;
            }
            const char *amp = strchr(p, '&');
            if (!amp) break;
            p = amp + 1;
        }
    }
    if (!name[0]) {
        send_error(pcb, "400 Bad Request", "missing name");
        conn->state = CONN_STATE_DONE;
        return;
    }

    char result[512];
    int written = commands_dispatch(name, qs_buf, result, sizeof(result));

    if (written == -1) {
        send_error(pcb, "404 Not Found", "unknown command");
    } else if (written < 0) {
        // result holds a bare error message. Escape JSON specials so a "
        // or \ in the message can't break the wrapper.
        char esc[256];
        size_t ei = 0;
        for (size_t i = 0; result[i] != '\0' && ei + 2 < sizeof(esc); i++) {
            char c = result[i];
            if (c == '"' || c == '\\') { esc[ei++] = '\\'; esc[ei++] = c; }
            else if ((unsigned char)c < 0x20) { /* drop control chars */ }
            else esc[ei++] = c;
        }
        esc[ei] = '\0';
        char body[320];
        int n = snprintf(body, sizeof(body), "{\"ok\":false,\"error\":\"%s\"}", esc);
        if (n < 0) n = 0;
        // 400 is more honest than 500 for handler-rejected inputs (bad pin,
        // bad value, etc.); the response body carries the precise reason.
        send_response(pcb, "400 Bad Request", "application/json", body, (size_t)n);
    } else {
        // result is the JSON for the "result" field. Wrap it in {ok:true,result:...}.
        char body[640];
        int n = snprintf(body, sizeof(body), "{\"ok\":true,\"result\":%.*s}",
                         (int)((size_t)written < sizeof(result) ? (size_t)written : sizeof(result) - 1),
                         result);
        if (n < 0) n = 0;
        send_response(pcb, "200 OK", "application/json", body, (size_t)n);
    }
    conn->state = CONN_STATE_DONE;
}

// --------------------------------------------------------------------------
// HTTP parser
// --------------------------------------------------------------------------

static void parse_request_line(http_conn_t *conn) {
    // Parse method
    if (strncmp(conn->header_buf, "GET ", 4) == 0) {
        conn->method = METHOD_GET;
    } else if (strncmp(conn->header_buf, "POST ", 5) == 0) {
        conn->method = METHOD_POST;
    } else if (strncmp(conn->header_buf, "OPTIONS ", 8) == 0) {
        conn->method = METHOD_OPTIONS;
    }

    // Parse path
    const char *path = strchr(conn->header_buf, ' ');
    if (path) {
        path++; // skip space
        if (strncmp(path, "/api/status", 11) == 0) {
            conn->route = ROUTE_STATUS;
        } else if (strncmp(path, "/api/upload", 11) == 0) {
            conn->route = ROUTE_UPLOAD;
        } else if (strncmp(path, "/api/reboot", 11) == 0) {
            conn->route = ROUTE_REBOOT;
        } else if (strncmp(path, "/api/commit", 11) == 0) {
            conn->route = ROUTE_COMMIT;
        } else if (strncmp(path, "/api/log", 8) == 0) {
            conn->route = ROUTE_LOG;
        } else if (strncmp(path, "/api/data_schema", 16) == 0) {
            // Must be tested before /api/data — it's a prefix.
            conn->route = ROUTE_DATA_SCHEMA;
        } else if (strncmp(path, "/api/data", 9) == 0) {
            conn->route = ROUTE_DATA;
        } else if (strncmp(path, "/api/cmd", 8) == 0) {
            // /api/cmd is not a prefix of /api/commit (mismatch at the 8th
            // char: "cmd" vs "com"), so ordering relative to ROUTE_COMMIT
            // doesn't matter.
            conn->route = ROUTE_CMD;
        }
    }

    // Parse Content-Length
    const char *cl = find_header(conn->header_buf, "Content-Length");
    if (cl) {
        conn->content_length = (uint32_t)strtoul(cl, NULL, 10);
    }

    // Parse chunked-OTA control headers. Value "1" enables. Any other value
    // (or missing header) leaves the flag false.
    const char *ota_start = find_header(conn->header_buf, "X-OTA-Start");
    if (ota_start && ota_start[0] == '1') conn->ota_start = true;
    const char *ota_finish = find_header(conn->header_buf, "X-OTA-Finish");
    if (ota_finish && ota_finish[0] == '1') conn->ota_finish = true;

    // Parse auth token
    const char *token = find_header(conn->header_buf, "X-Auth-Token");
    if (token) {
        char token_val[128];
        copy_header_value(token, token_val, sizeof(token_val));
        // Constant-time comparison to prevent timing attacks
        size_t expected_len = strlen(CONDUIT_AUTH_TOKEN);
        size_t actual_len = strlen(token_val);
        volatile uint8_t result = 0;
        size_t cmp_len = (actual_len < expected_len) ? expected_len : actual_len;
        for (size_t i = 0; i < cmp_len; i++) {
            char a = (i < actual_len) ? token_val[i] : 0;
            char b = (i < expected_len) ? CONDUIT_AUTH_TOKEN[i] : 0;
            result |= a ^ b;
        }
        result |= (actual_len != expected_len);
        conn->authenticated = (result == 0);
    }
}

// --------------------------------------------------------------------------
// TCP callbacks
// --------------------------------------------------------------------------

// Turn on TCP keepalive for streaming connections. Without this, a
// vanished client (browser tab put to sleep, OS VPN drop, NAT box
// reboot — anything that drops packets without sending FIN/RST) holds
// a PCB indefinitely; after MEMP_NUM_TCP_PCB such events the device
// stops accepting new connections even though the firmware is healthy.
// Probes start after KEEP_IDLE_MS of silence, retry every KEEP_INTVL_MS
// up to KEEP_CNT failures → vanished client costs ≈ 50 s before the
// PCB is reaped.
#define HTTP_KEEP_IDLE_MS   30000
#define HTTP_KEEP_INTVL_MS   5000
#define HTTP_KEEP_CNT           4
static void enable_keepalive(struct tcp_pcb *pcb) {
    pcb->so_options |= SOF_KEEPALIVE;
    pcb->keep_idle  = HTTP_KEEP_IDLE_MS;
    pcb->keep_intvl = HTTP_KEEP_INTVL_MS;
    pcb->keep_cnt   = HTTP_KEEP_CNT;
}

void http_server_on_link_down(void) {
    int aborted = 0;
    for (int i = 0; i < STREAM_REG_SIZE; i++) {
        struct tcp_pcb *pcb = stream_registry[i].pcb;
        http_conn_t   *conn = stream_registry[i].conn;
        if (!pcb) continue;
        // Belt-and-braces: only abort entries that are still in the
        // streaming state. Anything mid-OTA (CONN_STATE_BODY) or
        // mid-header (CONN_STATE_HEADER) is intentionally left alone.
        if (conn && conn->state != CONN_STATE_STREAMING) continue;
        // Detach all callbacks BEFORE tcp_abort. lwIP fires the err
        // callback synchronously from inside tcp_abort, and we want
        // it to no-op since we're freeing the conn ourselves below.
        tcp_arg (pcb, NULL);
        tcp_recv(pcb, NULL);
        tcp_err (pcb, NULL);
        tcp_poll(pcb, NULL, 0);
        tcp_abort(pcb);
        if (conn) free(conn);
        stream_registry[i].pcb  = NULL;
        stream_registry[i].conn = NULL;
        aborted++;
    }
    if (aborted > 0) {
        printf("[http] link-down: aborted %d stream PCB%s\n",
               aborted, aborted == 1 ? "" : "s");
    }
}

static void conn_close(struct tcp_pcb *pcb, http_conn_t *conn) {
    unregister_streaming(pcb, conn);
    if (conn) {
        // If OTA was started but connection dropped, abort it
        if (conn->state == CONN_STATE_BODY && ota_in_progress()) {
            ota_abort();
        }
        free(conn);
    }
    tcp_arg(pcb, NULL);
    tcp_recv(pcb, NULL);
    tcp_err(pcb, NULL);
    tcp_poll(pcb, NULL, 0);  // clears any /api/log long-poll callback
    tcp_close(pcb);
}

// Periodic callback for /api/log long-poll waiters and stream pushers.
// Fires every ~500ms (lwIP TCP coarse timer). Runs on the same tcpip thread
// as http_recv, so accessing conn/pcb without extra locking is safe.
//
//   WAITING:   new bytes OR deadline → flush response and close.
//   STREAMING: as long as bytes are available AND tcp_sndbuf has room,
//              copy a chunk onto the wire and advance log_since. The
//              connection stays open until the client closes (FIN/RST,
//              detected by http_recv with a NULL pbuf).
static err_t http_poll(void *arg, struct tcp_pcb *pcb) {
    http_conn_t *conn = (http_conn_t *)arg;
    if (!conn) return ERR_OK;

    if (conn->state == CONN_STATE_WAITING) {
        bool has_data = (log_buffer_total_written() != conn->log_since);
        bool timed_out = time_reached(conn->log_deadline);
        if (!has_data && !timed_out) return ERR_OK;
        send_log_response(pcb, conn->log_since);
        conn->state = CONN_STATE_DONE;
        conn_close(pcb, conn);
        return ERR_OK;
    }

    if (conn->state == CONN_STATE_STREAMING) {
        u16_t avail = tcp_sndbuf(pcb);
        if (avail == 0) return ERR_OK;  // wait for ACK; retry next poll
        uint32_t total = conn->data_stream
            ? data_buffer_total_written()
            : log_buffer_total_written();
        bool have_real_data = (total != conn->log_since);
        if (have_real_data) {
            // Sized to absorb a full slow-timer tick of telemetry at 40 KB/s
            // (4 KB per 100 ms) with comfortable headroom for ACK/window
            // dynamics. Smaller buffers force the data ring to backlog and
            // eventually overflow → dropped samples → browser sees voids.
            static uint8_t out[8192];
            size_t cap = (avail < sizeof(out)) ? avail : sizeof(out);
            uint32_t next = conn->log_since;
            size_t n = conn->data_stream
                ? data_buffer_read(conn->log_since, out, cap, &next)
                : log_buffer_read(conn->log_since, out, cap, &next);
            // Always advance log_since to whatever the ring reader resolved
            // to — even on n==0. If conn->log_since was past total (stale
            // browser cursor across a reboot), data_buffer_read clamped its
            // local since to total and returned 0; without writing back, we'd
            // spin here until total caught up to the stale value (~10 minutes
            // at 250 Hz). Pair with the entry-side clamp in handle_data /
            // handle_log so the very first poll already starts at a sane cursor.
            conn->log_since = next;
            if (n == 0) return ERR_OK;
            // Known cosmetic glitch on cable-cycle boundary: ~once per cable
            // cycle the browser receives one log line whose first ~12 bytes
            // are the *previous* line's prefix bytes prepended to the new
            // line, e.g. "[702317801]\t02846190]\ttick=663000…" instead of
            // "[702846190]\ttick=663000…". The duplicated chunk is exactly
            // one prefix-length, suggesting an lwIP TCP segment-pool / pcb-
            // reuse race around abort/reconnect that re-emits the tail of a
            // prior tcp_write. log_since arithmetic on our side is correct
            // (advance-before-write here only causes gaps on ERR_MEM, never
            // duplicates). Proving the lwIP cause needs a wire capture across
            // many cycles; for now we suppress the visible artifact in the
            // browser via a renderer guard in web/console.js (strips a stray
            // "<digits>]\t" tail from the parsed msg). Revisit if the
            // duplication ever exceeds one prefix length.
            err_t e = tcp_write(pcb, out, n, TCP_WRITE_FLAG_COPY);
            if (e == ERR_MEM) return ERR_OK;  // sndbuf race — retry next poll
            if (e != ERR_OK) {
                conn->state = CONN_STATE_DONE;
                conn_close(pcb, conn);
                return ERR_OK;
            }
            tcp_output(pcb);
            conn->last_tx_at = get_absolute_time();
            return ERR_OK;
        }

        // No real data. Emit a tiny keepalive when the connection has
        // been silent for STREAM_KEEPALIVE_MS so the browser stall
        // watchdog (1 s) sees bytes from a quiet-but-healthy device.
        // For data streams: a 16-byte zero-payload record with a
        // reserved msg_id (CONDUIT_DATA_KEEPALIVE_MSG_ID) — the browser
        // parser skips it before chart/store push.
        // For log streams: a single newline — browser drops empty
        // lines at the top of processLine().
        #define STREAM_KEEPALIVE_MS  500
        if (!time_reached(delayed_by_ms(conn->last_tx_at, STREAM_KEEPALIVE_MS))) {
            return ERR_OK;
        }
        if (conn->data_stream) {
            if (avail < CONDUIT_DATA_RECORD_HEADER) return ERR_OK;
            uint8_t hdr[CONDUIT_DATA_RECORD_HEADER];
            hdr[0] = CONDUIT_DATA_MAGIC;
            hdr[1] = CONDUIT_DATA_VERSION;
            hdr[2] = (uint8_t)(CONDUIT_DATA_KEEPALIVE_MSG_ID & 0xFF);
            hdr[3] = (uint8_t)((CONDUIT_DATA_KEEPALIVE_MSG_ID >> 8) & 0xFF);
            hdr[4] = (uint8_t)CONDUIT_DTYPE_U8;
            hdr[5] = 0; hdr[6] = 0;       // n = 0 (LE u16)
            hdr[7] = 0;                   // reserved
            uint64_t now_us = (uint64_t)to_us_since_boot(get_absolute_time());
            for (int i = 0; i < 8; i++) hdr[8 + i] = (uint8_t)(now_us >> (8 * i));
            err_t e = tcp_write(pcb, hdr, sizeof(hdr), TCP_WRITE_FLAG_COPY);
            if (e == ERR_MEM) return ERR_OK;
            if (e != ERR_OK) {
                conn->state = CONN_STATE_DONE;
                conn_close(pcb, conn);
                return ERR_OK;
            }
        } else {
            if (avail < 1) return ERR_OK;
            const char nl = '\n';
            err_t e = tcp_write(pcb, &nl, 1, TCP_WRITE_FLAG_COPY);
            if (e == ERR_MEM) return ERR_OK;
            if (e != ERR_OK) {
                conn->state = CONN_STATE_DONE;
                conn_close(pcb, conn);
                return ERR_OK;
            }
        }
        tcp_output(pcb);
        conn->last_tx_at = get_absolute_time();
    }
    return ERR_OK;
}

static err_t http_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err) {
    http_conn_t *conn = (http_conn_t *)arg;

    if (!p || err != ERR_OK) {
        // Connection closed by client
        conn_close(pcb, conn);
        return ERR_OK;
    }

    tcp_recved(pcb, p->tot_len);

    if (conn->state == CONN_STATE_DONE
        || conn->state == CONN_STATE_WAITING
        || conn->state == CONN_STATE_STREAMING) {
        // DONE: response already sent, just waiting for FIN.
        // WAITING / STREAMING: /api/log connections are server-driven;
        // discard any extra bytes the client pushes (no pipelined requests).
        pbuf_free(p);
        return ERR_OK;
    }

    // Process data from all pbufs in the chain
    for (struct pbuf *q = p; q != NULL; q = q->next) {
        uint8_t *data = (uint8_t *)q->payload;
        uint16_t len = q->len;

        if (conn->state == CONN_STATE_HEADER) {
            // Accumulate headers
            uint16_t space = HTTP_MAX_HEADER - conn->header_len - 1;
            uint16_t copy = (len < space) ? len : space;
            memcpy(conn->header_buf + conn->header_len, data, copy);
            conn->header_len += copy;
            conn->header_buf[conn->header_len] = '\0';

            // Check for end of headers
            char *hdr_end = strstr(conn->header_buf, "\r\n\r\n");
            if (hdr_end) {
                conn->headers_complete = true;
                parse_request_line(conn);

                // Calculate any body data that arrived with the headers
                uint32_t header_total = (hdr_end - conn->header_buf) + 4;
                uint32_t body_in_header = conn->header_len - header_total;

                // Handle the request
                if (conn->method == METHOD_OPTIONS) {
                    send_cors_preflight(pcb);
                    conn->state = CONN_STATE_DONE;
                } else if (conn->method == METHOD_GET && conn->route == ROUTE_STATUS) {
                    handle_status(pcb);
                    conn->state = CONN_STATE_DONE;
                } else if (conn->method == METHOD_POST && conn->route == ROUTE_UPLOAD) {
                    handle_upload_begin(pcb, conn);
                    // If still in BODY state, feed leftover data
                    if (conn->state == CONN_STATE_BODY && body_in_header > 0) {
                        handle_upload_data(pcb, conn,
                            (uint8_t *)(hdr_end + 4), body_in_header);
                    }
                } else if (conn->method == METHOD_POST && conn->route == ROUTE_REBOOT) {
                    handle_reboot(pcb, conn);
                } else if (conn->method == METHOD_POST && conn->route == ROUTE_COMMIT) {
                    handle_commit(pcb, conn);
                } else if (conn->method == METHOD_GET && conn->route == ROUTE_LOG) {
                    // handle_log sets state to WAITING (long-poll parked) or
                    // DONE (immediate response) — don't force either here.
                    handle_log(pcb, conn);
                } else if (conn->method == METHOD_GET && conn->route == ROUTE_DATA) {
                    // handle_data may go to STREAMING or DONE.
                    handle_data(pcb, conn);
                } else if (conn->method == METHOD_GET && conn->route == ROUTE_DATA_SCHEMA) {
                    handle_data_schema(pcb, conn);
                } else if (conn->method == METHOD_POST && conn->route == ROUTE_CMD) {
                    handle_cmd(pcb, conn);
                } else {
                    send_error(pcb, "404 Not Found", "not found");
                    conn->state = CONN_STATE_DONE;
                }
            }
        } else if (conn->state == CONN_STATE_BODY) {
            // Streaming body data to OTA engine
            handle_upload_data(pcb, conn, data, len);
        }
    }

    pbuf_free(p);

    if (conn->state == CONN_STATE_DONE) {
        conn_close(pcb, conn);
    }

    return ERR_OK;
}

static void http_err(void *arg, err_t err) {
    http_conn_t *conn = (http_conn_t *)arg;
    // lwIP has already freed the pcb by the time err fires, so we can
    // only match the registry entry by conn pointer.
    unregister_streaming(NULL, conn);
    if (conn) {
        if (ota_in_progress()) {
            ota_abort();
        }
        free(conn);
    }
}

static err_t http_accept(void *arg, struct tcp_pcb *pcb, err_t err) {
    g_accepts_total++;
    if (err != ERR_OK || pcb == NULL) {
        return ERR_VAL;
    }

    // Allocate connection state
    http_conn_t *conn = calloc(1, sizeof(http_conn_t));
    if (!conn) {
        tcp_abort(pcb);
        return ERR_MEM;
    }

    conn->state = CONN_STATE_HEADER;

    tcp_arg(pcb, conn);
    tcp_recv(pcb, http_recv);
    tcp_err(pcb, http_err);

    // Lower priority so network stack stays responsive
    tcp_setprio(pcb, TCP_PRIO_MIN);

    return ERR_OK;
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

void http_server_init(void) {
    struct tcp_pcb *pcb = tcp_new();
    if (!pcb) {
        printf("[http] Failed to create PCB\n");
        return;
    }

    err_t err = tcp_bind(pcb, IP_ADDR_ANY, CONDUIT_HTTP_PORT);
    if (err != ERR_OK) {
        printf("[http] Bind failed: %d\n", err);
        return;
    }

    pcb = tcp_listen(pcb);
    if (!pcb) {
        printf("[http] Listen failed\n");
        return;
    }

    tcp_accept(pcb, http_accept);

    printf("[http] Server listening on port %d\n", CONDUIT_HTTP_PORT);
}
