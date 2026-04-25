# PICO-POE

Open-hardware RP2350 / Pico2 board with Power-over-Ethernet, an RMII PHY, and a browser-based development workflow.
The repo holds the KiCad project (`hardware/`), the firmware with A/B-partitioned OTA + a tiny HTTP API (`firmware/`), the `pico-poe` Python CLI for build / flash / OTA / commanding (`tools/pico-poe/`), and a static web IDE that compiles user C in the browser via WASM clang+lld and pushes it over the network (`web/`).
Heavy build artefacts (the WASM toolchain bundle, the SDK web bundle) are produced by GitHub Actions and not committed — see `.github/workflows/`.

## First-time setup

1. **Tooling.** Install the Pico SDK 2.2.0, arm-none-eabi-gcc, and picotool under `~/.pico-sdk/` (the CLI defaults to those paths — see `tools/pico-poe/pico_poe_cli/dev.py` for the exact layout). Then `git clone --recurse-submodules` and `cd tools/pico-poe && python3 -m venv .venv && .venv/bin/pip install -e .`.
2. **First flash (USB).** Connect the board over USB while holding the `BOOTSEL` button to enter mass-storage mode, then `pico-poe provision` — this builds the firmware, seeds the bootloader and partition A with the safe (non-TBYB) image, and confirms `/api/status` returns `partition: A`.
3. **Power and network.** Connect the board to a PoE-capable switch (or keep it on USB power); it tries DHCP first and falls back to `192.168.178.200/24`. `pico-poe scan -s <your-/24>` finds it; `pico-poe status -d <ip>` should report `link: Up`.
4. **Iterate.** From here on, `pico-poe build && pico-poe ota-upload -d <ip> -f firmware/build/app/pico_poe_app.uf2` ships a new image over the network — no more BOOTSEL required. The web IDE adds live telemetry charts and remote GPIO/ADC commanding on top.
