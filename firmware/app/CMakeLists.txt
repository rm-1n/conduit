cmake_minimum_required(VERSION 3.13)

set(LWIP_PATH "${PICO_SDK_PATH}/lib/lwip")
set(RMII_LIB_DIR "${CMAKE_SOURCE_DIR}/lib/pico-rmii-ethernet_nce")

# ---- lwIP library (from SDK) ----
add_library(pico_poe_lwip INTERFACE)

target_sources(pico_poe_lwip INTERFACE
    ${LWIP_PATH}/src/core/altcp.c
    ${LWIP_PATH}/src/core/altcp_alloc.c
    ${LWIP_PATH}/src/core/altcp_tcp.c
    ${LWIP_PATH}/src/core/def.c
    ${LWIP_PATH}/src/core/dns.c
    ${LWIP_PATH}/src/core/inet_chksum.c
    ${LWIP_PATH}/src/core/init.c
    ${LWIP_PATH}/src/core/ip.c
    ${LWIP_PATH}/src/core/mem.c
    ${LWIP_PATH}/src/core/memp.c
    ${LWIP_PATH}/src/core/netif.c
    ${LWIP_PATH}/src/core/pbuf.c
    ${LWIP_PATH}/src/core/raw.c
    ${LWIP_PATH}/src/core/stats.c
    ${LWIP_PATH}/src/core/sys.c
    ${LWIP_PATH}/src/core/tcp.c
    ${LWIP_PATH}/src/core/tcp_in.c
    ${LWIP_PATH}/src/core/tcp_out.c
    ${LWIP_PATH}/src/core/timeouts.c
    ${LWIP_PATH}/src/core/udp.c
    ${LWIP_PATH}/src/core/ipv4/autoip.c
    ${LWIP_PATH}/src/core/ipv4/dhcp.c
    ${LWIP_PATH}/src/core/ipv4/etharp.c
    ${LWIP_PATH}/src/core/ipv4/icmp.c
    ${LWIP_PATH}/src/core/ipv4/igmp.c
    ${LWIP_PATH}/src/core/ipv4/ip4.c
    ${LWIP_PATH}/src/core/ipv4/ip4_addr.c
    ${LWIP_PATH}/src/core/ipv4/ip4_frag.c
    ${LWIP_PATH}/src/core/ipv4/acd.c
    ${LWIP_PATH}/src/netif/ethernet.c
    # sys_arch from the RMII library
    ${RMII_LIB_DIR}/src/lwip/sys_arch.c
)

target_include_directories(pico_poe_lwip INTERFACE
    ${LWIP_PATH}/src/include
    # Our lwipopts.h takes precedence (searched first)
    ${CMAKE_CURRENT_LIST_DIR}
    # Fall through to RMII lib for arch/cc.h
    ${RMII_LIB_DIR}/src/lwip
)

# ---- RMII Ethernet driver ----
add_library(pico_poe_rmii INTERFACE)

target_sources(pico_poe_rmii INTERFACE
    ${RMII_LIB_DIR}/src/rmii_ethernet.c
)

target_include_directories(pico_poe_rmii INTERFACE
    ${RMII_LIB_DIR}/src/include
)

# Generate PIO headers from our PATCHED .pio files (not the submodule originals)
pico_generate_pio_header(pico_poe_rmii ${CMAKE_CURRENT_LIST_DIR}/pio/rmii_ethernet_phy_rx.pio)
pico_generate_pio_header(pico_poe_rmii ${CMAKE_CURRENT_LIST_DIR}/pio/rmii_ethernet_phy_tx.pio)

target_link_libraries(pico_poe_rmii INTERFACE
    hardware_pio
    hardware_dma
    hardware_pwm
    pico_stdlib
    pico_unique_id
    pico_poe_lwip
)

# ---- Rollback sanity knob ---------------------------------------------------
# `cmake -B build -DPICO_POE_SIMULATE_HANG=ON` hangs the app right after
# init; combined with the watchdog + TBYB this drives the ROM-level
# rollback path so we can verify it works end-to-end.
option(PICO_POE_SIMULATE_HANG "Hang after init to exercise the TBYB watchdog rollback" OFF)

# ---- App executable helper --------------------------------------------------
#
# The app ships as two UF2s built from the same source:
#
#   pico_poe_app.uf2          - TBYB-flagged. The RP2350 bootrom boots it only
#                               after a flash-update reboot. Intended for OTA
#                               updates where rom_explicit_buy / rollback
#                               semantics apply.
#
#   pico_poe_app_initial.uf2  - No TBYB flag. Boots on any plain power-on.
#                               Used for the first install via BOOTSEL
#                               (`pico-poe provision`) — subsequent updates go
#                               through the TBYB build.
#
# Both binaries are otherwise identical (same partition table, version, and
# signing/hashing) so they round-trip cleanly through the A/B selector.

function(pico_poe_define_app TARGET)
    set(options TBYB)
    cmake_parse_arguments(APP "${options}" "" "" ${ARGN})

    add_executable(${TARGET}
        main.c
        network.c
        http_server.c
        ota.c
        log_buffer.c
        data_buffer.c
        commands.c
        diag.c
    )

    target_include_directories(${TARGET} PRIVATE
        ${CMAKE_CURRENT_LIST_DIR}
        ${CMAKE_SOURCE_DIR}/include
    )

    # We export a printf-style log() helper (see log_buffer.h). The C
    # standard library also declares double log(double) in <math.h>, which
    # clang treats as a builtin and warns about the signature mismatch.
    # Our log() is never called in a math-library context, so silence the
    # warning project-wide.
    target_compile_options(${TARGET} PRIVATE -fno-builtin-log)

    if(APP_TBYB)
        target_compile_definitions(${TARGET} PRIVATE PICO_CRT0_IMAGE_TYPE_TBYB=1)
    endif()
    if(PICO_POE_SIMULATE_HANG)
        target_compile_definitions(${TARGET} PRIVATE PICO_POE_SIMULATE_HANG=1)
    endif()

    target_link_libraries(${TARGET}
        pico_stdlib
        pico_multicore
        pico_unique_id
        pico_flash
        hardware_flash
        hardware_sync
        hardware_watchdog
        hardware_gpio
        hardware_adc
        pico_poe_rmii
    )

    # Console output via USB
    pico_enable_stdio_usb(${TARGET} 1)
    pico_enable_stdio_uart(${TARGET} 0)

    # Binary version for A/B partition selection — bump MINOR per OTA test
    # cycle. The RP2350 bootrom compares versions across partitions and
    # boots the newer.
    pico_set_binary_version(${TARGET} MAJOR 1 MINOR 25)

    # Embed the A/B partition table so the bootrom can discover the layout
    # and pick between A and B based on binary version.
    pico_embed_pt_in_binary(${TARGET} ${CMAKE_SOURCE_DIR}/bootloader/partitions.json)

    # Signing requires a private key and stays gated. Hash runs
    # unconditionally (after signing, if present) so rom_chain_image has an
    # integrity block to verify when no key is configured.
    if(EXISTS "${CMAKE_SOURCE_DIR}/keys/private.pem")
        pico_sign_binary(${TARGET} ${CMAKE_SOURCE_DIR}/keys/private.pem)
    endif()
    pico_hash_binary(${TARGET})

    # UF2 family for A/B partitioned app
    pico_set_uf2_family(${TARGET} "rp2350-arm-s")
    pico_package_uf2_output(${TARGET})

    pico_add_extra_outputs(${TARGET})
endfunction()

# The two variants. Both always build; the first-install UF2 is small
# enough that the extra link time is negligible.
pico_poe_define_app(pico_poe_app         TBYB)
pico_poe_define_app(pico_poe_app_initial)
