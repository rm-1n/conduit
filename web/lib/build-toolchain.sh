#!/usr/bin/env bash
# Build the WASM Clang+LLD bundle for the conduit IDE, natively on macOS.
#
# - Resets the Emception submodule to its pinned state
# - Applies patches/emception-arm-target.patch (adds ARM backend to LLVM)
# - Sources the local emsdk at ~/.emsdk so emcmake / emcc / emcmake are on PATH
# - Prepends GNU sed + coreutils from Homebrew so Emception's Linux-flavored
#   build scripts run unmodified on macOS
# - Runs Emception's ./build.sh directly (no Docker — native arm64 on M1)
# - Copies the resulting runtime into web/assets/emception/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMCEPTION="$SCRIPT_DIR/emception"
PATCH="$SCRIPT_DIR/patches/emception-arm-target.patch"
ASSETS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/assets"
EMSDK="${EMSDK:-$HOME/.emsdk}"

if [ ! -d "$EMCEPTION" ]; then
    echo "error: $EMCEPTION missing. Run: git submodule update --init web/lib/emception"
    exit 1
fi

if [ ! -f "$EMSDK/emsdk_env.sh" ]; then
    echo "error: emsdk not found at $EMSDK"
    echo "Install with: git clone --depth 1 https://github.com/emscripten-core/emsdk ~/.emsdk"
    echo "  then: cd ~/.emsdk && ./emsdk install latest && ./emsdk activate latest"
    exit 1
fi

echo "=== Sourcing emsdk at $EMSDK ==="
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
# Read the first-line emsdk version without letting `head -1` SIGPIPE trip
# `set -euo pipefail`. Use awk NR==1 form which consumes the full input.
EMCC_VERSION="$(emcc -v 2>&1 | awk 'NR==1 { match($0, /[0-9]+(\.[0-9]+)+/); print substr($0, RSTART, RLENGTH) }')"
echo "emcc version: $EMCC_VERSION"
# Emception was tested at emsdk 3.1.24 (clang 16). Newer emsdk (5.x with
# clang 21) fails with -Werror on deprecated JS symbols, ninja patch
# mismatches, and ESM/CJS conflicts. If you get past this guard without
# pinning 3.1.24, be prepared to debug all of those.
case "$EMCC_VERSION" in
    3.1.*) ;;
    *)
        echo "warning: Emception is tested at emsdk 3.1.24; you have $EMCC_VERSION"
        echo "         Expect build failures. Pin with: ~/.emsdk/emsdk activate 3.1.24"
        echo "         Continuing in 5s..."
        sleep 5
        ;;
esac

echo "=== Preferring GNU sed / coreutils from Homebrew ==="
export PATH="/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH"
echo "sed: $(sed --version 2>&1 | head -1)"

# Emception's patch-ninja.sh uses shell regex to parse cmake-generated
# build.ninja and doesn't handle cmake 4.x's output shape — DEFINES values
# end up mangled with "=" stripped from surrounding lines. cmake 3.24 was
# the cmake generation Emception was tested against in 2022.
CMAKE_324="/tmp/cmake-3/cmake-3.24.4-macos-universal/CMake.app/Contents/bin"
if [ -x "$CMAKE_324/cmake" ]; then
    export PATH="$CMAKE_324:$PATH"
    echo "cmake: $(cmake --version | head -1) (pinned to match Emception)"
else
    echo "warning: $CMAKE_324/cmake missing; using system cmake ($(cmake --version | head -1))"
    echo "         Newer cmake may break Emception's patch-ninja.sh regex."
fi

echo "=== Resetting Emception tracked files to submodule HEAD ==="
git -C "$EMCEPTION" reset --hard HEAD

echo "=== Applying ARM-target patch ==="
git -C "$EMCEPTION" apply --ignore-whitespace "$PATCH"
echo '--- patched LLVM_TARGETS_TO_BUILD ---'
grep -n LLVM_TARGETS_TO_BUILD "$EMCEPTION/build-llvm.sh"

echo "=== Running Emception ./build.sh (native arm64, no Docker) ==="
cd "$EMCEPTION"
./build.sh
cd "$SCRIPT_DIR"

OUT="$EMCEPTION/build/emception"
if [ ! -d "$OUT" ]; then
    echo "error: expected build output at $OUT but it's missing"
    exit 1
fi

echo "=== Staging into $ASSETS_DIR/emception ==="
mkdir -p "$ASSETS_DIR"
rm -rf "$ASSETS_DIR/emception"
cp -R "$OUT" "$ASSETS_DIR/emception"

# Also stage the raw llvm-box.wasm next to its .mjs loader. Emception's pack
# pipeline puts it inside packages/wasm.pack.br for lazy browser loading, but
# having the raw file staged makes the Node unit tests (web/tests/*.mjs) work
# without a brotli+tar decoder.
cp "$EMCEPTION/build/llvm/bin/llvm-box.wasm" "$ASSETS_DIR/emception/llvm/llvm-box.wasm"

echo "=== Done ==="
du -sh "$ASSETS_DIR/emception"
echo "compiler.js will now find the runtime at ./assets/emception/"
