cmake_minimum_required(VERSION 3.13)

# Board configuration
set(PICO_BOARD pico2)

# Import the Pico SDK
include(pico_sdk_import.cmake)

project(pico_poe C CXX ASM)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

# Initialize the Pico SDK
pico_sdk_init()

# Build targets
add_subdirectory(bootloader)
add_subdirectory(app)
