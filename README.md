# CONDUIT

Open-hardware RP2350 / Pico2 board with Power-over-Ethernet, an RMII PHY, and a browser-based development workflow.
The repo holds the KiCad project (`hardware/`), the firmware with A/B-partitioned OTA + a tiny HTTP API (`firmware/`), the `conduit` Python CLI for build / flash / OTA / commanding (`tools/conduit/`), and a static web IDE that compiles user C in the browser via WASM clang+lld and pushes it over the network (`web/`).

## First-time setup

1. **First flash (USB).** Hold `BOOTSEL` while plugging the board into USB — it enumerates as the `RPI-RP2350` mass-storage drive. Download the [latest commissioning image](https://github.com/rm-1n/conduit/releases/latest) — currently <!-- factory-uf2-version:start -->`factory-10.2`<!-- factory-uf2-version:end --> — and copy the `.uf2` file onto the drive. The drive disappears, the board reboots running the new firmware. The image is built by `.github/workflows/commissioning-image.yml` and contains the bootloader plus a non-TBYB app concatenated into one UF2.
2. **Power and network.** Connect the board to a PoE-capable switch (or keep it on USB power); it tries DHCP first and falls back to `192.168.178.200/24`.
3. **Iterate.** Open the web IDE in your browser, point it at the device's IP, and from there you write user C, build + OTA over the network, watch live telemetry charts, and send commands to the running firmware — all without leaving the browser.
