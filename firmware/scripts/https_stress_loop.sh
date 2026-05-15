#!/usr/bin/env bash
# 10-cycle HTTPS OTA stress loop. Hits the device via the wildcard
# hostname (real DNS + real cert) so every cycle exercises the full
# mbedtls path, including the slab allocator for the 16 KB IN + 8 KB
# OUT buffers. Prints unbuffered so failures are visible live.

set -u

DEVICE=${DEVICE:-192.168.178.200}
BOARD=${BOARD:-29166ac0e5917701}
DASHIP=$(echo "$DEVICE" | tr . -)
HOST="$DASHIP.$BOARD.devices.rm1n.com"
URL_BASE="https://$HOST"
UF2=${UF2:-/Users/rm1n/Documents/_rm1n/STORE/CONDUIT/conduit/firmware/build/app/conduit_app.uf2}
CYCLES=${CYCLES:-10}
TOKEN=${TOKEN:-changeme}

extract_field() {
    local field=$1
    python3 -c "import sys,json; print(json.load(sys.stdin).get(\"$field\", \"-\"))"
}

echo "Pre-state:"
PRE=$(curl -sS --max-time 5 "$URL_BASE/api/status")
echo "  partition=$(echo "$PRE" | extract_field partition) bin=$(echo "$PRE" | extract_field binary_version) uptime=$(echo "$PRE" | extract_field uptime)s"

for ((i=1; i<=CYCLES; i++)); do
    echo "===== Cycle $i ====="
    T0=$(date +%s)
    PRE=$(curl -sS --max-time 5 "$URL_BASE/api/status" 2>/dev/null)
    PRE_PART=$(echo "$PRE" | extract_field partition 2>/dev/null || echo '-')
    PRE_UPT=$(echo "$PRE"  | extract_field uptime    2>/dev/null || echo '-')
    echo "  pre: partition=$PRE_PART uptime=${PRE_UPT}s"

    UP_CODE=$(curl -sS --max-time 180 -o /tmp/upload-resp -w "%{http_code}" \
        -H "X-Auth-Token: $TOKEN" \
        -H "Content-Type: application/octet-stream" \
        -H "X-OTA-Start: 1" \
        -H "X-OTA-Finish: 1" \
        --data-binary "@$UF2" \
        "$URL_BASE/api/upload" 2>&1)
    echo "  upload http_code=$UP_CODE  body=$(head -c 100 /tmp/upload-resp 2>/dev/null)"

    # Poll device back over HTTPS — 30 polls × 2s
    POLLED=0
    DEVICE_BACK=""
    sleep 2
    for ((j=1; j<=30; j++)); do
        S=$(curl -sS --max-time 4 "$URL_BASE/api/status" 2>/dev/null)
        if echo "$S" | grep -q '"binary_version"'; then
            NP=$(echo "$S" | extract_field partition)
            NUPT=$(echo "$S" | extract_field uptime)
            DEVICE_BACK="partition=$NP uptime=${NUPT}s after_polls=$j"
            POLLED=$j
            break
        fi
        sleep 2
    done

    if [ -z "$DEVICE_BACK" ]; then
        echo "  ! WEDGED — device did not respond after 60 s of HTTPS polling"
        echo "  ! Trying plain HTTP to see if device is alive at all:"
        curl -sS --max-time 4 "http://$DEVICE/api/status" 2>&1 | head -c 200
        echo
        T1=$(date +%s)
        echo "  elapsed: $((T1-T0))s"
        echo "===== STOPPING at cycle $i (wedge) ====="
        exit 1
    fi
    echo "  device back: $DEVICE_BACK"

    COMMIT=$(curl -sS --max-time 10 -X POST \
        -H "X-Auth-Token: $TOKEN" \
        "$URL_BASE/api/commit" 2>&1)
    echo "  commit: $COMMIT"

    T1=$(date +%s)
    echo "  elapsed: $((T1-T0))s"
done

echo "===== All $CYCLES cycles passed ====="
