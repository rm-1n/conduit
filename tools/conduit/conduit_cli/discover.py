"""UDP-multicast device discovery.

Listens for the once-per-second beacons that CONDUIT firmware emits
(see firmware/app/discovery.c). Each datagram is a single JSON
object with keys ``id`` (per-device unique-id), ``ip`` (the device's
current LAN IP), ``name`` (free-form label, may be empty), and
``v`` (firmware version string).

Group + port mirror discovery.c; if you change them, change both.

The listener is split from the CLI subcommand so tests can drive it
with a fake socket — see ``listen_for_devices``'s ``recv_factory``
parameter.
"""

from __future__ import annotations

import json
import socket
import struct
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass

# Mirrors firmware/app/discovery.c:
#   #define DISCOVERY_MCAST_ADDR "239.255.42.42"
#   #define DISCOVERY_MCAST_PORT 5354
DISCOVERY_GROUP = "239.255.42.42"
DISCOVERY_PORT = 5354


@dataclass(frozen=True)
class DiscoveredDevice:
    """One CONDUIT device's most-recent beacon."""
    unique_id: str
    ip: str
    name: str
    version: str
    last_seen: float    # unix timestamp


def _open_default_socket(port: int, group: str) -> socket.socket:
    """Bind a UDP socket and join the multicast group on every interface.

    Split out so tests can inject a fake — pass a different
    ``recv_factory`` to ``listen_for_devices``. Production callers
    use this default.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    # Allow several listeners on the same host (e.g. a dev tool +
    # a long-running daemon) without "Address already in use".
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if hasattr(socket, "SO_REUSEPORT"):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
    sock.bind(("", port))
    # IP_ADD_MEMBERSHIP joins the group on the default interface
    # (INADDR_ANY); on multi-homed hosts the kernel still routes
    # packets from any interface that received the multicast.
    mreq = struct.pack("4s4s", socket.inet_aton(group),
                       socket.inet_aton("0.0.0.0"))
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
    return sock


def _parse_beacon(raw: bytes, addr: tuple[str, int]) -> DiscoveredDevice | None:
    """Decode one received datagram.

    Returns None for malformed payloads — callers loop, they
    shouldn't crash on a stray packet from something else on the
    multicast group.
    """
    try:
        obj = json.loads(raw.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(obj, dict):
        return None
    uid = obj.get("id")
    if not isinstance(uid, str) or not uid:
        return None
    # Prefer the firmware-reported IP (which is what hostnames will
    # encode), but fall back to the packet's source IP if for some
    # reason the firmware's payload omitted it. Both should match in
    # practice since the same lwIP netif is the source of truth.
    ip = obj.get("ip")
    if not isinstance(ip, str) or not ip:
        ip = addr[0]
    return DiscoveredDevice(
        unique_id=uid,
        ip=ip,
        name=str(obj.get("name", "")),
        version=str(obj.get("v", "")),
        last_seen=time.time(),
    )


def listen_for_devices(
    timeout_s: float,
    *,
    recv_factory: Callable[[], socket.socket] | None = None,
    on_raw: Callable[[bytes, tuple[str, int]], None] | None = None,
) -> Iterator[DiscoveredDevice]:
    """Yield every beacon received within ``timeout_s`` seconds.

    Same device beacons multiple times during the listen window —
    callers that want a unique-by-id snapshot should consume into a
    dict keyed on ``unique_id``. We don't dedupe inside the
    generator so callers still see liveness pings.

    ``recv_factory`` returns a connected, group-joined socket. The
    default opens a real one; tests pass a fake whose ``recvfrom``
    feeds canned packets. The socket is closed when the generator
    exits.

    ``on_raw`` is called for every packet received before parsing —
    useful for `--verbose` debugging where the user wants to see
    "we received N bytes from <src>" even when the parse fails.
    """
    factory = recv_factory or (lambda: _open_default_socket(DISCOVERY_PORT, DISCOVERY_GROUP))
    sock = factory()
    deadline = time.monotonic() + timeout_s
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(remaining)
            try:
                raw, addr = sock.recvfrom(4096)
            except socket.timeout:
                break
            except OSError:
                # Fake sockets in tests raise this to signal "no more packets".
                break
            if on_raw is not None:
                on_raw(raw, addr)
            dev = _parse_beacon(raw, addr)
            if dev is not None:
                yield dev
    finally:
        try:
            sock.close()
        except OSError:
            pass


def collect_unique_devices(
    timeout_s: float,
    *,
    recv_factory: Callable[[], socket.socket] | None = None,
) -> list[DiscoveredDevice]:
    """Listen for the window, return one entry per unique-id (most recent).

    Convenience for the `conduit discover` subcommand which prints a
    flat table.
    """
    by_id: dict[str, DiscoveredDevice] = {}
    for dev in listen_for_devices(timeout_s, recv_factory=recv_factory):
        by_id[dev.unique_id] = dev
    return list(by_id.values())
