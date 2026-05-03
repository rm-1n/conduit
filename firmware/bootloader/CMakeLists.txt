cmake_minimum_required(VERSION 3.13)

# This directory still owns partitions.json, which defines the A/B layout
# used by both the app and the provisioning flow. The custom bootloader
# target below is kept for reference / future use — it is not part of the
# normal boot path. ROM-native A/B booting is driven by the app's own
# embedded PT (see ../app/CMakeLists.txt) and a singleton partition-table
# image flashed once at provision time (see the partition_table_uf2 target).

add_executable(conduit_bootloader
    main.c
)

target_link_libraries(conduit_bootloader
    pico_stdlib
)

pico_enable_stdio_usb(conduit_bootloader 0)
pico_enable_stdio_uart(conduit_bootloader 0)

pico_embed_pt_in_binary(conduit_bootloader ${CMAKE_CURRENT_LIST_DIR}/partitions.json)

if(EXISTS "${CMAKE_SOURCE_DIR}/keys/private.pem")
    pico_sign_binary(conduit_bootloader ${CMAKE_SOURCE_DIR}/keys/private.pem)
endif()
pico_hash_binary(conduit_bootloader)

pico_set_uf2_family(conduit_bootloader "absolute")
pico_package_uf2_output(conduit_bootloader)

pico_add_extra_outputs(conduit_bootloader)

# --- Singleton partition-table UF2 (primary boot-path artifact) -------------
# Flashed once during provisioning to register the A/B layout on a blank
# device. 512 bytes; lives in the first flash sector; contains no executable
# code. After flashing + reboot-to-BOOTSEL, the RP2350 bootrom recognises the
# layout and `picotool load -p 0 ...` can target partition A.
set(PARTITION_TABLE_UF2 ${CMAKE_CURRENT_BINARY_DIR}/partition_table.uf2)
add_custom_command(
    OUTPUT ${PARTITION_TABLE_UF2}
    COMMAND picotool partition create --quiet
            ${CMAKE_CURRENT_LIST_DIR}/partitions.json
            ${PARTITION_TABLE_UF2}
            --singleton
    DEPENDS ${CMAKE_CURRENT_LIST_DIR}/partitions.json
    VERBATIM
)
add_custom_target(partition_table_uf2 ALL DEPENDS ${PARTITION_TABLE_UF2})
