"""CONDUIT CLI — manage devices from the command line."""

import os
import sys
import click
from .api import ConduitDevice, scan_subnet
from . import dev


@click.group()
def main():
    """CONDUIT device management tool."""


@main.command()
@click.option("-d", "--device", required=True, help="Device IP address")
@click.option("-t", "--token", required=True, help="Auth token")
@click.option("-f", "--file", "filepath", required=True, type=click.Path(exists=True), help="Path to .uf2 file")
def upload(device, token, filepath):
    """Upload firmware to a CONDUIT device."""
    dev = ConduitDevice(device, token)

    with open(filepath, "rb") as f:
        data = f.read()

    size_kb = len(data) / 1024
    click.echo(f"Uploading {filepath} ({size_kb:.1f} KB) to {device}...")

    try:
        result = dev.upload(data)
        click.echo(f"Success: {result.get('status', 'ok')}")
        click.echo("Device is rebooting with new firmware.")
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@main.command()
@click.option("-d", "--device", required=True, help="Device IP address")
def status(device):
    """Get device status."""
    dev = ConduitDevice(device)
    try:
        s = dev.status()
        click.echo(f"Version:   {s.get('version', '?')}")
        click.echo(f"IP:        {s.get('ip', '?')}")
        click.echo(f"MAC:       {s.get('mac', '?')}")
        click.echo(f"Uptime:    {s.get('uptime', '?')}s")
        click.echo(f"Link:      {'Up' if s.get('link') else 'Down'}")
        click.echo(f"PoE:       {'Yes' if s.get('poe') else 'No'}")
        click.echo(f"Partition: {s.get('partition', '?')}")
        click.echo(f"Board ID:  {s.get('board_id', '?')}")
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@main.command()
@click.option("-s", "--subnet", required=True, help="Subnet prefix (e.g. 192.168.1)")
def scan(subnet):
    """Scan a /24 subnet for CONDUIT devices."""
    click.echo(f"Scanning {subnet}.0/24...")
    results = scan_subnet(subnet)
    if not results:
        click.echo("No devices found.")
        return
    click.echo(f"Found {len(results)} device(s):")
    for d in results:
        click.echo(f"  {d['_ip']:16s}  v{d.get('version','?'):8s}  {d.get('mac','?')}")


@main.command()
@click.argument("name")
@click.argument("kvargs", nargs=-1)
@click.option("-d", "--device", required=True, help="Device IP address")
@click.option("-t", "--token", required=True, help="Auth token")
def cmd(name, kvargs, device, token):
    """Send a command to /api/cmd.

    Usage:
        conduit cmd <name> [k=v ...] -d <ip> -t <token>

    Examples:
        conduit cmd gpio_init   pin=15 dir=out -d 192.168.178.200 -t changeme
        conduit cmd gpio_toggle pin=15        -d 192.168.178.200 -t changeme
        conduit cmd adc_read    channel=0     -d 192.168.178.200 -t changeme
    """
    args = {}
    for kv in kvargs:
        if "=" not in kv:
            click.echo(f"Error: arg must be k=v, got {kv!r}", err=True)
            sys.exit(2)
        k, v = kv.split("=", 1)
        args[k] = v
    dev_obj = ConduitDevice(device, token)
    try:
        body = dev_obj.command(name, **args)
        import json as _json
        click.echo(_json.dumps(body, indent=2))
        if not body.get("ok", False):
            sys.exit(1)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@main.command()
@click.option("-d", "--device", required=True, help="Device IP address")
@click.option("-t", "--token", required=True, help="Auth token")
def reboot(device, token):
    """Reboot a CONDUIT device."""
    dev_obj = ConduitDevice(device, token)
    try:
        dev_obj.reboot()
        click.echo("Reboot command sent.")
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


# ── Development / hardware commands ──────────────────────────────────────────

def _env(name, default):
    return os.environ.get(name, default)


@main.command()
@click.option("--firmware-dir", default=None, help="Path to firmware/ directory")
@click.option("--sdk",       envvar="PICO_SDK_PATH",  default=dev.DEFAULT_SDK_PATH,      help="Pico SDK path")
@click.option("--toolchain", envvar="TOOLCHAIN_PATH",  default=dev.DEFAULT_TOOLCHAIN_BIN, help="GCC toolchain bin/")
def build(firmware_dir, sdk, toolchain):
    """Build the firmware (cmake --build)."""
    firmware_dir = firmware_dir or dev.DEFAULT_FIRMWARE_DIR
    dev.build_firmware(firmware_dir, sdk, toolchain)


@main.command()
@click.option("--firmware-dir", default=None, help="Path to firmware/ directory")
@click.option("--sdk",       envvar="PICO_SDK_PATH",  default=dev.DEFAULT_SDK_PATH,      help="Pico SDK path")
@click.option("--toolchain", envvar="TOOLCHAIN_PATH",  default=dev.DEFAULT_TOOLCHAIN_BIN, help="GCC toolchain bin/")
@click.option("--picotool",  envvar="PICOTOOL",        default=dev.DEFAULT_PICOTOOL,      help="Path to picotool")
@click.option("--serial/--no-serial", default=False, help="Capture serial output after flash")
@click.option("--serial-port", envvar="SERIAL_PORT", default=dev.DEFAULT_SERIAL_PORT, help="USB serial device")
@click.option("--tbyb", is_flag=True, default=False,
              help="Diagnostic: load the TBYB-flagged conduit_app.uf2 instead "
                   "of conduit_app_initial.uf2. The TBYB image needs an OTA "
                   "flash-update reboot + /api/commit to persist; via the BOOTSEL "
                   "USB path it boots once and rolls back, leaving the device "
                   "unreachable. Use only for testing the rollback path.")
def flash(firmware_dir, sdk, toolchain, picotool, serial, serial_port, tbyb):
    """Build firmware, flash via picotool, and reboot.

    Defaults to the non-TBYB conduit_app_initial.uf2 so a USB reflash always
    leaves the device in a clean, network-reachable state. Use --tbyb only if
    you specifically want to exercise the watchdog rollback path.
    """
    firmware_dir = firmware_dir or dev.DEFAULT_FIRMWARE_DIR
    dev.build_firmware(firmware_dir, sdk, toolchain)
    _pt, initial_uf2, ota_uf2 = dev.firmware_uf2_paths(firmware_dir)
    if tbyb:
        dev.warn("--tbyb: flashing the TBYB image via USB. The device will boot "
                 "once but the watchdog rollback fires unless /api/commit is "
                 "called within ~4 s. Expect the device to come back unreachable.")
        uf2 = ota_uf2
    else:
        uf2 = initial_uf2
    dev.flash_firmware(picotool, uf2)
    if serial:
        dev.capture_serial(serial_port)


@main.command()
@click.option("--serial-port", envvar="SERIAL_PORT", default=dev.DEFAULT_SERIAL_PORT, help="USB serial device")
@click.option("--duration", default=12, help="Capture duration in seconds")
@click.option("--boot-wait", default=8, help="Seconds to wait for boot before capture")
def serial(serial_port, duration, boot_wait):
    """Capture serial output from the connected Pico."""
    dev.capture_serial(serial_port, duration=duration, boot_wait=boot_wait)


@main.command()
@click.option("--serial-port", envvar="SERIAL_PORT", default=dev.DEFAULT_SERIAL_PORT, help="USB serial device")
@click.option("-o", "--output", default=None, type=click.Path(),
              help="Append the diag stream to this file (line-buffered)")
@click.option("--duration", default=None, type=int,
              help="Stop after N seconds (default: run until Ctrl-C)")
def diag(serial_port, output, duration):
    """Stream the firmware [diag] heartbeat over USB.

    Long-running diagnostic for catching device stalls. Watches each
    heartbeat for two failure fingerprints and warns loudly when they
    trip — Core-1 stall (c1 delta = 0) and TCP PCB exhaustion. Leave
    it running overnight or during a soak; when the device wedges, the
    output file pins which subsystem stopped first.

    Examples:
        conduit diag                                     # stream to stdout, Ctrl-C to stop
        conduit diag -o diag.log                         # also write to a file
        conduit diag -o diag.log --duration 28800        # 8h soak then exit
    """
    dev.diag_capture(serial_port, output_path=output, duration=duration)


@main.command()
@click.option("-d", "--device", default=dev.DEFAULT_DEVICE_IP, help="Device IP address")
@click.option("--wait/--no-wait", default=True, help="Wait for device to boot first")
def test(device, wait):
    """Run connectivity tests (ping, ARP, API, CORS)."""
    if wait:
        if not dev.wait_for_boot(device, timeout=15):
            dev.fail("Device unreachable — aborting tests")
            sys.exit(1)
    passed, failed = dev.run_all_tests(device)
    sys.exit(1 if failed else 0)


@main.command(name="flash-and-test")
@click.option("-d", "--device", default=dev.DEFAULT_DEVICE_IP, help="Device IP address")
@click.option("--firmware-dir", default=None, help="Path to firmware/ directory")
@click.option("--sdk",       envvar="PICO_SDK_PATH",  default=dev.DEFAULT_SDK_PATH,      help="Pico SDK path")
@click.option("--toolchain", envvar="TOOLCHAIN_PATH",  default=dev.DEFAULT_TOOLCHAIN_BIN, help="GCC toolchain bin/")
@click.option("--picotool",  envvar="PICOTOOL",        default=dev.DEFAULT_PICOTOOL,      help="Path to picotool")
@click.option("--serial/--no-serial", default=False, help="Capture serial output after flash")
@click.option("--serial-port", envvar="SERIAL_PORT", default=dev.DEFAULT_SERIAL_PORT, help="USB serial device")
def flash_and_test(device, firmware_dir, sdk, toolchain, picotool, serial, serial_port):
    """Build, flash, wait for boot, and run all tests.

    Flashes the non-TBYB conduit_app_initial.uf2 so the device comes up on
    a normal boot path (no watchdog rollback gating). For TBYB testing use
    `conduit ab-cycle` over OTA instead.
    """
    import time

    firmware_dir = firmware_dir or dev.DEFAULT_FIRMWARE_DIR

    print(f"\n{'='*50}")
    print(f"  CONDUIT Flash & Test")
    print(f"  Device IP: {device}")
    print(f"{'='*50}\n")

    dev.build_firmware(firmware_dir, sdk, toolchain)
    _pt, initial_uf2, _ota = dev.firmware_uf2_paths(firmware_dir)
    dev.flash_firmware(picotool, initial_uf2)

    if serial:
        dev.capture_serial(serial_port)

    dev.info("Waiting 10s for device to boot...")
    time.sleep(10)

    if not dev.wait_for_boot(device, timeout=15):
        dev.fail("Device unreachable — aborting tests")
        sys.exit(1)

    passed, failed = dev.run_all_tests(device)
    sys.exit(1 if failed else 0)


@main.command(name="ota-upload")
@click.option("-d", "--device", default=dev.DEFAULT_DEVICE_IP, help="Device IP address")
@click.option("-t", "--token", default="changeme", help="Auth token")
@click.option("-f", "--file", "filepath", required=True, type=click.Path(exists=True), help="Path to .uf2 file")
def ota_upload(device, token, filepath):
    """Upload a UF2 file over the network (OTA update)."""
    success = dev.ota_upload(device, token, filepath)
    sys.exit(0 if success else 1)


@main.command()
@click.option("-d", "--device", default=dev.DEFAULT_DEVICE_IP, help="Device IP address")
@click.option("--firmware-dir", default=None, help="Path to firmware/ directory")
@click.option("--sdk",       envvar="PICO_SDK_PATH",  default=dev.DEFAULT_SDK_PATH,      help="Pico SDK path")
@click.option("--toolchain", envvar="TOOLCHAIN_PATH",  default=dev.DEFAULT_TOOLCHAIN_BIN, help="GCC toolchain bin/")
@click.option("--picotool",  envvar="PICOTOOL",        default=dev.DEFAULT_PICOTOOL,      help="Path to picotool")
@click.option("--skip-build", is_flag=True, default=False, help="Skip cmake build step")
def provision(device, firmware_dir, sdk, toolchain, picotool, skip_build):
    """Clean first-time install: bootloader + partition A seed + verify /api/status == A."""
    firmware_dir = firmware_dir or dev.DEFAULT_FIRMWARE_DIR
    if not skip_build:
        dev.build_firmware(firmware_dir, sdk, toolchain)
    pt_uf2, initial_uf2, _ota_uf2 = dev.firmware_uf2_paths(firmware_dir)
    ok = dev.provision_clean(picotool, pt_uf2, initial_uf2, device)
    sys.exit(0 if ok else 1)


@main.command(name="ab-cycle")
@click.option("-d", "--device", default=dev.DEFAULT_DEVICE_IP, help="Device IP address")
@click.option("-t", "--token", default="changeme", help="Auth token")
@click.option("-f", "--file", "filepath", required=True, type=click.Path(exists=True), help="Path to next .uf2 file")
def ab_cycle(device, token, filepath):
    """OTA a new UF2, assert partition flips (A↔B) and version changes."""
    ok = dev.ab_cycle(device, token, filepath)
    sys.exit(0 if ok else 1)


@main.command(name="fw-info")
@click.option("--picotool", envvar="PICOTOOL", default=dev.DEFAULT_PICOTOOL, help="Path to picotool")
def fw_info(picotool):
    """Dump `picotool info -a` + `picotool partition info` from a BOOTSEL device."""
    dev.picotool_info(picotool)


if __name__ == "__main__":
    main()
