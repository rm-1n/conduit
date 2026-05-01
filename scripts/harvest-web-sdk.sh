#!/usr/bin/env bash
# Re-package web/assets/sdk/lib/pico-sdk-objects.tar from the current
# firmware build. Used when the base firmware (main.c, diag.c,
# http_server.c, …) changes and we need the Web IDE's compile path to
# pick up the new symbols without waiting on the
# `.github/workflows/build-web-sdk.yml` artifact release.
#
# Prereq: a fresh `pico-poe build` so firmware/build/app/CMakeFiles/
#         contains the latest .o files.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUILD_DIR="firmware/build/app/CMakeFiles/pico_poe_app.dir"
OUT="web/assets/sdk/lib/pico-sdk-objects.tar"

if [[ ! -d "$BUILD_DIR" ]]; then
  echo "✗ no build dir at $BUILD_DIR — run \`pico-poe build\` first" >&2
  exit 1
fi

# Match the layout the existing tarball uses: paths relative to the
# CMakeFiles/<target>.dir/ root, preserving the ./Users/.../...c.o and
# ./__/lib/.../...c.o sub-trees.
( cd "$BUILD_DIR" && tar -cf "$REPO_ROOT/$OUT" \
    $(find . \( -name "*.c.o" -o -name "*.cpp.o" -o -name "*.S.obj" -o -name "*.S.o" \) | sort) )

echo "✓ wrote $OUT ($(du -sh "$OUT" | awk '{print $1}'), $(tar -tf "$OUT" | wc -l) entries)"
