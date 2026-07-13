from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
import sqlite3

import pytest

from nox.causal_bridge import (
    AppendResult,
    CausalBridge,
    CausalRecord,
    FailOpenCausalBridge,
    RuntimeRefs,
    SqliteCausalSink,
    sha256_text,
)

from .test_bridge import FakeClock, FakeIds


class FaultInjectingSink(SqliteCausalSink):
    def __init__(self, path: Path) -> None:
        super().__init__(
            path,
            process_epoch="epoch-1",
            started_at="2026-07-13T12:00:00+00:00",
            pid=42,
        )
        self.failed_kinds: set[str] = set()

    def append(self, record: CausalRecord) -> AppendResult:
        self._raise_when_selected((record,))
        return super().append(record)

    def append_many(
        self, records: tuple[CausalRecord, ...]
    ) -> tuple[AppendResult, ...]:
        self._raise_when_selected(records)
        return super().append_many(records)

    def _raise_when_selected(self, records: tuple[CausalRecord, ...]) -> None:
        if any(record.kind in self.failed_kinds for record in records):
            raise sqlite3.OperationalError("injected journal failure")


@pytest.fixture
def fault_sink(tmp_path: Path) -> Iterator[FaultInjectingSink]:
    with FaultInjectingSink(tmp_path / "journal.sqlite3") as sink:
        yield sink


@pytest.fixture
def fail_open(fault_sink: FaultInjectingSink) -> FailOpenCausalBridge:
    clock = FakeClock()
    bridge = CausalBridge(fault_sink, clock=clock, id_factory=FakeIds())
    return FailOpenCausalBridge(bridge, clock=clock)


@pytest.fixture
def runtime() -> RuntimeRefs:
    return RuntimeRefs(
        hermes_ui_session_id="ui-1",
        hermes_session_id="session-1",
        provider="openai-codex",
        model="gpt-5.6-sol",
        identity_sha256=sha256_text("accepted Nox"),
    )


def test_admission_failure_returns_correlation_and_recovers(
    fail_open: FailOpenCausalBridge,
    fault_sink: FaultInjectingSink,
    runtime: RuntimeRefs,
) -> None:
    fault_sink.failed_kinds.add("external.admitted")

    correlation = fail_open.admit_external(
        rpc_request_id="rpc-1",
        hermes_ui_session_id="ui-1",
        hermes_session_id="session-1",
        prompt="hello",
    )

    assert correlation.admission_ids
    assert fault_sink.records() == []
    assert fail_open.diagnostics.health == "degraded"
    assert fail_open.diagnostics.failed_write_count == 1
    assert fail_open.diagnostics.last_exception_class == "OperationalError"

    fault_sink.failed_kinds.clear()
    assert fail_open.start(correlation, runtime=runtime) is True

    assert [record.kind for record in fault_sink.records()] == ["turn.started"]
    assert fail_open.diagnostics.health == "healthy"
    assert fail_open.diagnostics.failed_write_count == 1
    assert [record.health for record in fault_sink.diagnostic_records()] == [
        "degraded",
        "healthy",
    ]


def test_repeated_equal_failure_updates_count_without_diagnostic_spam(
    fail_open: FailOpenCausalBridge,
    fault_sink: FaultInjectingSink,
) -> None:
    fault_sink.failed_kinds.add("external.admitted")

    for index in (1, 2):
        fail_open.admit_external(
            rpc_request_id=f"rpc-{index}",
            hermes_ui_session_id="ui-1",
            prompt=f"prompt-{index}",
        )

    assert fail_open.diagnostics.failed_write_count == 2
    diagnostics = fault_sink.diagnostic_records()
    assert len(diagnostics) == 1
    assert diagnostics[0].health == "degraded"
    assert diagnostics[0].occurrence_count == 1


def test_terminal_batch_failure_is_contained_and_leaves_no_partial_binding(
    fail_open: FailOpenCausalBridge,
    fault_sink: FaultInjectingSink,
    runtime: RuntimeRefs,
) -> None:
    correlation = fail_open.admit_external(
        rpc_request_id="rpc-1",
        hermes_ui_session_id="ui-1",
        hermes_session_id="session-1",
        prompt="hello",
    )
    assert fail_open.start(correlation, runtime=runtime) is True
    fault_sink.failed_kinds.add("turn.bound")

    settled = fail_open.terminal(
        correlation,
        status="complete",
        output="Hermes completed normally",
        hermes_turn_id="hermes-turn-1",
    )

    assert settled is False
    assert [record.kind for record in fault_sink.records()] == [
        "external.admitted",
        "turn.started",
    ]
    assert fail_open.diagnostics.health == "degraded"


def test_runtime_context_survives_failed_start_for_later_binding(
    fail_open: FailOpenCausalBridge,
    fault_sink: FaultInjectingSink,
    runtime: RuntimeRefs,
) -> None:
    correlation = fail_open.admit_external(
        rpc_request_id="rpc-1",
        hermes_ui_session_id="ui-1",
        hermes_session_id="session-1",
        prompt="hello",
    )
    fault_sink.failed_kinds.add("turn.started")

    assert fail_open.start(correlation, runtime=runtime) is False
    fault_sink.failed_kinds.clear()
    assert (
        fail_open.bind_hermes_turn(
            correlation,
            hermes_turn_id="hermes-turn-1",
        )
        is True
    )

    bound = fault_sink.records()[-1]
    assert bound.kind == "turn.bound"
    assert bound.hermes_turn_id == "hermes-turn-1"
    assert bound.hermes_session_id == runtime.hermes_session_id
