#!/usr/bin/env bash
# Build CONDUIT firmware (bootloader + app)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIRMWARE_DIR="$SCRIPT_DIR/.."
BUILD_DIR="$FIRMWARE_DIR/build"

# Check for Pico SDK
if [ -z "${PICO_SDK_PATH:-}" ]; then
    echo "Error: PICO_SDK_PATH environment variable not set."
    echo "Set it to the path of your pico-sdk installation."
    exit 1
fi

echo "PICO_SDK_PATH: $PICO_SDK_PATH"

# Configure
echo "=== Configuring ==="
cmake -B "$BUILD_DIR" -S "$FIRMWARE_DIR" \
    -DPICO_BOARD=pico2

# Build
echo "=== Building ==="
cmake --build "$BUILD_DIR" -j "$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

echo ""
echo "=== Build complete ==="
echo "Bootloader: $BUILD_DIR/bootloader/conduit_bootloader.uf2"
echo "App:        $BUILD_DIR/app/conduit_app.uf2"
echo ""
echo "Flash order:"
echo "  1. Hold BOOTSEL, connect USB, release → drag bootloader UF2"
echo "  2. Use picotool or web OTA to flash app UF2"
