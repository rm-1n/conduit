"""CONDUIT CLI — manage devices from the command line."""

import json as _json
import os
import sys
import time
import click
from .api import ConduitDevice
from . import dev
from . import discover as _discover


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
@click.option("--json", "as_json", is_flag=True,
              help="Emit the raw /api/status JSON instead of the formatted table")
def status(device, as_json):
    """Get device status."""
    dev = ConduitDevice(device)
    try:
        s = dev.status()
        if as_json:
            click.echo(_json.dumps(s, indent=2))
            return
        bin_ver = s.get('binary_version')
        click.echo(f"Version:   {s.get('version', '?')}"
                   + (f" (binary {bin_ver})" if bin_ver else ""))
        click.echo(f"IP:        {s.get('ip', '?')}")
        click.echo(f"MAC:       {s.get('mac', '?')}")
        click.echo(f"Uptime:    {s.get('uptime', '?')}s")
        click.echo(f"Link:      {'Up' if s.get('link') else 'Down'}")
        click.echo(f"PoE:       {'Yes' if s.get('poe') else 'No'}")
        click.echo(f"Partition: {s.get('partition', '?')}")
        click.echo(f"Board ID:  {s.get('board_id', '?')}")
        # Ring-eviction telemetry — quiet when zero. Non-zero means the
        # producer outran the consumer at some point and we silently
        # dropped samples. data_buffer.c is the source of truth.
        evictions = s.get('data_ring_evictions')
        if evictions:
            click.echo(f"Data ring: {evictions} evictions, "
                       f"{s.get('data_ring_evicted_bytes', 0)} bytes lost")
        # Streaming-conn close-cause attribution (firmware ≥ 10.80).
        # Quiet when every bucket is zero so healthy boards stay terse.
        # When non-zero, this is the primary diagnostic for "WS dropped
        # after N minutes — why?" — every cause manifests in the
        # browser as the same 1006 close, only the device knows which.
        close_keys = [
            ('stream_close_recv_eof',      'recv_eof'),
            ('stream_close_recv_err',      'recv_err'),
            ('stream_close_err_rst',       'err_rst'),
            ('stream_close_err_abrt',      'err_abrt'),
            ('stream_close_err_clsd',      'err_clsd'),
            ('stream_close_err_other',     'err_other'),
            ('stream_close_write_err',     'write_err'),
            ('stream_close_ws_parse_fail', 'ws_parse_fail'),
            ('stream_close_link_down',     'link_down'),
        ]
        present = [(label, s[key]) for key, label in close_keys if s.get(key)]
        if present:
            click.echo(f"Streams:   {s.get('streams_open', '?')} open")
            click.echo("Closes:    " + ", ".join(f"{lbl}={n}" for lbl, n in present))
            last_err = s.get('stream_last_close_err')
            last_age_ms = s.get('stream_last_close_age_ms')
            if last_err is not None and last_age_ms is not None:
                click.echo(f"  last:    err={last_err}, age={last_age_ms / 1000:.1f}s")
        elif s.get('streams_open') is not None:
            click.echo(f"Streams:   {s['streams_open']} open")
        # Phase 0 wedge-attribution counters (firmware ≥ 10.82). Only
        # show when something is interesting: a pool near max, a drop
        # counter non-zero, or an mbedtls slab exhaustion event. The
        # raw counters always live in --json output for scripting.
        diag_parts = []
        pbuf_used = s.get('pbuf_used')
        pbuf_max = s.get('pbuf_max')
        if pbuf_used is not None and pbuf_max:
            diag_parts.append(f"pbuf {pbuf_used}/{pbuf_max}")
        tpcb_used = s.get('tcp_pcb_used')
        tpcb_max = s.get('tcp_pcb_max')
        if tpcb_used is not None and tpcb_max:
            diag_parts.append(f"tcp_pcb {tpcb_used}/{tpcb_max}")
        sto_used = s.get('sys_timeout_used')
        sto_max = s.get('sys_timeout_max')
        if sto_used is not None and sto_max:
            diag_parts.append(f"sys_timeout {sto_used}/{sto_max}")
        if diag_parts:
            click.echo("Pools:     " + ", ".join(diag_parts))
        pcbs_parts = []
        for key, label in (('tcp_pcbs_active', 'active'),
                           ('tcp_pcbs_timewait', 'tw'),
                           ('tcp_pcbs_listen', 'listen')):
            v = s.get(key)
            if v is not None:
                pcbs_parts.append(f"{label}={v}")
        if pcbs_parts:
            click.echo("TCP PCBs:  " + ", ".join(pcbs_parts))
        drops = {
            'ip_drops': s.get('ip_drops', 0),
            'tcp_drops': s.get('tcp_drops', 0),
            'tcp_errs': s.get('tcp_errs', 0),
            'tcp_chkerrs': s.get('tcp_chkerrs', 0),
        }
        nz = {k: v for k, v in drops.items() if v}
        if nz:
            click.echo("Drops:     " + ", ".join(f"{k}={v}" for k, v in nz.items()))
        slab_in = s.get('mbedtls_slab_exhausted_in', 0)
        slab_out = s.get('mbedtls_slab_exhausted_out', 0)
        if slab_in or slab_out:
            click.echo(f"mbedtls:   slab exhausted in={slab_in} out={slab_out}")
        # core1_iter + poll_fires + accepts: the "is anything still
        # running?" triplet. Two successive `conduit status` calls
        # should show all three advancing.
        iter_val = s.get('core1_iter')
        polls = s.get('http_poll_fires')
        accepts = s.get('http_accepts')
        if iter_val is not None and polls is not None and accepts is not None:
            click.echo(f"Liveness:  core1_iter={iter_val} "
                       f"poll_fires={polls} accepts={accepts}")
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@main.command()
@click.option("-t", "--timeout", default=5.0, type=float,
              show_default=True,
              help="Listen window in seconds")
@click.option("--json", "as_json", is_flag=True,
              help="Emit machine-readable JSON instead of a table")
@click.option("-v", "--verbose", is_flag=True,
              help="Print every UDP packet received (incl. malformed) for debugging")
def discover(timeout, as_json, verbose):
    """Find CONDUIT devices on the LAN via multicast.

    Listens for the firmware's once-per-second JSON beacon
    (group 239.255.42.42:5354) for the requested window and prints
    one row per unique-id. This is the supported way to find a
    device's current LAN IP — no /24 sweep, no HTTP probing,
    works the moment a device's link is up.
    """
    if verbose:
        click.echo(
            f"[discover] joining {_discover.DISCOVERY_GROUP}:{_discover.DISCOVERY_PORT}, "
            f"listening for {timeout:.1f}s",
            err=True,
        )

        def _trace(raw: bytes, addr) -> None:
            try:
                preview = raw.decode("utf-8", errors="replace")[:120]
            except Exception:
                preview = repr(raw[:64])
            click.echo(f"[discover] {len(raw):4d} B from {addr[0]}:{addr[1]}  {preview}", err=True)

        seen: dict[str, _discover.DiscoveredDevice] = {}
        for d in _discover.listen_for_devices(timeout_s=timeout, on_raw=_trace):
            seen[d.unique_id] = d
        devices = list(seen.values())
    else:
        devices = _discover.collect_unique_devices(timeout_s=timeout)

    now = time.time()
    if as_json:
        click.echo(_json.dumps([
            {
                "id": d.unique_id,
                "ip": d.ip,
                "name": d.name,
                "version": d.version,
                "age_s": round(now - d.last_seen, 2),
            }
            for d in devices
        ], indent=2))
        return
    if not devices:
        click.echo(f"No devices heard in {timeout:.1f}s.")
        if not verbose:
            click.echo("Tip: rerun with -v to see whether ANY UDP packets reach your laptop.")
        return
    click.echo(f"Found {len(devices)} device(s):")
    click.echo(f"  {'unique-id':<20}  {'ip':<16}  {'name':<16}  {'version':<10}  age")
    for d in sorted(devices, key=lambda x: x.unique_id):
        age = f"{now - d.last_seen:.1f}s"
        click.echo(f"  {d.unique_id:<20}  {d.ip:<16}  {d.name:<16}  {d.version:<10}  {age}")


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
@click.option("--dev", "dev_logs", is_flag=True, default=False,
              help="Enable verbose firmware status prints over USB CDC "
                   "([net]/[discovery]/[main]/etc.). Off by default — "
                   "production firmware is silent on serial.")
def build(firmware_dir, sdk, toolchain, dev_logs):
    """Build the firmware (cmake --build)."""
    firmware_dir = firmware_dir or dev.DEFAULT_FIRMWARE_DIR
    dev.build_firmware(firmware_dir, sdk, toolchain, dev_logs=dev_logs)


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
@click.option("--dev", "dev_logs", is_flag=True, default=False,
              help="Enable verbose firmware status prints over USB CDC "
                   "([net]/[discovery]/[main]/etc.). Off by default — "
                   "production firmware is silent on serial.")
def flash(firmware_dir, sdk, toolchain, picotool, serial, serial_port, tbyb, dev_logs):
    """Build firmware, flash via picotool, and reboot.

    Defaults to the non-TBYB conduit_app_initial.uf2 so a USB reflash always
    leaves the device in a clean, network-reachable state. Use --tbyb only if
    you specifically want to exercise the watchdog rollback path.
    """
    firmware_dir = firmware_dir or dev.DEFAULT_FIRMWARE_DIR
    dev.build_firmware(firmware_dir, sdk, toolchain, dev_logs=dev_logs)
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
@click.option("--https/--http", "use_https", default=False,
              help="POST over HTTPS via <dash-ip>.<board-id>.devices.rm1n.com (default: HTTP). "
                   "Useful for benchmarking the TLS-stack throughput; requires the per-device "
                   "rm1n cert (loaded from the IDENTITY partition) and conduit-dns resolving the "
                   "hostname to the LAN IP.")
@click.option("--commit/--no-commit", "do_commit", default=True, show_default=True,
              help="Call /api/commit after the new image boots so the next reboot "
                   "(power cycle, /api/reboot, watchdog) keeps it instead of "
                   "rolling back to the previous partition. Pass --no-commit to "
                   "deliberately leave it TBYB-pending — used when validating "
                   "the rollback path itself.")
def ota_upload(device, token, filepath, use_https, do_commit):
    """Upload a UF2 file over the network (OTA update).

    Prints upload duration + averaged throughput so we can compare
    cipher / mbedtls-config experiments side by side.
    """
    success = dev.ota_upload(device, token, filepath, use_https=use_https,
                             commit=do_commit)
    sys.exit(0 if success else 1)


@main.command(name="ota-commit")
@click.option("-d", "--device", default=dev.DEFAULT_DEVICE_IP, help="Device IP address")
@click.option("-t", "--token", default="changeme", help="Auth token")
def ota_commit_cmd(device, token):
    """Manually finalize a TBYB-pending image via POST /api/commit.

    Useful when the last `conduit ota-upload --no-commit` ran in a
    rollback-validation flow and you've now confirmed the new image is
    healthy; without this, the next reboot lands back on the previous
    partition.
    """
    try:
        result = dev.ota_commit(device, token)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)
    click.echo(_json.dumps(result))
    sys.exit(0 if result.get("ok") else 1)


@main.command()
@click.option("-d", "--device", default=dev.DEFAULT_DEVICE_IP, help="Device IP address")
@click.option("--firmware-dir", default=None, help="Path to firmware/ directory")
@click.option("--sdk",       envvar="PICO_SDK_PATH",  default=dev.DEFAULT_SDK_PATH,      help="Pico SDK path")
@click.option("--toolchain", envvar="TOOLCHAIN_PATH",  default=dev.DEFAULT_TOOLCHAIN_BIN, help="GCC toolchain bin/")
@click.option("--picotool",  envvar="PICOTOOL",        default=dev.DEFAULT_PICOTOOL,      help="Path to picotool")
@click.option("--skip-build", is_flag=True, default=False, help="Skip cmake build step")
def provision(device, firmware_dir, sdk, toolchain, picotool, skip_build):
    """Clean first-time install: partition table + partition A seed.

    Hold BOOTSEL while plugging the board in, then run `conduit provision`.
    The tool erases flash, lays down the partition table, seeds the app
    into partition A, and reboots. After the reboot the device is reachable
    over HTTP at the configured IP.
    """
    firmware_dir = firmware_dir or dev.DEFAULT_FIRMWARE_DIR
    if not skip_build:
        dev.build_firmware(firmware_dir, sdk, toolchain)
    pt_uf2, initial_uf2, _ota_uf2 = dev.firmware_uf2_paths(firmware_dir)
    success = dev.provision_clean(picotool, pt_uf2, initial_uf2, device)
    sys.exit(0 if success else 1)


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


@main.command(name="ws-probe")
@click.option("-d", "--device", required=True, help="Device IP or hostname")
@click.option("-p", "--port", type=int, default=80, show_default=True,
              help="80 for plain HTTP, 443 for TLS")
@click.option("--tls", is_flag=True, help="Use wss:// (TLS)")
@click.option("--tls-verify", is_flag=True, help="Verify TLS cert (off by default for LAN devices)")
@click.option("-t", "--token", default="changeme", show_default=True,
              help="Auth token sent in the first-frame CMD")
@click.option("--duration", type=float, default=6.0, show_default=True,
              help="Seconds to listen after auth")
@click.option("--exit-on-status", is_flag=True,
              help="Break the listen loop the moment the first STATUS "
                   "frame arrives — used by the reconnect-budget timing.")
@click.option("--repeat", type=int, default=1, show_default=True,
              help="Run N back-to-back probe cycles; print a per-cycle "
                   "timing table.")
@click.option("--threshold-s", type=float, default=2.0, show_default=True,
              help="Per-cycle total_ms budget. With --repeat>1, the "
                   "command exits 0 only if every cycle stays under.")
@click.option("--gap-s", type=float, default=0.0, show_default=True,
              help="Seconds to sleep between --repeat cycles.")
@click.option("--reuse-session", is_flag=True,
              help="Carry the TLS session from cycle to cycle so the "
                   "server's session-ticket / session-cache can "
                   "abbreviate the handshake. Only meaningful with --tls.")
@click.option("--json", "as_json", is_flag=True, help="Emit JSON instead of text")
def ws_probe_cmd(device, port, tls, tls_verify, token, duration,
                 exit_on_status, repeat, threshold_s, gap_s,
                 reuse_session, as_json):
    """Open a WebSocket to /api/stream, authenticate, observe frames.

    End-to-end protocol smoke for the unified bidirectional stream.
    Reports handshake status, auth, status snapshot, log/data byte
    counts, errors, and per-phase timings (connect → handshake → auth
    → status → close). Reuses the same probe engine that backs
    `tests/test_ws_probe.py`.

    Reconnect-budget mode:
        conduit ws-probe -d <ip> --exit-on-status --repeat 10
    runs 10 dis/reconnect cycles and exits 0 only if every cycle's
    total round-trip stayed under --threshold-s.
    """
    from . import ws_probe as _wp

    argv = ["-d", device, "-p", str(port), "-t", token, "--duration", str(duration)]
    if tls:
        argv.append("--tls")
    if tls_verify:
        argv.append("--tls-verify")
    if exit_on_status:
        argv.append("--exit-on-status")
    if repeat != 1:
        argv += ["--repeat", str(repeat)]
    argv += ["--threshold-s", str(threshold_s)]
    if gap_s > 0:
        argv += ["--gap-s", str(gap_s)]
    if reuse_session:
        argv.append("--reuse-session")
    if as_json:
        argv.append("--json")
    sys.exit(_wp.main(argv))


@main.command(name="analyze-hdf5")
@click.argument("path", type=click.Path(exists=True, dir_okay=False))
@click.option("-c", "--channel", "channels", multiple=True,
              help="Only analyze this channel (repeatable). Default: all.")
@click.option("--threshold-ms", type=float, default=None,
              help="Gap threshold in ms. Default: max(4 × median delta, 100 ms).")
@click.option("--top", type=int, default=10, show_default=True,
              help="Top-N worst gaps to list per channel.")
@click.option("--json", "as_json", is_flag=True, help="Emit JSON instead of text.")
def analyze_hdf5_cmd(path, channels, threshold_ms, top, as_json):
    """Analyze an IDE-exported HDF5 telemetry recording for data gaps.

    Reads /telemetry/<NAME>/{uptime_us, wall_ms} for each channel,
    computes inter-sample deltas, and reports cadence stats, gaps
    above a threshold, top-N worst gaps with wall-clock context, lost-
    record / lost-time estimates, and cross-channel synchrony (so a
    producer-side stall is distinguishable from wire-level loss).

    Examples:
        conduit analyze-hdf5 recording.h5
        conduit analyze-hdf5 recording.h5 --threshold-ms 50 --top 20
        conduit analyze-hdf5 recording.h5 -c SIN0 -c SIN1 --json
    """
    from . import analyze_hdf5 as _ah

    argv = [path]
    for ch in channels:
        argv += ["--channel", ch]
    if threshold_ms is not None:
        argv += ["--threshold-ms", str(threshold_ms)]
    argv += ["--top", str(top)]
    if as_json:
        argv.append("--json")
    sys.exit(_ah.main(argv))


if __name__ == "__main__":
    main()
