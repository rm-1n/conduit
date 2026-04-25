#!/usr/bin/env bash
# Stage a pico-sdk-lite bundle for the browser IDE. Harvests pre-compiled
# .o files (from arm-none-eabi-gcc) out of firmware/build/, plus startup
# objects, the preprocessed linker script, and the SDK public headers
# tree. Packages everything under web/assets/sdk/ where compiler.js can
# fetch and mount it into the WASM VFS.
#
# Requires: `firmware/scripts/build.sh` has been run successfully.
# Run from the repo root:  bash web/lib/build-sdk-bundle.sh
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
FIRMWARE_BUILD="$REPO_ROOT/firmware/build"
OUT="$REPO_ROOT/web/assets/sdk"
PICO_SDK_ROOT="${PICO_SDK_PATH:-$HOME/.pico-sdk/sdk/2.2.0}"

[ -d "$FIRMWARE_BUILD/app/CMakeFiles/pico_poe_app.dir" ] || {
    echo "error: firmware/build missing. Run firmware/scripts/build.sh first."
    exit 1
}
[ -d "$PICO_SDK_ROOT/src" ] || {
    echo "error: Pico SDK not found at $PICO_SDK_ROOT"
    exit 1
}

echo "=== Cleaning $OUT ==="
rm -rf "$OUT"
mkdir -p "$OUT"/{lib,startup,linker,headers}

echo "=== Harvesting pico-sdk core .o files ==="
# Keep path structure relative to the CMake .dir root so no name collisions
# between multiple timer.c.o / flash.c.o from different sub-modules.
pushd "$FIRMWARE_BUILD/app/CMakeFiles/pico_poe_app.dir" >/dev/null
find . -name '*.o' \
    -not -name 'main.c.o' \
    -not -name 'network.c.o' \
    -not -name 'http_server.c.o' \
    -not -name 'ota.c.o' \
    -not -path '*/tinyusb/*' \
    -not -path '*/lwip/*' \
    -not -path '*rmii_eth*' \
    -not -path '*/sys_arch*' \
    -not -path '*/rp2040_usb_device*' \
    -not -path '*/pico_stdio_usb/*' \
    -not -path '*/hardware_dma/*' \
    -not -path '*/hardware_pio/*' \
    -not -path '*/pico_multicore/*' \
    -not -path '*/pico_fix/*' \
    -not -path '*/pico_unique_id/*' \
    -not -path '*/hardware_xip_cache/*' \
    -not -path '*/hardware_flash/*' \
  | tar -cf "$OUT/lib/pico-sdk-objects.tar" -T -
popd >/dev/null
# Count + size
TARN=$(tar -tf "$OUT/lib/pico-sdk-objects.tar" | wc -l | tr -d ' ')
TARSZ=$(stat -f '%z' "$OUT/lib/pico-sdk-objects.tar")
echo "  $TARN objects, $(( TARSZ / 1024 )) KB (tarball)"

echo "=== Startup objects ==="
find "$FIRMWARE_BUILD" -name 'bs2_default_padded_checksummed*.o' -maxdepth 6 -exec cp {} "$OUT/startup/" \;
ls -la "$OUT/startup/"

echo "=== Linker script ==="
# Take the post-preprocess .ld if CMake produced one, else the SDK source.
LD_PREPROCESSED=$(find "$FIRMWARE_BUILD" -name 'memmap_default.ld' 2>/dev/null | head -1)
LD_SOURCE="$PICO_SDK_ROOT/src/rp2_common/pico_crt0/rp2350/memmap_default.ld"
cp "${LD_PREPROCESSED:-$LD_SOURCE}" "$OUT/linker/memmap_default.ld"
ls -la "$OUT/linker/"

echo "=== Public headers tree ==="
# The SDK layout is `src/<category>/<module>/include/<path>.h`. For a single
# `-I <dir>` to satisfy `#include "pico/stdlib.h"` etc, flatten all public
# include/ subdirs into one merged tree at $OUT/headers/include/.
mkdir -p "$OUT/headers/include"
find "$PICO_SDK_ROOT/src" -type d -name include | while read -r inc; do
    # Each inc is like .../src/rp2_common/pico_stdlib/include
    rsync -a "$inc/" "$OUT/headers/include/"
done

# Generated config headers from the CMake build (board/platform selection,
# lwip opts, etc). Keep the board_config headers — lots of SDK code needs them.
# rsync preserving directory structure from the build's generated include.
find "$FIRMWARE_BUILD" -type d \( -name 'generated' -o -name 'pico_base' \) | while read -r d; do
    rsync -a "$d/" "$OUT/headers/include/" 2>/dev/null || true
done

# Also ship a bundled firmware app-level pico_poe_config.h style headers dir
# so user code that wants board-specific macros can find them.
if [ -d "$REPO_ROOT/firmware/include" ]; then
    rsync -a "$REPO_ROOT/firmware/include/" "$OUT/headers/include/"
fi

# Boot2 + tinyUSB are absent from this lite bundle; touch stubs so downstream
# #include doesn't explode. Users writing network-heavy code will hit
# missing-symbol errors at link time which is fine — the bundle is sized for
# basic GPIO / stdio demos.

echo "=== Write manifest ==="
cat > "$OUT/manifest.json" <<EOF
{
  "pico_sdk_version": "2.2.0",
  "generator": "firmware/build harvest",
  "pico_board": "pico2",
  "flags": [
    "-target", "thumbv8m.main-none-eabi",
    "-mcpu=cortex-m33",
    "-mthumb",
    "-mfloat-abi=softfp"
  ],
  "linker_script": "/pico-sdk/linker/memmap_default.ld",
  "startup_objects": ["/pico-sdk/startup/bs2_default_padded_checksummed.S.obj"],
  "lib_tarball": "/pico-sdk/lib/pico-sdk-objects.tar",
  "include_root": "/pico-sdk/include",
  "notes": "Harvested from arm-none-eabi-gcc build; lld links GCC-compiled .o files fine. tinyUSB/lwIP excluded — this is a pico-sdk-LITE for GPIO/time/stdio demos."
}
EOF

echo
echo "=== staged ==="
du -sh "$OUT"/*
echo
echo "Total: $(du -sh "$OUT" | awk '{print $1}')"
echo "compiler.js can fetch from $OUT/ at ./assets/sdk/"
