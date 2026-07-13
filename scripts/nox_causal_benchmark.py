"""Measure synchronous Nox causal-journal overhead on the local evidence host."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import statistics
import sys
import tempfile
import time
import uuid


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from nox.causal_bridge import (  # noqa: E402
    CausalBridge,
    FailOpenCausalBridge,
    RuntimeRefs,
    SqliteCausalSink,
)
from nox.identity import ACCEPTED_NOX_IDENTITY_SHA256  # noqa: E402


def _percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(len(ordered) * quantile))
    return ordered[index]


def run_benchmark(*, series: int, turns: int, warmup: int) -> dict[str, object]:
    durations_ms: list[float] = []
    series_p95_ms: list[float] = []
    runtime = RuntimeRefs(
        hermes_ui_session_id="benchmark-ui",
        hermes_session_id="benchmark-session",
        provider="benchmark-provider",
        model="benchmark-cortex",
        identity_sha256=f"sha256:{ACCEPTED_NOX_IDENTITY_SHA256}",
    )

    for series_index in range(series):
        with tempfile.TemporaryDirectory(prefix="nox-causal-benchmark-") as temp_dir:
            sink = SqliteCausalSink(
                Path(temp_dir) / "journal.sqlite3",
                process_epoch=f"benchmark-{series_index}-{uuid.uuid4().hex}",
                started_at=datetime.now(timezone.utc).isoformat(),
                pid=os.getpid(),
            )
            bridge = FailOpenCausalBridge(CausalBridge(sink))
            measured: list[float] = []
            try:
                for turn_index in range(warmup + turns):
                    started_ns = time.perf_counter_ns()
                    correlation = bridge.admit_external(
                        rpc_request_id=f"rpc-{series_index}-{turn_index}",
                        hermes_ui_session_id=runtime.hermes_ui_session_id,
                        hermes_session_id=runtime.hermes_session_id,
                        prompt=f"prompt-{series_index}-{turn_index}",
                    )
                    bridge.start(correlation, runtime=runtime)
                    bridge.terminal(
                        correlation,
                        status="complete",
                        output="complete",
                        hermes_turn_id=f"hermes-turn-{series_index}-{turn_index}",
                        runtime=runtime,
                    )
                    elapsed_ms = (time.perf_counter_ns() - started_ns) / 1_000_000
                    if turn_index >= warmup:
                        measured.append(elapsed_ms)
            finally:
                sink.close()
            durations_ms.extend(measured)
            series_p95_ms.append(_percentile(measured, 0.95))

    p95_ms = _percentile(durations_ms, 0.95)
    return {
        "budget": {"aggregate_p95_ms_lt": 10.0},
        "environment": {
            "platform": platform.system(),
            "python": platform.python_version(),
        },
        "measurement": {
            "aggregate_max_ms": round(max(durations_ms), 3),
            "aggregate_p50_ms": round(statistics.median(durations_ms), 3),
            "aggregate_p95_ms": round(p95_ms, 3),
            "per_series_p95_ms": [round(value, 3) for value in series_p95_ms],
            "series": series,
            "turns_per_series": turns,
            "warmup_turns_per_series": warmup,
        },
        "model_calls_added": 0,
        "passed": p95_ms < 10.0,
        "record_path": [
            "external.admitted",
            "turn.started",
            "turn.bound",
            "turn.completed",
        ],
        "schema_version": 1,
        "storage": {"journal_mode": "WAL", "synchronous": "FULL"},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    parser.add_argument("--series", type=int, default=5)
    parser.add_argument("--turns", type=int, default=200)
    parser.add_argument("--warmup", type=int, default=25)
    args = parser.parse_args()
    if min(args.series, args.turns) < 1 or args.warmup < 0:
        parser.error("series and turns must be positive; warmup must be nonnegative")

    report = run_benchmark(
        series=args.series,
        turns=args.turns,
        warmup=args.warmup,
    )
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8", newline="\n")
    print(rendered, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
