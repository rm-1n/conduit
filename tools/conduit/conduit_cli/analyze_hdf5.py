"""Gap / cadence analysis for IDE-exported HDF5 telemetry recordings.

The IDE's HDF5 export layout (see web/log_export.js) is:
  /telemetry/<NAME>/values     <dtype>[M] or <dtype>[M, n]
  /telemetry/<NAME>/uptime_us  float[M] — device microseconds since boot
  /telemetry/<NAME>/wall_ms    float[M] — wall-clock estimate (ms since epoch)
  attrs on /telemetry/<NAME>   : dtype, n, record_count
  attrs on root                : exported_iso, asset_version,
                                 telemetry_channel_count,
                                 telemetry_record_count

This module reads an export, computes per-channel inter-sample deltas
from `uptime_us`, and reports:
  - record count, duration, observed cadence (min/median/p99/max)
  - count of gaps above a threshold (default: max(4 × median, 100 ms))
  - histogram of gaps by duration bucket
  - top-N worst gaps with wall-clock context
  - cross-channel synchrony (if multiple channels gap in lockstep,
    the producer is the source; if they drift independently, the
    drop is wire- or consumer-side)
  - storage-dtype audit (the export pipeline silently downcasts
    float64 → float32 in some h5wasm paths; we surface it so future
    `<f8` regressions are visible)

Importable from tests; CLI wrapper in conduit_cli/cli.py wires it as
`conduit analyze-hdf5 <path>`.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Optional

try:
    import h5py
    import numpy as np
except ImportError as e:                # pragma: no cover — surfaced at CLI time
    h5py = None                          # type: ignore[assignment]
    np = None                            # type: ignore[assignment]
    _IMPORT_ERR = e
else:
    _IMPORT_ERR = None


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class ChannelStats:
    """Per-channel analysis result.

    Time fields are in microseconds (delta_us…) or milliseconds
    (wall_first_ms, wall_last_ms) so the JSON output matches the
    HDF5's native unit choices and can be diffed across runs without
    unit-conversion drift.
    """

    name: str
    record_count: int
    duration_s: float
    avg_rate_hz: float

    delta_us_min: int
    delta_us_median: int
    delta_us_mean: int
    delta_us_max: int
    delta_us_p99: int
    delta_us_p99_99: int

    wall_first_ms: float
    wall_last_ms: float

    storage_dtype: str
    expected_dtype: str = '<f8'

    threshold_us: int = 0
    gap_count: int = 0
    gap_buckets: dict = field(default_factory=dict)
    top_gaps: list = field(default_factory=list)

    negative_delta_count: int = 0
    negative_deltas: list = field(default_factory=list)

    lost_records_est: int = 0
    lost_time_s: float = 0.0
    lost_fraction: float = 0.0

    notes: list = field(default_factory=list)


@dataclass
class AnalysisResult:
    path: str
    root_attrs: dict
    channels: list[ChannelStats]
    synchrony: Optional[dict] = None


# ---------------------------------------------------------------------------
# Analysis helpers
# ---------------------------------------------------------------------------


# Bucket edges (seconds) for the gap histogram. Picked to cover the
# regimes we typically care about: sub-second (jitter), 1–30 s
# (reconnect blips), and longer (real outages / reboots).
DEFAULT_BUCKETS_S = [0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0,
                    300.0, 3600.0, 86400.0]


def _format_duration(seconds: float) -> str:
    s = float(seconds)
    if s < 1e-3: return f'{s*1e6:.0f}us'
    if s < 1:    return f'{s*1e3:.2f}ms'
    if s < 60:   return f'{s:.2f}s'
    if s < 3600: return f'{s/60:.1f}min'
    return f'{s/3600:.2f}h'


def _format_wall_ms(ms: float) -> str:
    """Format a wall-clock ms-since-epoch as a UTC ISO string. Float32-
    encoded timestamps quantize to ~131 s near 2026; we still surface
    the precision we have, with a note in the per-channel `notes`."""
    return datetime.fromtimestamp(float(ms) / 1000.0, tz=timezone.utc) \
                   .isoformat(timespec='milliseconds') \
                   .replace('+00:00', 'Z')


def _analyze_channel(name: str, grp: 'h5py.Group',
                     threshold_us: Optional[int],
                     top_n: int,
                     bucket_edges_s: list[float]) -> ChannelStats:
    upt_ds = grp['uptime_us']
    wms_ds = grp['wall_ms']
    storage_dtype = upt_ds.dtype.str
    # Promote to float64 immediately to make np.diff / percentile
    # numerically well-behaved regardless of on-disk dtype.
    upt = upt_ds[:].astype(np.float64)
    wms = wms_ds[:].astype(np.float64)
    M = int(upt.size)

    notes: list[str] = []
    # The IDE's export pipeline declared <f8 (float64) but some h5wasm
    # builds silently downcast to <f4 (float32). Surface the loss of
    # precision because it makes uptime deltas snap to the float32 ULP
    # (≈ 1024–4096 us at 8 h+ uptimes) — the "cadence" we observe in
    # such a file is then quantized to ULP boundaries, not the real
    # transmit rate.
    if storage_dtype not in ('<f8', '>f8'):
        notes.append(
            f'storage_dtype={storage_dtype!r} — expected <f8; '
            f'float32 precision quantizes uptime to ~2^N us '
            f'(loses sub-ms cadence)'
        )

    if M < 2:
        return ChannelStats(
            name=name, record_count=M, duration_s=0.0, avg_rate_hz=0.0,
            delta_us_min=0, delta_us_median=0, delta_us_mean=0,
            delta_us_max=0, delta_us_p99=0, delta_us_p99_99=0,
            wall_first_ms=0.0, wall_last_ms=0.0,
            storage_dtype=storage_dtype,
            threshold_us=0,
            notes=notes + ['fewer than 2 records — no deltas computable'],
        )

    d = np.diff(upt)                     # microseconds, float64

    median = int(np.median(d))
    eff_threshold_us = int(threshold_us) if threshold_us is not None \
        else int(max(median * 4, 100_000))    # 100 ms minimum

    duration_s = float((wms[-1] - wms[0]) / 1000.0)
    rate = M / duration_s if duration_s > 0 else 0.0

    neg_idx = np.where(d < 0)[0]
    negative_deltas = [
        {'idx': int(i),
         'jump_s': float(d[i] / 1e6),
         'prev_uptime_us': float(upt[i]),
         'next_uptime_us': float(upt[i + 1]),
         'wall_ms': float(wms[i + 1])}
        for i in neg_idx[:10]
    ]

    gap_mask = d > eff_threshold_us
    gap_idx = np.where(gap_mask)[0]
    gap_count = int(gap_idx.size)

    buckets: dict[str, int] = {}
    for hi in bucket_edges_s:
        label = f'>{_format_duration(hi)}'
        buckets[label] = int(np.sum(d > hi * 1_000_000))

    if gap_count:
        worst_order = np.argsort(d)[::-1][:max(top_n, 1)]
        top_gaps = [
            {'idx': int(i),
             'gap_s': float(d[i] / 1e6),
             'gap_str': _format_duration(d[i] / 1e6),
             'wall_before': _format_wall_ms(wms[i]),
             'wall_after':  _format_wall_ms(wms[i + 1])}
            for i in worst_order
        ]
    else:
        top_gaps = []

    # If the cadence held perfectly, each gap should have produced
    # gap_us/median records. The difference is records "missing".
    if median > 0 and gap_count:
        gap_us = d[gap_mask]
        lost_records = int(np.sum(np.maximum(0, gap_us / median - 1)))
        lost_time_s = float(gap_us.sum() / 1e6)
    else:
        lost_records = 0
        lost_time_s = 0.0
    lost_fraction = (lost_time_s / duration_s) if duration_s > 0 else 0.0

    return ChannelStats(
        name=name,
        record_count=M,
        duration_s=duration_s,
        avg_rate_hz=rate,
        delta_us_min=int(d.min()),
        delta_us_median=median,
        delta_us_mean=int(d.mean()),
        delta_us_max=int(d.max()),
        delta_us_p99=int(np.percentile(d, 99)),
        delta_us_p99_99=int(np.percentile(d, 99.99)),
        wall_first_ms=float(wms[0]),
        wall_last_ms=float(wms[-1]),
        storage_dtype=storage_dtype,
        threshold_us=eff_threshold_us,
        gap_count=gap_count,
        gap_buckets=buckets,
        top_gaps=top_gaps,
        negative_delta_count=int(neg_idx.size),
        negative_deltas=negative_deltas,
        lost_records_est=lost_records,
        lost_time_s=lost_time_s,
        lost_fraction=lost_fraction,
        notes=notes,
    )


def _cross_channel_synchrony(per_channel: list[ChannelStats]) -> Optional[dict]:
    """Cross-channel lockstep tells us 'a shared pipeline component
    stalled' — NOT specifically producer-side. The shared components
    that can stall together include:

      - the device's user-code emit loop (producer-side)
      - the firmware's 64 KB data_buffer ring (overwrites silently
        when the consumer falls > 64 KB behind — see
        firmware/app/data_buffer.c:190-193)
      - the WS / TLS layer
      - the browser's WebSocket inbound queue (during a main-thread
        stall)
      - telemetry.js's drain() + dataStore.append() pipeline

    Per-channel-independent gaps would imply wire-level packet loss
    affecting one channel and not the other, which is rare on
    in-order TCP. So lockstep is the *expected* shape regardless of
    where in the pipeline the stall occurred; non-lockstep is the
    surprise. This function reports the lockstep fraction; the
    *cause* needs the firmware-side eviction counter (proposed) or
    a browser-side perf trace to disambiguate."""
    if len(per_channel) < 2:
        return None

    # Bucket each channel's gap-start wall_ms onto a coarse grid (1 s)
    # so float-precision wobble doesn't desync genuine same-event
    # gaps across channels.
    sets: list[set[int]] = []
    for ch in per_channel:
        if not ch.top_gaps:
            sets.append(set())
            continue
        sets.append({int(_iso_to_sec(g['wall_before'])) for g in ch.top_gaps})

    if any(s for s in sets):
        common = set.intersection(*sets) if all(sets) else set()
        return {
            'channels':         [c.name for c in per_channel],
            'top_n_per_channel': [len(s) for s in sets],
            'common_wall_seconds': sorted(common),
            'lockstep_fraction':   (
                len(common) / min(len(s) for s in sets if s)
                if any(s for s in sets) else 0.0
            ),
        }
    return None


def _iso_to_sec(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp())


# ---------------------------------------------------------------------------
# Top-level entry
# ---------------------------------------------------------------------------


def analyze(path: str,
            channel_filter: Optional[list[str]] = None,
            threshold_us: Optional[int] = None,
            top_n: int = 10,
            bucket_edges_s: Optional[list[float]] = None) -> AnalysisResult:
    """Open `path` and return a structured AnalysisResult."""
    if h5py is None:
        raise RuntimeError(
            "h5py is not installed. Reinstall with "
            "`pip install -e '.[analysis]'` from tools/conduit, or "
            f"directly with `pip install h5py numpy`. Original error: {_IMPORT_ERR}"
        )
    bucket_edges_s = bucket_edges_s or DEFAULT_BUCKETS_S

    with h5py.File(path, 'r') as f:
        root_attrs = {}
        for k in f.attrs:
            v = f.attrs[k]
            if isinstance(v, bytes):
                v = v.decode('utf-8', errors='replace')
            elif isinstance(v, np.integer):
                v = int(v)
            elif isinstance(v, np.floating):
                v = float(v)
            root_attrs[str(k)] = v

        per_channel: list[ChannelStats] = []
        tlm = f.get('telemetry')
        if tlm is None:
            return AnalysisResult(path=path, root_attrs=root_attrs, channels=[])
        for name in sorted(tlm):
            if channel_filter and name not in channel_filter:
                continue
            grp = tlm[name]
            per_channel.append(_analyze_channel(
                name=name, grp=grp,
                threshold_us=threshold_us,
                top_n=top_n,
                bucket_edges_s=bucket_edges_s,
            ))

    return AnalysisResult(
        path=path, root_attrs=root_attrs, channels=per_channel,
        synchrony=_cross_channel_synchrony(per_channel),
    )


# ---------------------------------------------------------------------------
# CLI / text rendering
# ---------------------------------------------------------------------------


def _render_text(result: AnalysisResult) -> str:
    lines: list[str] = []
    lines.append(f'HDF5 gap analysis — {result.path}')
    lines.append('=' * 78)
    lines.append('Root attrs:')
    for k, v in result.root_attrs.items():
        lines.append(f'  {k:32s} {v}')

    for ch in result.channels:
        lines.append('')
        lines.append(f'/telemetry/{ch.name}')
        lines.append('-' * 78)
        lines.append(f'  records          : {ch.record_count:,}')
        if ch.record_count >= 2:
            lines.append(f'  duration         : {_format_duration(ch.duration_s)}')
            lines.append(f'  avg rate         : {ch.avg_rate_hz:.2f} Hz')
            lines.append(f'  wall span        : {_format_wall_ms(ch.wall_first_ms)}  →  '
                         f'{_format_wall_ms(ch.wall_last_ms)}')
            lines.append(
                f'  delta_us         : min={ch.delta_us_min:,}  '
                f'median={ch.delta_us_median:,}  mean={ch.delta_us_mean:,}  '
                f'max={ch.delta_us_max:,}  p99={ch.delta_us_p99:,}  '
                f'p99.99={ch.delta_us_p99_99:,}')
            lines.append(f'  storage dtype    : {ch.storage_dtype}  (expected {ch.expected_dtype})')

            if ch.negative_delta_count:
                lines.append(f'  ⚠  reboots/wraps  : {ch.negative_delta_count} (uptime went backwards)')
                for n in ch.negative_deltas:
                    lines.append(
                        f'      idx={n["idx"]:,}  jump={n["jump_s"]:.2f}s  '
                        f'wall={_format_wall_ms(n["wall_ms"])}')

            lines.append(
                f'  gap threshold    : >{_format_duration(ch.threshold_us / 1e6)} '
                f'(={ch.threshold_us:,} us)')
            lines.append(f'  gap count        : {ch.gap_count}')
            for label, count in ch.gap_buckets.items():
                lines.append(f'    {label:<10}        : {count}')

            if ch.gap_count:
                lines.append(
                    f'  lost records est : {ch.lost_records_est:,}  '
                    f'({ch.lost_records_est / ch.record_count * 100:.2f}% of received)')
                lines.append(
                    f'  lost time        : {_format_duration(ch.lost_time_s)}  '
                    f'({ch.lost_fraction * 100:.3f}% of recording)')

                lines.append('  TOP gaps:')
                for g in ch.top_gaps:
                    lines.append(
                        f'    idx={g["idx"]:>10,}  gap={g["gap_str"]:>9s}  '
                        f'before={g["wall_before"]}  after={g["wall_after"]}')

        for note in ch.notes:
            lines.append(f'  note: {note}')

    if result.synchrony:
        lines.append('')
        lines.append('Cross-channel synchrony:')
        lines.append('-' * 78)
        s = result.synchrony
        lines.append(
            f'  channels         : {", ".join(s["channels"])}')
        lines.append(
            f'  top-gap walls    : {s["top_n_per_channel"]}')
        lines.append(
            f'  shared instants  : {len(s["common_wall_seconds"])}')
        lines.append(
            f'  lockstep fraction: {s["lockstep_fraction"]*100:.1f}%')
        if s['lockstep_fraction'] > 0.5:
            lines.append(
                '  → channels gap together: a SHARED pipeline component '
                'stalled. Could be the device emit loop, the firmware '
                'data ring overflowing (consumer fell > 64 KB behind '
                '→ silent eviction at data_buffer.c:190), the WS/TLS '
                'layer, or the browser main thread. Lockstep alone '
                'does NOT prove producer-side. Use the firmware-side '
                'eviction counter / browser-side perf trace to '
                'disambiguate.')
        elif s['lockstep_fraction'] > 0:
            lines.append(
                '  → mixed: some shared gaps, some independent. Investigate '
                'firmware ring-eviction and WS-reconnect overlap.')
        else:
            lines.append(
                '  → channels gap independently: wire / consumer-side '
                'loss affecting one channel and not the other (rare on '
                'in-order TCP — investigate decoder bugs).')

    return '\n'.join(lines)


def _to_json(result: AnalysisResult) -> str:
    """Plain-JSON projection, dropping numpy scalars."""
    payload = {
        'path':        result.path,
        'root_attrs':  result.root_attrs,
        'channels':    [asdict(ch) for ch in result.channels],
        'synchrony':   result.synchrony,
    }
    return json.dumps(payload, indent=2, default=str)


def main(argv: Optional[list[str]] = None) -> int:
    """Standalone entry — also called by the click wrapper in cli.py.

    Arguments:
        path                positional: HDF5 file
        --channel NAME      may be passed multiple times to filter
        --threshold-ms N    override the gap threshold (default:
                            max(4 × median delta, 100 ms))
        --top N             top-N worst gaps to report (default 10)
        --json              emit JSON instead of the human-readable
                            text rendering
    """
    import argparse
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('path')
    p.add_argument('--channel', action='append', default=None,
                   help='only analyze this channel (may be repeated)')
    p.add_argument('--threshold-ms', type=float, default=None,
                   help='gap threshold in ms; default = max(4×median, 100 ms)')
    p.add_argument('--top', type=int, default=10,
                   help='top-N worst gaps to list per channel')
    p.add_argument('--json', action='store_true', help='emit JSON')
    args = p.parse_args(argv)

    if h5py is None:
        print(f'analyze-hdf5: missing dependencies — {_IMPORT_ERR}', file=sys.stderr)
        print("Run: pip install 'h5py>=3.10' 'numpy>=1.24'  or", file=sys.stderr)
        print("     pip install -e '.[analysis]'  from tools/conduit/", file=sys.stderr)
        return 2

    threshold_us = int(args.threshold_ms * 1000) if args.threshold_ms is not None else None
    result = analyze(
        args.path,
        channel_filter=args.channel,
        threshold_us=threshold_us,
        top_n=args.top,
    )
    if args.json:
        print(_to_json(result))
    else:
        print(_render_text(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
