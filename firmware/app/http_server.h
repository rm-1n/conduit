#ifndef HTTP_SERVER_H
#define HTTP_SERVER_H

#include <stdint.h>

// Initialize the raw TCP HTTP server on CONDUIT_HTTP_PORT
void http_server_init(void);

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

#endif // HTTP_SERVER_H
