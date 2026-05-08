// dev_log.h — opt-in firmware-side diagnostic prints over USB CDC.
//
// Production builds should be quiet on USB serial: end users plug a
// device in, the IDE talks to it over the network, and they don't
// want a stream of `[net] link up` / `[discovery] first send ok` /
// `[health] link transition` chatter every time they open
// `conduit serial` or any other CDC consumer.
//
// `DEV_LOG(fmt, ...)` replaces the bare `printf(...)` calls
// scattered through `firmware/app/`. By default it expands to
// `((void)0)`, so no string literal makes it into the binary and
// no USB writes happen.
//
// Two opt-ins re-enable the prints:
//   CONDUIT_DEV_LOGS — set explicitly via `conduit flash --dev` /
//                      `conduit build --dev` (or `cmake -DCONDUIT_DEV_LOGS=ON`).
//                      This is the developer-debug build flavour.
//   CONDUIT_MINIMAL  — the diagnostic-only firmware target whose
//                      whole purpose is to print over CDC. It would
//                      defeat the point to silence those, so we
//                      auto-enable DEV_LOG when this is set.
//
// User code's `log()` (alias for `conduit_log()` from
// `firmware/include/conduit_user.h`) is a SEPARATE channel that
// writes to the in-firmware log_buffer ring and is exposed via
// `/api/log`. Those calls are visible in the IDE's runtime console
// regardless of CDC printing — production users see what their own
// code logged, just not the firmware's internal status chatter.

#ifndef CONDUIT_DEV_LOG_H
#define CONDUIT_DEV_LOG_H

#if defined(CONDUIT_DEV_LOGS) || defined(CONDUIT_MINIMAL)
#include <stdio.h>
#define DEV_LOG(fmt, ...) printf(fmt, ##__VA_ARGS__)
#else
// Cast-to-void so the macro is an expression-statement and a stray
// `if (cond) DEV_LOG(...);` without braces still typechecks.
#define DEV_LOG(fmt, ...) ((void)0)
#endif

#endif // CONDUIT_DEV_LOG_H
