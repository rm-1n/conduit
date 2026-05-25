# CONDUIT

Open-hardware RP2350 / Pico2 board with Power-over-Ethernet, an RMII PHY, and a browser-based development workflow.
The repo holds the KiCad project (`hardware/`), the firmware with A/B-partitioned OTA + a tiny HTTP API (`firmware/`), the `conduit` Python CLI for build / flash / OTA / commanding (`tools/conduit/`), and a static web IDE that compiles user C in the browser via WASM clang+lld and pushes it over the network (`web/`).

License: [MIT](LICENSE).

## First-time setup

1. **First flash (USB).** Hold `BOOTSEL` while plugging the board into USB — it enumerates as the `RPI-RP2350` mass-storage drive. Download the [latest commissioning image](https://github.com/rm-1n/conduit/releases/latest) — currently <!-- factory-uf2-version:start -->`factory-10.82`<!-- factory-uf2-version:end --> — and copy the `.uf2` file onto the drive. The drive disappears, the board reboots running the new firmware. The image is built by `.github/workflows/commissioning-image.yml` and contains the bootloader plus a non-TBYB app concatenated into one UF2.
2. **Power and network.** Connect the board to a PoE-capable switch (or keep it on USB power); it tries DHCP first and falls back to `192.168.178.200/24`.
3. **Iterate.** Open the web IDE in your browser, point it at the device's IP, and from there you write user C, build + OTA over the network, watch live telemetry charts, and send commands to the running firmware — all without leaving the browser.

## Connecting the IDE to a device

The web IDE is shipped at <https://rm-1n.github.io/conduit/> and also runs from any local static file server (`python3 -m http.server` in `web/` is enough). Open it, hit **Hardware Manager** in the top nav, and add a row:

- **IP address** — required. Use `conduit discover` from the CLI to find it on the LAN; the firmware emits a UDP multicast beacon at 1 Hz so you don't need to scan a subnet.
- **Unique-id** — optional, 16 hex chars (the RP2350 board id). Provide this if the board has a TLS identity blob in its IDENTITY partition (see "Per-device TLS" below); the IDE then talks to the device over HTTPS via a per-device wildcard hostname instead of plain HTTP.
- **Name** — optional, just a label for your own benefit.

Once added, the dropdown in the IDE picks the device and every fetch (`/api/status`, OTA upload, telemetry stream, commands) routes through the right URL.

### HTTP vs HTTPS

The two modes coexist; pick whichever fits your situation:

- **HTTP, no TLS** (default). The hosted IDE on GitHub Pages can't reach `http://<ip>/api/...` due to mixed-content blocking, but the IDE works fine over `http://localhost`/`file://` against a plain-HTTP device. This is the path for self-hosters and dev boards.
- **HTTPS via wildcard hostname** (opt-in). If you've written a per-device TLS identity into the IDENTITY partition, the IDE constructs `https://<dash-ip>.<unique-id>.devices.rm1n.com/api/status` and the device's per-device LE cert lights the green padlock — no browser warnings, no installed CAs. The matching DNS + cert-issuance services are the rm1n commercial add-on; they aren't part of this repo. Self-hosters with their own CA + DNS can override the zone via `Conduit.deviceTlsZone = '<your-zone>'` in the browser console.

## CLI

```
pip install -e tools/conduit                  # one-time install (use a venv)
conduit discover                              # find devices on the LAN
conduit status -d 192.168.178.200             # GET /api/status
conduit ota-upload -d <ip> -t <tok> -f <uf2>  # OTA via /api/upload
conduit cmd <name> [k=v ...] -d <ip> -t <tok> # /api/cmd
conduit provision -d <ip>                     # bootloader + partition A seed
```

The CLI does NOT mint per-device TLS certs — that's the rm1n commercial provisioning toolchain. `conduit provision` here just lays down the partition table + the app binary, leaving the IDENTITY partition empty. Devices come up over plain HTTP. If you want the HTTPS path, you can fill the IDENTITY partition yourself (`picotool load -p 2 -t bin -F <blob>`) using a blob in the format documented in `firmware/app/identity.h`.

## Web IDE

Plain static files: `index.html` + per-feature ES modules. No bundler, no framework. CDN-loaded h5wasm is the only runtime external dependency. The IDE compiles user `main.c` in the browser via the WASM clang/lld toolchain bundled under `web/assets/emception/` (built locally; see `web/lib/build-toolchain.sh`), links it against the prebuilt Pico SDK headers/objects under `web/assets/sdk/` (built by CI from `firmware/`), and produces a UF2 ready for `/api/upload`.

## Repository layout

- `hardware/conduit/` — KiCad project (schematics, PCB, fab outputs).
- `firmware/` — C firmware (Pico SDK): `app/` + `bootloader/` + `include/` + `lib/` (submodules) + `scripts/`.
  - A/B partitioned OTA via the RP2350 ROM bootloader. See `firmware/OTA.md` for the rollback semantics.
  - `firmware/app/identity.{c,h}` reads an optional 8 KB IDENTITY partition for the TLS path described above. The reader is benign on uncommissioned boards.
- `tools/conduit/` — Python `conduit` CLI (`click` + `httpx`). Wraps build, flash, OTA, status, commands, discover, serial.
- `web/` — Static HTML/CSS/JS frontend served from GitHub Pages.

## Tests

```
# Python CLI
cd tools/conduit && python3 -m venv .venv && .venv/bin/pip install -e ".[test]"
.venv/bin/pytest tests/

# Web IDE
cd web/tests && npm ci && npm test

# Firmware (host-side parser tests)
make -C firmware/tests test
```

CI (`.github/workflows/test.yml`) runs the Python suite across 3.9 / 3.12 / 3.14 and the web suite under Node 20 on every push.

## Contributing

Issues and pull requests welcome. The repo's working preferences for AI-assisted development (when, what, and how) live in [CLAUDE.md](CLAUDE.md); skim it if you want a guided tour of the architecture.
