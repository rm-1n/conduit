#!/usr/bin/env bash
# stream_reconnect_test.sh — verify that a long-lived HTTPS stream
# auto-recovers across an OTA upload.
#
# The IDE's new "streams stay open during OTA" architecture is
# load-bearing for the post-upload UX: telemetry must come back the
# instant the device reboots, with no /api/status polling and no
# manual resume. The 10-cycle stress in https_stress_loop.sh only
# exercises the OTA path; it does NOT verify that an alive stream
# survives a reboot. This test fills that gap.
#
# Setup:
#   1. Start a curl that long-polls /api/data?stream=1 over HTTPS,
#      writing bytes to a log file as they arrive.
#   2. Capture the curl's PID and timestamp of last data.
#   3. Trigger an OTA upload (HTTPS).
#   4. After the upload completes + device reboots, watch the log file
#      for fresh bytes appearing.
#   5. Measure time between "device-back-via-status-poll" and "first
#      fresh stream byte".
#
# Pass criteria: stream sees a fresh byte within RECONNECT_BUDGET_S of
# the first successful /api/status post-reboot. Fail if the budget is
# exceeded — that means the auto-reconnect path is broken.
#
# Usage:
#   firmware/scripts/stream_reconnect_test.sh
#
# Env vars (defaults shown):
#   DEVICE=192.168.178.200
#   BOARD=29166ac0e5917701
#   UF2=firmware/build/app/conduit_app.uf2
#   TOKEN=changeme
#   RECONNECT_BUDGET_S=10

set -u

DEVICE=${DEVICE:-192.168.178.200}
BOARD=${BOARD:-29166ac0e5917701}
DASHIP=$(echo "$DEVICE" | tr . -)
HOST="$DASHIP.$BOARD.devices.rm1n.com"
URL_BASE="https://$HOST"
UF2=${UF2:-/Users/rm1n/Documents/_rm1n/STORE/CONDUIT/conduit/firmware/build/app/conduit_app.uf2}
TOKEN=${TOKEN:-changeme}
RECONNECT_BUDGET_S=${RECONNECT_BUDGET_S:-10}

STREAM_LOG=$(mktemp -t stream-tail.XXXXXX)
trap 'rm -f "$STREAM_LOG"; [ -n "${STREAM_PID:-}" ] && kill "$STREAM_PID" 2>/dev/null || true' EXIT

stat_size() {
    if stat -f%z "$1" >/dev/null 2>&1; then
        stat -f%z "$1"
    else
        stat -c%s "$1"
    fi
}

echo "== pre-state =="
curl -sS --max-time 5 "$URL_BASE/api/status" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(f"   partition={d[\"partition\"]} bin={d[\"binary_version\"]} uptime={d[\"uptime\"]}s")'

echo "== opening long-lived /api/data stream =="
# `-N` disables buffering so we see bytes immediately as the device
# emits them.
curl -sS -N --max-time 600 "$URL_BASE/api/data?stream=1" >"$STREAM_LOG" 2>/dev/null &
STREAM_PID=$!
echo "   stream pid=$STREAM_PID, logging to $STREAM_LOG"

# Wait until the stream produces SOMETHING (the firmware emits a
# keepalive record every ~500 ms even when the data ring is otherwise
# idle, so the first byte should arrive within a few seconds).
for ((i=1; i<=20; i++)); do
    sz=$(stat_size "$STREAM_LOG")
    if [ "$sz" -gt 0 ]; then
        echo "   first bytes after ${i}× 0.5s, size=${sz}"
        break
    fi
    sleep 0.5
done
PRE_SIZE=$(stat_size "$STREAM_LOG")
if [ "$PRE_SIZE" -eq 0 ]; then
    echo "FAIL: stream never produced bytes before OTA. Is the device alive on HTTPS?"
    exit 1
fi

echo "== triggering OTA =="
T_UPLOAD_START=$(date +%s.%N)
UP_CODE=$(curl -sS --max-time 180 -o /tmp/upload-resp -w "%{http_code}" \
    -H "X-Auth-Token: $TOKEN" \
    -H "Content-Type: application/octet-stream" \
    -H "X-OTA-Start: 1" \
    -H "X-OTA-Finish: 1" \
    --data-binary "@$UF2" \
    "$URL_BASE/api/upload" 2>&1)
T_UPLOAD_END=$(date +%s.%N)
UPLOAD_DT=$(python3 -c "print(round($T_UPLOAD_END - $T_UPLOAD_START, 2))")
echo "   upload finished: code=$UP_CODE, elapsed=${UPLOAD_DT}s"

# Capture the stream's size at the moment the upload ended — anything
# arriving after this is post-reboot recovery data.
BASELINE_SIZE=$(stat_size "$STREAM_LOG")
echo "   stream size at upload-end: ${BASELINE_SIZE} bytes"

echo "== waiting for device-back via /api/status (HTTPS) =="
T_REBOOT_DETECT=""
for ((i=1; i<=30; i++)); do
    S=$(curl -sS --max-time 4 "$URL_BASE/api/status" 2>/dev/null)
    if echo "$S" | grep -q '"binary_version"'; then
        T_REBOOT_DETECT=$(date +%s.%N)
        UPT=$(echo "$S" | python3 -c 'import sys,json; print(json.load(sys.stdin)["uptime"])')
        echo "   device back at poll $i, uptime=${UPT}s"
        break
    fi
    sleep 1
done
if [ -z "$T_REBOOT_DETECT" ]; then
    echo "FAIL: device did not respond on HTTPS after upload"
    exit 1
fi

echo "== watching stream for post-reboot bytes (budget=${RECONNECT_BUDGET_S}s) =="
# Now wait for the stream to produce bytes BEYOND BASELINE_SIZE — that
# is the post-reboot recovery signal we care about.
T_DEADLINE=$(python3 -c "print(round($T_REBOOT_DETECT + $RECONNECT_BUDGET_S, 3))")
T_STREAM_BACK=""
while :; do
    NOW=$(date +%s.%N)
    CUR_SIZE=$(stat_size "$STREAM_LOG")
    if [ "$CUR_SIZE" -gt "$BASELINE_SIZE" ]; then
        T_STREAM_BACK=$NOW
        GROWTH=$(( CUR_SIZE - BASELINE_SIZE ))
        echo "   stream produced $GROWTH new bytes"
        break
    fi
    if python3 -c "import sys; sys.exit(0 if $NOW > $T_DEADLINE else 1)"; then
        break
    fi
    sleep 0.2
done

if [ -z "$T_STREAM_BACK" ]; then
    echo "FAIL: stream did not produce post-reboot bytes within ${RECONNECT_BUDGET_S}s of device-back"
    echo "   This is the regression: the stream's auto-reconnect path is not firing."
    echo "   Tail of stream log:"
    tail -c 200 "$STREAM_LOG" | od -c | tail -5
    exit 1
fi

RECOVERY_DT=$(python3 -c "print(round($T_STREAM_BACK - $T_REBOOT_DETECT, 2))")
echo
echo "PASS: stream reconnected in ${RECOVERY_DT}s after device-back (budget=${RECONNECT_BUDGET_S}s)"

# Final commit so the device doesn't roll back
curl -sS --max-time 10 -X POST -H "X-Auth-Token: $TOKEN" "$URL_BASE/api/commit" >/dev/null
