cmake_minimum_required(VERSION 3.13)

# Board configuration
set(PICO_BOARD pico2)

# Default to size-optimized release. The web IDE's Build & Upload pushes
# the whole conduit_app UF2 (~290 KB at -O3) over OTA on every iteration,
# so -Os shaving ~10-15% directly cuts the user's edit-build-flash cycle.
# Honoured only on the first cmake configure of a build dir; pass
# -DCMAKE_BUILD_TYPE=... explicitly to override.
if (NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE MinSizeRel)
endif()

# LTO was attempted (CMAKE_INTERPROCEDURAL_OPTIMIZATION) but Pico SDK
# 2.2.0's `-specs=nosys.specs` doesn't resolve under the LTO link
# wrapper for our cortex-m33+fp+dsp/softfp multilib (the spec sits at
# the toolchain root, not in the multilib subdir gcc's LTO front-end
# searches). Workarounds (full -specs= path, -lnosys substitution, or
# -B<multilib>) require patching the SDK's own CMake — out of scope
# for now. -Os alone gets ~10% which is the cheap win.

# Import the Pico SDK
include(pico_sdk_import.cmake)

project(conduit C CXX ASM)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

# Initialize the Pico SDK
pico_sdk_init()

# Build targets
add_subdirectory(bootloader)
add_subdirectory(app)
