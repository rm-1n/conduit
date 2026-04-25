#!/usr/bin/env python3
"""
flash_and_test.py — Build, flash, and test the PICO-POE firmware.

Usage:
    python3 flash_and_test.py                # build + flash + test
    python3 flash_and_test.py --flash-only   # build + flash, skip tests
    python3 flash_and_test.py --test-only    # skip build/flash, just test
    python3 flash_and_test.py --serial       # also capture serial output after flash

Environment:
    PICO_SDK_PATH   — path to Pico SDK   (default: ~/.pico-sdk/sdk/2.2.0)
    PICOTOOL        — path to picotool    (default: ~/.pico-sdk/picotool/2.2.0-a4/picotool/picotool)
    TOOLCHAIN_PATH  — GCC toolchain bin   (default: ~/.pico-sdk/toolchain/14_2_Rel1/bin)
    DEVICE_IP       — static IP of device (default: 192.168.178.200)
    SERIAL_PORT     — USB serial device   (default: /dev/cu.usbmodem1101)
"""

import argparse
import json
import os
import select
import subprocess
import sys
import time
import urllib.request

# ── Defaults (override via environment) ─────────────────────────────────────

HOME = os.path.expanduser("~")
PICO_SDK_PATH  = os.environ.get("PICO_SDK_PATH",  f"{HOME}/.pico-sdk/sdk/2.2.0")
PICOTOOL       = os.environ.get("PICOTOOL",        f"{HOME}/.pico-sdk/picotool/2.2.0-a4/picotool/picotool")
TOOLCHAIN_BIN  = os.environ.get("TOOLCHAIN_PATH",  f"{HOME}/.pico-sdk/toolchain/14_2_Rel1/bin")
DEVICE_IP      = os.environ.get("DEVICE_IP",       "192.168.178.200")
SERIAL_PORT    = os.environ.get("SERIAL_PORT",     "/dev/cu.usbmodem1101")

FIRMWARE_DIR   = os.path.dirname(os.path.abspath(__file__))
BUILD_DIR      = os.path.join(FIRMWARE_DIR, "build")
UF2_PATH       = os.path.join(BUILD_DIR, "app", "pico_poe_app.uf2")

# ── Helpers ─────────────────────────────────────────────────────────────────

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

def run(cmd, env=None, cwd=None, check=True):
    """Run a command, stream output, return completed process."""
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

# ── Build ───────────────────────────────────────────────────────────────────

def build():
    info("Building firmware...")
    env = os.environ.copy()
    env["PICO_SDK_PATH"] = PICO_SDK_PATH
    env["PATH"] = f"{TOOLCHAIN_BIN}:{env['PATH']}"

    ncpu = os.cpu_count() or 4
    run(f"cmake --build build -j{ncpu}", env=env, cwd=FIRMWARE_DIR)

    if not os.path.isfile(UF2_PATH):
        fail(f"UF2 not found at {UF2_PATH}")
        sys.exit(1)
    ok(f"Build complete: {os.path.basename(UF2_PATH)}")

# ── Flash ───────────────────────────────────────────────────────────────────

def flash():
    info("Flashing firmware via picotool...")
    run(f"{PICOTOOL} load -F {UF2_PATH}")
    ok("Firmware loaded")

    info("Rebooting into application mode...")
    run(f"{PICOTOOL} reboot")
    ok("Reboot command sent")

# ── Serial capture ──────────────────────────────────────────────────────────

def capture_serial(duration=12, boot_wait=8):
    """Capture serial output from the Pico after a reboot."""
    info(f"Waiting {boot_wait}s for boot, then capturing serial for {duration}s...")
    time.sleep(boot_wait)

    try:
        fd = os.open(SERIAL_PORT, os.O_RDONLY | os.O_NONBLOCK)
    except OSError as e:
        warn(f"Cannot open {SERIAL_PORT}: {e}")
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

# ── Network tests ───────────────────────────────────────────────────────────

def wait_for_boot(timeout=20):
    """Wait for the device to become pingable."""
    info(f"Waiting for {DEVICE_IP} to respond to ping (up to {timeout}s)...")
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", "1", DEVICE_IP],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            # Extract RTT from output
            for line in result.stdout.splitlines():
                if "round-trip" in line or "rtt" in line:
                    ok(f"Ping OK — {line.strip()}")
                    return True
            ok("Ping OK")
            return True
        time.sleep(1)
    fail(f"Device did not respond to ping within {timeout}s")
    return False

def test_ping():
    info(f"Pinging {DEVICE_IP}...")
    result = subprocess.run(
        ["ping", "-c", "3", "-W", "2", DEVICE_IP],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        for line in result.stdout.splitlines():
            if "packets" in line and "loss" in line:
                ok(line.strip())
                break
        return True
    else:
        fail("Ping failed — 100% packet loss")
        for line in result.stdout.splitlines():
            print(f"  {line}")
        return False

def test_api():
    info(f"Testing GET http://{DEVICE_IP}/api/status ...")
    url = f"http://{DEVICE_IP}/api/status"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            status = resp.status
            body = resp.read().decode()
            data = json.loads(body)

            ok(f"HTTP {status} — {len(body)} bytes")
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

def test_cors():
    info(f"Testing CORS preflight (OPTIONS) ...")
    url = f"http://{DEVICE_IP}/api/status"
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

def test_arp():
    info("Checking ARP table...")
    result = subprocess.run(["arp", "-a"], capture_output=True, text=True)
    for line in result.stdout.splitlines():
        if DEVICE_IP in line:
            if "(incomplete)" in line:
                fail(f"ARP incomplete: {line.strip()}")
                return False
            else:
                ok(f"ARP resolved: {line.strip()}")
                return True
    warn("Device not in ARP table")
    return False

# ── Main ────────────────────────────────────────────────────────────────────

def main():
    global DEVICE_IP

    parser = argparse.ArgumentParser(description="Build, flash, and test PICO-POE firmware")
    parser.add_argument("--flash-only", action="store_true", help="Build and flash, skip tests")
    parser.add_argument("--test-only",  action="store_true", help="Skip build/flash, just run tests")
    parser.add_argument("--serial",     action="store_true", help="Capture serial output after flash")
    parser.add_argument("--ip",         default=DEVICE_IP,   help=f"Device IP (default: {DEVICE_IP})")
    args = parser.parse_args()

    DEVICE_IP = args.ip

    print(f"\n{'='*50}")
    print(f"  PICO-POE Flash & Test")
    print(f"  Device IP: {DEVICE_IP}")
    print(f"{'='*50}\n")

    passed = 0
    failed = 0

    if not args.test_only:
        build()
        flash()

        if args.serial:
            capture_serial()

    if not args.flash_only:
        # Wait for device to boot and become reachable
        boot_wait = 0 if args.test_only else 10
        if boot_wait:
            info(f"Waiting {boot_wait}s for device to boot...")
            time.sleep(boot_wait)

        if not wait_for_boot(timeout=15):
            fail("Device unreachable — aborting tests")
            sys.exit(1)

        tests = [
            ("Ping",            test_ping),
            ("ARP resolution",  test_arp),
            ("API status",      test_api),
            ("CORS preflight",  test_cors),
        ]

        print(f"\n{CYAN}── Running tests ──{RESET}\n")
        for name, fn in tests:
            try:
                if fn():
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

    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
