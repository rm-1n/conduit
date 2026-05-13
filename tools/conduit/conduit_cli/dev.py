"""Local development helpers: build, flash, serial capture, connectivity tests."""

import json
import os
import select
import subprocess
import sys
import time
import urllib.request

# ── Defaults (override via environment) ──────────────────────────────────────

HOME = os.path.expanduser("~")

DEFAULT_SDK_PATH      = os.path.join(HOME, ".pico-sdk", "sdk", "2.2.0")
DEFAULT_PICOTOOL      = os.path.join(HOME, ".pico-sdk", "picotool", "2.2.0-a4", "picotool", "picotool")
DEFAULT_TOOLCHAIN_BIN = os.path.join(HOME, ".pico-sdk", "toolchain", "14_2_Rel1", "bin")
DEFAULT_DEVICE_IP     = "192.168.178.200"
DEFAULT_SERIAL_PORT   = "/dev/cu.usbmodem1101"

# Firmware dir is two levels up from this package, then into firmware/
_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FIRMWARE_DIR = os.path.normpath(os.path.join(_PKG_DIR, "..", "..", "..", "firmware"))

# ── Terminal colours ─────────────────────────────────────────────────────────

RED    = "\033[91m"
GREEN  = "\033[92m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
RESET  = "\033[0m"


def info(msg):
    print(f"{CYAN}▶ {msg}{RESET}")

def ok(msg):
    print(f"{GREEN}✓ {msg}{RESET}")

def warn(msg):
    print(f"{YELLOW}⚠ {msg}{RESET}")

def fail(msg):
    print(f"{RED}✗ {msg}{RESET}")


def _run(cmd, env=None, cwd=None, check=True):
    result = subprocess.run(cmd, shell=True, env=env, cwd=cwd,
                            capture_output=True, text=True)
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.stderr.strip():
        print(result.stderr.strip(), file=sys.stderr)
    if check and result.returncode != 0:
        fail(f"Command failed (exit {result.returncode}): {cmd}")
        sys.exit(1)
    return result


# ── Build ────────────────────────────────────────────────────────────────────

def build_firmware(firmware_dir, sdk_path, toolchain_bin, dev_logs=False):
    """Run cmake --build in the firmware directory. Returns the app UF2 path.

    When ``dev_logs`` is True, the firmware is built with
    ``CONDUIT_DEV_LOGS=ON`` so all the [net] / [discovery] / [main]
    status chatter prints over USB CDC. Default builds are silent —
    end users plugging a device in shouldn't see firmware-internal
    status spam in `conduit serial`. The flag is reflected by re-
    running cmake configure (no-op if already in sync) before each
    build, so toggling --dev between two consecutive `conduit build`
    invocations does the right thing.
    """
    info("Building firmware...")
    env = os.environ.copy()
    env["PICO_SDK_PATH"] = sdk_path
    env["PATH"] = f"{toolchain_bin}:{env['PATH']}"

    # Re-run configure with the wanted CONDUIT_DEV_LOGS value. cmake is
    # cache-aware: if the value matches what's already in CMakeCache.txt
    # this is fast and idempotent; if it changed, the relevant TUs get
    # rebuilt. The `-S firmware -B build` form works whether or not
    # build/ exists yet.
    dev_flag = "ON" if dev_logs else "OFF"
    _run(f"cmake -S . -B build -G Ninja -DPICO_BOARD=pico2 "
         f"-DCONDUIT_DEV_LOGS={dev_flag}",
         env=env, cwd=firmware_dir)

    ncpu = os.cpu_count() or 4
    _run(f"cmake --build build -j{ncpu}", env=env, cwd=firmware_dir)

    uf2 = os.path.join(firmware_dir, "build", "app", "conduit_app.uf2")
    if not os.path.isfile(uf2):
        fail(f"UF2 not found at {uf2}")
        sys.exit(1)
    if dev_logs:
        info("Built with CONDUIT_DEV_LOGS=ON — firmware will print [net]/"
             "[discovery]/[main] status over USB CDC.")
    ok(f"Build complete: {os.path.basename(uf2)}")
    return uf2


def firmware_uf2_paths(firmware_dir):
    """Return (partition_table_uf2, initial_app_uf2, ota_app_uf2) paths.

    The initial UF2 is built without the TBYB flag so it will boot on a
    plain reboot after BOOTSEL flashing. The OTA UF2 is TBYB-flagged and
    only bootable via a flash-update reboot, which is what the /api/upload
    path triggers."""
    return (
        os.path.join(firmware_dir, "build", "bootloader", "partition_table.uf2"),
        os.path.join(firmware_dir, "build", "app", "conduit_app_initial.uf2"),
        os.path.join(firmware_dir, "build", "app", "conduit_app.uf2"),
    )


# ── Flash ────────────────────────────────────────────────────────────────────

def flash_firmware(picotool, uf2_path):
    """Load UF2 via picotool and reboot into application mode."""
    info("Flashing firmware via picotool...")
    _run(f"{picotool} load -F {uf2_path}")
    ok("Firmware loaded")

    info("Rebooting into application mode...")
    _run(f"{picotool} reboot")
    ok("Reboot command sent")


# ── Serial capture ───────────────────────────────────────────────────────────

def diag_capture(serial_port, output_path=None, duration=None):
    """Long-running stream of the firmware's [diag] heartbeat.

    Reads USB CDC line-by-line, prints to stdout, optionally appends to
    a file. Runs until --duration elapses or Ctrl-C. Watches each
    [diag] line for two failure fingerprints and yells loudly when
    they trip:
       • Core-1 stalled — the c1 delta in the heartbeat hits 0+ for
         multiple consecutive samples.
       • TCP PCB exhaustion — tcp_pcb saturated (used == max).

    The point of this tool is to leave it running overnight or during
    a soak. When the device wedges, scrolling back through the file
    pinpoints which subsystem stopped first.
    """
    import re
    import signal

    info(f"Streaming {serial_port}"
         f"{' → ' + output_path if output_path else ''}"
         f"{f' for {duration}s' if duration else ' (Ctrl-C to stop)'}")

    try:
        fd = os.open(serial_port, os.O_RDONLY | os.O_NONBLOCK)
    except OSError as e:
        warn(f"Cannot open {serial_port}: {e}")
        return None

    fout = None
    if output_path:
        # Line-buffered so the log stays current even if we're killed
        # mid-stream — losing the last few seconds is the worst case.
        fout = open(output_path, "a", buffering=1)
        fout.write(f"# diag stream started {time.strftime('%Y-%m-%d %H:%M:%S')}\n")

    # Heartbeat line format produced by firmware/app/diag.c:
    #   [diag] link=1 ip=... c1=N(+Δ) heap=u/m pbuf=u/m tcp_pcb=u/m
    #          tcp=Aa/Tt/Ll rx=N(+Δ) tx=N(+Δ) commit_pending=0
    diag_re = re.compile(
        r"\[diag\] .*?c1=(\d+)\(\+(\d+)\).*?tcp_pcb=(\d+)/(\d+)"
    )
    consecutive_stalls = 0
    saturated_streak = 0
    sample_count = 0

    # Graceful Ctrl-C: print summary on the way out instead of a stack trace.
    stop = {"flag": False}
    def _on_sig(_n, _f):
        stop["flag"] = True
    signal.signal(signal.SIGINT, _on_sig)
    signal.signal(signal.SIGTERM, _on_sig)

    end = (time.time() + duration) if duration else None
    line_buf = b""

    try:
        while not stop["flag"] and (end is None or time.time() < end):
            r, _, _ = select.select([fd], [], [], 1.0)
            if not r:
                continue
            try:
                chunk = os.read(fd, 4096)
            except BlockingIOError:
                continue
            if not chunk:
                continue
            line_buf += chunk
            while b"\n" in line_buf:
                raw, line_buf = line_buf.split(b"\n", 1)
                line = raw.decode("utf-8", errors="replace").rstrip("\r")
                if not line:
                    continue
                ts = time.strftime("%H:%M:%S")
                stamped = f"{ts}  {line}"
                print(stamped)
                if fout:
                    fout.write(stamped + "\n")

                m = diag_re.search(line)
                if m:
                    sample_count += 1
                    _, dc1, used, mx = m.groups()
                    dc1, used, mx = int(dc1), int(used), int(mx)
                    if dc1 == 0:
                        consecutive_stalls += 1
                        if consecutive_stalls == 1:
                            warn("Core-1 delta dropped to 0 — possible stall starting")
                        elif consecutive_stalls in (3, 5, 10, 30, 60):
                            warn(f"Core-1 stalled for {consecutive_stalls} samples")
                    else:
                        if consecutive_stalls > 0:
                            info(f"Core-1 recovered after {consecutive_stalls} samples")
                        consecutive_stalls = 0
                    if used >= mx:
                        saturated_streak += 1
                        if saturated_streak in (5, 30, 120):
                            warn(f"TCP PCB pool saturated for {saturated_streak} samples ({used}/{mx})")
                    else:
                        saturated_streak = 0
    finally:
        os.close(fd)
        if fout:
            fout.write(f"# diag stream ended {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
            fout.close()
        info(f"Captured {sample_count} heartbeats")
    return sample_count


def capture_serial(serial_port, duration=12, boot_wait=8):
    """Capture serial output from the Pico after a reboot."""
    info(f"Waiting {boot_wait}s for boot, then capturing serial for {duration}s...")
    time.sleep(boot_wait)

    try:
        fd = os.open(serial_port, os.O_RDONLY | os.O_NONBLOCK)
    except OSError as e:
        warn(f"Cannot open {serial_port}: {e}")
        return None

    buf = b""
    end = time.time() + duration
    try:
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 1.0)
            if r:
                try:
                    chunk = os.read(fd, 4096)
                    if chunk:
                        buf += chunk
                except BlockingIOError:
                    pass
    finally:
        os.close(fd)

    output = buf.decode("utf-8", errors="replace").strip()
    if output:
        print(f"\n{CYAN}── Serial output ──{RESET}")
        print(output)
        print(f"{CYAN}───────────────────{RESET}\n")
    else:
        warn("No serial output captured")
    return output


# ── Network tests ────────────────────────────────────────────────────────────

def wait_for_boot(ip, timeout=20):
    """Wait for the device to become pingable."""
    info(f"Waiting for {ip} to respond to ping (up to {timeout}s)...")
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", "1", ip],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                if "round-trip" in line or "rtt" in line:
                    ok(f"Ping OK — {line.strip()}")
                    return True
            ok("Ping OK")
            return True
        time.sleep(1)
    fail(f"Device did not respond to ping within {timeout}s")
    return False


def test_ping(ip):
    info(f"Pinging {ip}...")
    result = subprocess.run(
        ["ping", "-c", "3", "-W", "2", ip],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            if "packets" in line and "loss" in line:
                ok(line.strip())
                break
        return True
    fail("Ping failed — 100% packet loss")
    for line in result.stdout.splitlines():
        print(f"  {line}")
    return False


def test_arp(ip):
    info("Checking ARP table...")
    result = subprocess.run(["arp", "-a"], capture_output=True, text=True)
    for line in result.stdout.splitlines():
        if ip in line:
            if "(incomplete)" in line:
                fail(f"ARP incomplete: {line.strip()}")
                return False
            ok(f"ARP resolved: {line.strip()}")
            return True
    warn("Device not in ARP table")
    return False


def test_api(ip):
    info(f"Testing GET http://{ip}/api/status ...")
    url = f"http://{ip}/api/status"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read().decode()
            data = json.loads(body)

            ok(f"HTTP {resp.status} — {len(body)} bytes")
            print(f"  version:   {data.get('version')}")
            print(f"  ip:        {data.get('ip')}")
            print(f"  mac:       {data.get('mac')}")
            print(f"  uptime:    {data.get('uptime')}s")
            print(f"  link:      {data.get('link')}")
            print(f"  poe:       {data.get('poe')}")
            print(f"  partition: {data.get('partition')}")
            print(f"  board_id:  {data.get('board_id')}")
            return True
    except Exception as e:
        fail(f"API request failed: {e}")
        return False


def test_cors(ip):
    info("Testing CORS preflight (OPTIONS) ...")
    url = f"http://{ip}/api/status"
    try:
        req = urllib.request.Request(url, method="OPTIONS", headers={
            "Origin": "http://localhost:8080",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "X-Auth-Token",
        })
        with urllib.request.urlopen(req, timeout=5) as resp:
            acam = resp.headers.get("Access-Control-Allow-Methods", "")
            acah = resp.headers.get("Access-Control-Allow-Headers", "")
            acpn = resp.headers.get("Access-Control-Allow-Private-Network", "")
            ok(f"HTTP {resp.status} — Allow-Methods: {acam}")
            if "X-Auth-Token" in acah:
                ok("CORS allows X-Auth-Token header")
            if acpn == "true":
                ok("Private Network Access header present")
            return True
    except Exception as e:
        fail(f"CORS preflight failed: {e}")
        return False


def run_all_tests(ip):
    """Run all connectivity tests. Returns (passed, failed) counts."""
    tests = [
        ("Ping",           test_ping),
        ("ARP resolution", test_arp),
        ("API status",     test_api),
        ("CORS preflight", test_cors),
    ]

    passed = failed = 0
    print(f"\n{CYAN}── Running tests ──{RESET}\n")
    for name, fn in tests:
        try:
            if fn(ip):
                passed += 1
            else:
                failed += 1
        except Exception as e:
            fail(f"{name}: {e}")
            failed += 1

    print(f"\n{'='*50}")
    color = GREEN if failed == 0 else RED
    print(f"  {color}Results: {passed} passed, {failed} failed{RESET}")
    print(f"{'='*50}\n")
    return passed, failed


# ── OTA upload ───────────────────────────────────────────────────────────────

UF2_MAGIC_START0 = 0x0A324655
UF2_MAGIC_START1 = 0x9E5D5157
UF2_MAGIC_END    = 0x0AB16F30
# From pico-sdk boot/uf2.h. 0xe48bff57 is ABSOLUTE (unpartitioned / bootloader
# style), not the chip family. pico_package_uf2_output emits a single ABSOLUTE
# marker block at the head of an rp2350-arm-s image.
UF2_FAMILY_ABSOLUTE     = 0xE48BFF57
UF2_FAMILY_RP2350_ARM_S = 0xE48BFF59
UF2_FAMILY_RP2350_FAMILIES = {UF2_FAMILY_ABSOLUTE, UF2_FAMILY_RP2350_ARM_S}


def validate_uf2(data: bytes):
    """Basic client-side UF2 validation. Returns (num_blocks, family_id) or raises."""
    if len(data) % 512 != 0:
        raise ValueError(f"File size {len(data)} is not a multiple of 512 bytes")
    if len(data) < 512:
        raise ValueError("File is too small to be a UF2")

    import struct
    num_blocks = len(data) // 512
    # Check first block
    magic0, magic1 = struct.unpack_from("<II", data, 0)
    if magic0 != UF2_MAGIC_START0 or magic1 != UF2_MAGIC_START1:
        raise ValueError(f"Bad UF2 magic: 0x{magic0:08x} 0x{magic1:08x}")

    magic_end, = struct.unpack_from("<I", data, 508)
    if magic_end != UF2_MAGIC_END:
        raise ValueError(f"Bad UF2 end magic: 0x{magic_end:08x}")

    flags, = struct.unpack_from("<I", data, 8)
    family_id, = struct.unpack_from("<I", data, 28)

    # Check family ID if flag bit 13 is set
    if (flags & 0x2000) and family_id not in UF2_FAMILY_RP2350_FAMILIES:
        raise ValueError(f"Wrong UF2 family: 0x{family_id:08x} (expected RP2350)")

    return num_blocks, family_id


def ota_upload(ip, token, uf2_path):
    """Upload a UF2 over HTTP as a single POST.

    Sends the entire UF2 in one request with both X-OTA-Start and
    X-OTA-Finish set. The device's handle_upload_data accumulates body
    bytes from however many TCP packets lwIP delivers them in — the
    HTTP-layer chunking that this function used to do gave nothing
    beyond what TCP windowing already provides, and forced the same
    UF2 through 47 short-lived connections. With one POST: one TCP
    handshake, one in-flight HTTP request, no PCB churn, and OTA
    completes in ~10 s for a 380 KB image. The previous chunked
    design predates the current TCP_WND tuning; with TCP_WND≈17 KB the
    "single large POST hangs RMII" concern in OTA.md no longer holds.

    Plain HTTP only. The TLS path can't sustain a long incoming stream
    yet (mbedtls record buffering); browser-based OTA over HTTPS is a
    follow-up. CLI clients are LAN-local so the integrity comes from
    the bootrom hash check on the signed UF2, not from transport TLS.
    """
    import urllib.request

    info(f"Reading {uf2_path}...")
    with open(uf2_path, "rb") as f:
        data = f.read()

    num_blocks, family_id = validate_uf2(data)
    ok(f"Valid UF2: {num_blocks} blocks, {len(data) / 1024:.1f} KB, family 0x{family_id:08x}")

    # Pre-flight: confirm the device is reachable + on a real partition
    info(f"Checking device at {ip}...")
    try:
        req = urllib.request.Request(f"http://{ip}/api/status",
                                     headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            status_data = json.loads(resp.read().decode())
            ok(f"Device online — v{status_data.get('version', '?')}, "
               f"partition {status_data.get('partition', '?')}")
    except Exception as e:
        fail(f"Device unreachable: {e}")
        return False

    total = len(data)
    info(f"Uploading {total} bytes as a single POST ...")

    headers = {
        "Content-Type": "application/octet-stream",
        "X-Auth-Token": token,
        "X-OTA-Start": "1",
        "X-OTA-Finish": "1",
        "Content-Length": str(total),
    }
    req = urllib.request.Request(f"http://{ip}/api/upload",
                                 data=data, method="POST", headers=headers)

    # Generous timeout — single POST takes ~upload_time + flash_program_time
    # (a few seconds for a typical UF2). 60 s leaves slack for slow links.
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode()
            result = json.loads(body)
            if not result.get("ok"):
                fail(f"Upload rejected: {body}")
                return False
            ok("Upload acknowledged; device rebooting into new image")
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode()
        except Exception:
            body = ""
        fail(f"HTTP {e.code}: {body}")
        return False
    except Exception as e:
        # The device calls reboot() inside its 200 OK response on
        # X-OTA-Finish. The TCP connection drops before we read the
        # body — that's success, not failure.
        if ("Connection reset" in str(e)
                or "RemoteDisconnected" in str(e)
                or "timed out" in str(e)):
            warn("Connection reset on response (device rebooting — expected)")
        else:
            fail(f"Upload failed: {e}")
            return False

    info("Device is rebooting with new firmware...")

    # Wait for device to come back
    time.sleep(8)
    if wait_for_boot(ip, timeout=20):
        # Check the new version
        try:
            req = urllib.request.Request(
                f"http://{ip}/api/status",
                headers={"Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                new_status = json.loads(resp.read().decode())
                ok(f"Device back online — v{new_status.get('version', '?')}, "
                   f"partition {new_status.get('partition', '?')}")
        except Exception:
            ok("Device back online")
        return True
    else:
        fail("Device did not come back after OTA update")
        return False


# ── picotool wrappers ────────────────────────────────────────────────────────

def picotool_load(picotool, uf2_path, partition=None, ignore_pt=False, force=False):
    """Run `picotool load [-p N | --ignore-partitions] [-f] -F <uf2>`."""
    parts = [picotool, "load"]
    if ignore_pt:
        parts.append("--ignore-partitions")
    elif partition is not None:
        parts += ["-p", str(partition)]
    if force:
        parts.append("-f")
    parts += ["-F", uf2_path]
    _run(" ".join(parts))


def picotool_reboot(picotool, partition=None, force=False, bootsel=False):
    """Run `picotool reboot [-u] [-g N] [-f]`."""
    parts = [picotool, "reboot"]
    if bootsel:
        parts.append("-u")
    if partition is not None:
        parts += ["-g", str(partition)]
    if force:
        parts.append("-f")
    _run(" ".join(parts))


def picotool_info(picotool):
    """Capture `picotool info -a` and `picotool partition info`."""
    info("Running picotool info -a ...")
    r1 = subprocess.run(f"{picotool} info -a", shell=True,
                        capture_output=True, text=True)
    print(r1.stdout)
    if r1.stderr.strip():
        print(r1.stderr, file=sys.stderr)

    info("Running picotool partition info ...")
    r2 = subprocess.run(f"{picotool} partition info", shell=True,
                        capture_output=True, text=True)
    print(r2.stdout)
    if r2.stderr.strip():
        print(r2.stderr, file=sys.stderr)

    return {"info": r1.stdout, "partition_info": r2.stdout}


def picotool_erase_all(picotool):
    """Run `picotool erase -a`. Used to establish a known-clean state before
    the first-time provision — otherwise stale images in either partition can
    be picked by the RP2350 A/B selector in preference to the freshly seeded
    one."""
    info("Erasing all flash (clean slate for provisioning) ...")
    _run(f"{picotool} erase -a")


# ── A/B provisioning and OTA cycle ───────────────────────────────────────────

def _get_status(ip, timeout=5):
    url = f"http://{ip}/api/status"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def provision_clean(picotool, pt_uf2, app_uf2, ip):
    """Clean first install (ROM-native A/B, no custom bootloader).

      1. Erase all of flash.
      2. Flash a 512-byte singleton partition-table UF2 at flash[0].
      3. Reboot into BOOTSEL so the bootrom registers the PT and picotool's
         view refreshes — without this, `picotool load -p N` errors with
         "no partition table on the device".
      4. Flash the app into partition A. Unpartitioned space holds only the
         PT (no image), so the RP2350 bootrom boots partition A natively.
      5. Reboot.
    """
    if not os.path.isfile(pt_uf2):
        fail(f"Partition-table UF2 not found: {pt_uf2}")
        return False
    if not os.path.isfile(app_uf2):
        fail(f"App UF2 not found: {app_uf2}")
        return False

    picotool_erase_all(picotool)

    info("Flashing singleton partition table ...")
    picotool_load(picotool, pt_uf2)

    info("Rebooting to BOOTSEL so the bootrom registers the PT ...")
    picotool_reboot(picotool, bootsel=True, force=True)
    time.sleep(2)

    info("Seeding application into partition A ...")
    picotool_load(picotool, app_uf2, partition=0)

    info("Rebooting (ROM boots partition A natively) ...")
    picotool_reboot(picotool)

    info("Waiting 10s for boot ...")
    time.sleep(10)

    if not wait_for_boot(ip, timeout=20):
        fail("Device did not become reachable after provisioning")
        return False

    try:
        status = _get_status(ip)
    except Exception as e:
        fail(f"Could not read /api/status: {e}")
        return False

    partition = status.get("partition", "?")
    version = status.get("version", "?")
    if partition != "A":
        fail(f"Partition is {partition!r}, expected 'A' (version {version})")
        return False
    ok(f"Provisioned — partition A, v{version}")
    return True


def ota_commit(ip, token, timeout=5):
    """POST /api/commit with the auth token. Returns the parsed JSON.

    The device only clears its TBYB-pending state (makes the new image the
    permanent boot choice) when this call succeeds. Before that, any reset
    — power cycle, watchdog, /api/reboot — causes the RP2350 ROM to fall
    back to the previous partition."""
    import urllib.request
    req = urllib.request.Request(
        f"http://{ip}/api/commit",
        data=b"",
        method="POST",
        headers={"X-Auth-Token": token, "Content-Length": "0"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def ab_cycle(ip, token, next_uf2_path):
    """OTA a new UF2 and commit it. Returns bool.

    Post-upload outcomes:
      1. Success — partition flipped, version changed to the new image, and
         the device accepted /api/commit. The image is now permanent.
      2. Rollback — partition stayed on the original. Means the new image
         crashed/wedged so hard that the device reset before we could see
         it, and the ROM rolled back. Device is healthy on the old image.
      3. Stuck — device unreachable after boot. Probably requires a power
         cycle; on the next power cycle the ROM rolls back to the previous
         image because we never committed.
      4. Commit failed — device came back on the new image but refused the
         commit. Indicates a bootrom issue (or the image wasn't actually
         TBYB-pending). Flagged explicitly; a subsequent reboot will roll
         back.
    """
    if not os.path.isfile(next_uf2_path):
        fail(f"UF2 not found: {next_uf2_path}")
        return False

    try:
        pre = _get_status(ip)
    except Exception as e:
        fail(f"Pre-upload status failed: {e}")
        return False

    pre_partition = pre.get("partition", "?")
    pre_version = pre.get("version", "?")
    info(f"Before: partition {pre_partition}, v{pre_version}")

    if pre_partition not in ("A", "B"):
        fail(f"Device is not on an A/B partition (got {pre_partition!r}). "
             "Run `conduit provision` first.")
        return False

    if not ota_upload(ip, token, next_uf2_path):
        return False

    try:
        post = _get_status(ip)
    except Exception as e:
        fail(f"Post-upload status failed — device may be stuck: {e}")
        return False

    post_partition = post.get("partition", "?")
    post_version = post.get("version", "?")
    tbyb_pending = post.get("tbyb_pending", False)
    boot_type = post.get("boot_type", "?")
    info(f"After:  partition {post_partition}, v{post_version}, "
         f"boot_type={boot_type}, tbyb_pending={tbyb_pending}")

    expected = "B" if pre_partition == "A" else "A"
    partition_flipped = (post_partition == expected)
    version_changed = (post_version != pre_version)

    # Rollback case: device came back on the old image.
    if not partition_flipped and not version_changed \
            and post_partition == pre_partition \
            and post_version == pre_version:
        fail(f"OTA rolled back to {pre_partition}/v{pre_version} — the new "
             "image reset before it could be committed (watchdog fire or "
             "crash). Old firmware is still running.")
        return False

    if not partition_flipped:
        fail(f"Partition did not flip: expected {expected}, got {post_partition!r}")
        return False
    if not version_changed:
        fail(f"Version did not change: still {post_version!r}")
        return False

    # New image is up and reachable. Commit it so future reboots treat it
    # as permanent. Older firmware (<=v1.0.14 on this board) committed via
    # a 5s timer and doesn't implement /api/commit; treat a 404 there as
    # "nothing to do" so we stay backward-compatible.
    info("Committing image via /api/commit ...")
    try:
        commit_result = ota_commit(ip, token)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            warn("Device has no /api/commit endpoint — assuming legacy "
                 "timer-based commit. A/B cycle cannot positively confirm.")
            ok(f"A/B cycle (unconfirmed): {pre_partition}→{post_partition}, "
               f"{pre_version}→{post_version}")
            return True
        fail(f"/api/commit HTTP {e.code}: {e.read().decode(errors='replace')}")
        return False
    except Exception as e:
        fail(f"/api/commit failed: {e}")
        return False

    if commit_result.get("committed") is True:
        ok(f"A/B cycle passed: {pre_partition}→{post_partition}, "
           f"{pre_version}→{post_version}, committed")
        return True
    if commit_result.get("ok") and commit_result.get("committed") is False:
        # Image wasn't in TBYB-pending state (e.g., upgraded from a pre-TBYB
        # firmware that doesn't trigger REBOOT2_FLAG_REBOOT_TYPE_FLASH_UPDATE).
        warn(f"Device reported nothing to commit ({commit_result.get('message','')})")
        ok(f"A/B cycle passed (no commit needed): {pre_partition}→{post_partition}, "
           f"{pre_version}→{post_version}")
        return True
    fail(f"Commit refused: {commit_result}")
    return False
