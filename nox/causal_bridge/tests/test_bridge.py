from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

from nox.causal_bridge import (
    CausalBridge,
    RuntimeRefs,
    SqliteCausalSink,
    TerminalConflictError,
    sha256_text,
)


@dataclass
class FakeClock:
    tick: int = 0

    def observed_at(self) -> str:
        self.tick += 1
        return f"2026-07-13T12:00:{self.tick:02d}+00:00"

    def monotonic_ns(self) -> int:
        return self.tick * 100


@dataclass
class FakeIds:
    value: int = 0

    def __call__(self, prefix: str) -> str:
        self.value += 1
        return f"{prefix}-{self.value}"


@pytest.fixture
def sink(tmp_path: Path) -> Iterator[SqliteCausalSink]:
    with SqliteCausalSink(
        tmp_path / "journal.sqlite3",
        process_epoch="epoch-1",
        started_at="2026-07-13T12:00:00+00:00",
        pid=42,
    ) as value:
        yield value


@pytest.fixture
def bridge(sink: SqliteCausalSink) -> CausalBridge:
    return CausalBridge(sink, clock=FakeClock(), id_factory=FakeIds())


@pytest.fixture
def runtime() -> RuntimeRefs:
    return RuntimeRefs(
        hermes_ui_session_id="ui-1",
        hermes_session_id="session-1",
        provider="openai-codex",
        model="gpt-5.6-sol",
        identity_sha256=sha256_text("accepted Nox"),
    )


def test_normal_trace_binds_one_hermes_turn_and_terminal(
    bridge: CausalBridge,
    runtime: RuntimeRefs,
    sink: SqliteCausalSink,
) -> None:
    correlation = bridge.admit_external(
        rpc_request_id="rpc-1",
        hermes_ui_session_id="ui-1",
        hermes_session_id="session-1",
        prompt="hello",
    )
    bridge.start(correlation, runtime=runtime)
    bridge.terminal(
        correlation,
        status="complete",
        output="visible response",
        hermes_turn_id="hermes-turn-1",
    )

    records = sink.records()
    assert [record.kind for record in records] == [
        "external.admitted",
        "turn.started",
        "turn.bound",
        "turn.completed",
    ]
    assert records[-1].output_hash == sha256_text("visible response")
    assert records[-1].hermes_turn_id == "hermes-turn-1"
    assert records[1].model == "gpt-5.6-sol"
    assert records[1].identity_sha256 == runtime.identity_sha256


def test_prebound_hermes_turn_is_reused_by_terminal(
    bridge: CausalBridge,
    runtime: RuntimeRefs,
    sink: SqliteCausalSink,
) -> None:
    correlation = bridge.admit_external(
        rpc_request_id="rpc-1",
        hermes_ui_session_id="ui-1",
        hermes_session_id="session-1",
        prompt="hello",
    )
    bridge.start(correlation, runtime=runtime)
    bridge.bind_hermes_turn(correlation, hermes_turn_id="hermes-turn-1")
    bridge.terminal(correlation, status="complete", output="done")

    assert [record.kind for record in sink.records()] == [
        "external.admitted",
        "turn.started",
        "turn.bound",
        "turn.completed",
    ]
    assert sink.records()[-1].hermes_turn_id == "hermes-turn-1"


def test_duplicate_rpc_admission_is_one_record(
    bridge: CausalBridge,
    sink: SqliteCausalSink,
) -> None:
    first = bridge.admit_external(
        rpc_request_id="rpc-1",
        hermes_ui_session_id="ui-1",
        prompt="same prompt",
    )
    second = bridge.admit_external(
        rpc_request_id="rpc-1",
        hermes_ui_session_id="ui-1",
        prompt="same prompt",
    )

    assert first == second
    assert len(sink.records()) == 1


def test_queued_merge_preserves_every_external_admission(
    bridge: CausalBridge,
    runtime: RuntimeRefs,
    sink: SqliteCausalSink,
) -> None:
    first = bridge.admit_external(
        rpc_request_id="rpc-1", hermes_ui_session_id="ui-1", prompt="first"
    )
    second = bridge.admit_external(
        rpc_request_id="rpc-2", hermes_ui_session_id="ui-1", prompt="second"
    )
    bridge.queue(first, hermes_ui_session_id="ui-1")
    bridge.queue(second, hermes_ui_session_id="ui-1")
    merged = bridge.merge_queued((first, second), combined_prompt="first\n\nsecond")
    bridge.start(merged, runtime=runtime)
    bridge.terminal(merged, status="complete", output="done")

    started = next(record for record in sink.records() if record.kind == "turn.started")
    assert started.origin == "queued-external"
    assert started.admission_ids == (*first.admission_ids, *second.admission_ids)


def test_steer_joins_admission_to_active_turn(
    bridge: CausalBridge,
    runtime: RuntimeRefs,
    sink: SqliteCausalSink,
) -> None:
    active = bridge.admit_external(
        rpc_request_id="rpc-1", hermes_ui_session_id="ui-1", prompt="first"
    )
    bridge.start(active, runtime=runtime)
    steering = bridge.admit_external(
        rpc_request_id="rpc-2", hermes_ui_session_id="ui-1", prompt="steer"
    )
    bridge.steer(steering, active, runtime=runtime)

    steered = sink.records()[-1]
    assert steered.kind == "turn.steered"
    assert steered.bridge_turn_id == active.bridge_turn_id
    assert steered.admission_ids == (*active.admission_ids, *steering.admission_ids)


@pytest.mark.parametrize(
    ("status", "kind"),
    [
        ("error", "turn.errored"),
        ("interrupted", "turn.interrupted"),
    ],
)
def test_terminal_paths_are_explicit(
    bridge: CausalBridge,
    runtime: RuntimeRefs,
    sink: SqliteCausalSink,
    status: str,
    kind: str,
) -> None:
    correlation = bridge.admit_external(
        rpc_request_id="rpc-1", hermes_ui_session_id="ui-1", prompt="hello"
    )
    bridge.start(correlation, runtime=runtime)
    if status == "interrupted":
        bridge.request_interrupt(correlation)
    bridge.terminal(correlation, status=status, stage="model")  # type: ignore[arg-type]

    assert sink.records()[-1].kind == kind


@pytest.mark.parametrize(
    "origin",
    ["goal-continuation", "background-completion", "notification"],
)
def test_internal_continuation_has_no_external_admission(
    bridge: CausalBridge,
    runtime: RuntimeRefs,
    sink: SqliteCausalSink,
    origin: str,
) -> None:
    correlation = bridge.new_internal(
        origin=origin,  # type: ignore[arg-type]
        prompt="continue",
        parent_bridge_turn_id="parent-turn",
    )
    bridge.start(correlation, runtime=runtime)
    bridge.terminal(correlation, status="complete", output="continued")

    assert [record.kind for record in sink.records()] == [
        "turn.started",
        "turn.completed",
    ]
    assert sink.records()[0].parent_bridge_turn_id == "parent-turn"


@pytest.mark.parametrize(
    ("status", "stage", "kind"),
    [
        ("error", "agent-init", "turn.errored"),
        ("interrupted", "pre-start", "turn.interrupted"),
    ],
)
def test_admission_can_settle_before_model_start(
    bridge: CausalBridge,
    sink: SqliteCausalSink,
    status: str,
    stage: str,
    kind: str,
) -> None:
    correlation = bridge.admit_external(
        rpc_request_id="rpc-1",
        hermes_ui_session_id="ui-1",
        hermes_session_id="session-1",
        prompt="hello",
    )

    bridge.terminal(
        correlation,
        status=status,  # type: ignore[arg-type]
        stage=stage,
        hermes_ui_session_id="ui-1",
        hermes_session_id="session-1",
    )

    assert [record.kind for record in sink.records()] == [
        "external.admitted",
        kind,
    ]
    assert sink.records()[-1].stage == stage


def test_second_terminal_is_rejected(
    bridge: CausalBridge,
    runtime: RuntimeRefs,
) -> None:
    correlation = bridge.admit_external(
        rpc_request_id="rpc-1", hermes_ui_session_id="ui-1", prompt="hello"
    )
    bridge.start(correlation, runtime=runtime)
    bridge.terminal(correlation, status="complete", output="done")

    with pytest.raises(TerminalConflictError, match="already terminal"):
        bridge.terminal(correlation, status="error")


def test_restart_reconciliation_settles_prior_epoch(
    tmp_path: Path,
) -> None:
    path = tmp_path / "journal.sqlite3"
    with SqliteCausalSink(
        path,
        process_epoch="epoch-1",
        started_at="2026-07-13T12:00:00+00:00",
        pid=42,
    ) as first_sink:
        first_bridge = CausalBridge(first_sink, clock=FakeClock(), id_factory=FakeIds())
        correlation = first_bridge.admit_external(
            rpc_request_id="rpc-1", hermes_ui_session_id="ui-1", prompt="hello"
        )
        first_bridge.start(
            correlation,
            runtime=RuntimeRefs(
                hermes_ui_session_id="ui-1",
                hermes_session_id="session-1",
                provider="openai-codex",
                model="gpt-5.6-sol",
                identity_sha256=sha256_text("accepted Nox"),
            ),
        )

    with SqliteCausalSink(
        path,
        process_epoch="epoch-2",
        started_at="2026-07-13T12:01:00+00:00",
        pid=43,
    ) as second_sink:
        second_bridge = CausalBridge(
            second_sink, clock=FakeClock(), id_factory=FakeIds()
        )
        reconciled = second_bridge.reconcile_resume(
            hermes_ui_session_id="ui-2",
            hermes_session_id="session-1",
        )

        assert reconciled == (correlation.bridge_turn_id,)
        assert [record.kind for record in second_sink.records()][-2:] == [
            "turn.abandoned",
            "session.resumed",
        ]
        assert second_sink.unsettled_prior_turns() == []


def test_restart_reconciliation_settles_admission_before_start(
    tmp_path: Path,
) -> None:
    path = tmp_path / "journal.sqlite3"
    with SqliteCausalSink(
        path,
        process_epoch="epoch-1",
        started_at="2026-07-13T12:00:00+00:00",
        pid=42,
    ) as first_sink:
        first_bridge = CausalBridge(first_sink, clock=FakeClock(), id_factory=FakeIds())
        correlation = first_bridge.admit_external(
            rpc_request_id="rpc-1",
            hermes_ui_session_id="ui-1",
            hermes_session_id="session-1",
            prompt="hello",
        )

    with SqliteCausalSink(
        path,
        process_epoch="epoch-2",
        started_at="2026-07-13T12:01:00+00:00",
        pid=43,
    ) as second_sink:
        second_bridge = CausalBridge(
            second_sink, clock=FakeClock(), id_factory=FakeIds()
        )

        reconciled = second_bridge.reconcile_resume(
            hermes_ui_session_id="ui-2",
            hermes_session_id="session-1",
        )

        assert reconciled == (correlation.bridge_turn_id,)
        assert [record.kind for record in second_sink.records()] == [
            "external.admitted",
            "turn.abandoned",
            "session.resumed",
        ]


def test_resume_reconciles_only_the_requested_hermes_session(
    tmp_path: Path,
) -> None:
    path = tmp_path / "journal.sqlite3"
    with SqliteCausalSink(
        path,
        process_epoch="epoch-1",
        started_at="2026-07-13T12:00:00+00:00",
        pid=42,
    ) as first_sink:
        first_bridge = CausalBridge(first_sink, clock=FakeClock(), id_factory=FakeIds())
        for index in (1, 2):
            correlation = first_bridge.admit_external(
                rpc_request_id=f"rpc-{index}",
                hermes_ui_session_id=f"ui-{index}",
                hermes_session_id=f"session-{index}",
                prompt=f"prompt-{index}",
            )
            first_bridge.start(
                correlation,
                runtime=RuntimeRefs(
                    hermes_ui_session_id=f"ui-{index}",
                    hermes_session_id=f"session-{index}",
                    provider="openai-codex",
                    model="gpt-5.6-sol",
                    identity_sha256=sha256_text("accepted Nox"),
                ),
            )

    with SqliteCausalSink(
        path,
        process_epoch="epoch-2",
        started_at="2026-07-13T12:01:00+00:00",
        pid=43,
    ) as second_sink:
        second_bridge = CausalBridge(
            second_sink, clock=FakeClock(), id_factory=FakeIds()
        )
        reconciled = second_bridge.reconcile_resume(
            hermes_ui_session_id="ui-1",
            hermes_session_id="session-1",
        )

        assert len(reconciled) == 1
        remaining = second_sink.unsettled_prior_turns(hermes_session_id="session-2")
        assert len(remaining) == 1
        assert remaining[0].hermes_session_id == "session-2"


def test_resume_reconciles_an_unsettled_turn_from_a_rotated_parent(
    tmp_path: Path,
) -> None:
    path = tmp_path / "journal.sqlite3"
    with SqliteCausalSink(
        path,
        process_epoch="epoch-1",
        started_at="2026-07-13T12:00:00+00:00",
        pid=42,
    ) as first_sink:
        first_bridge = CausalBridge(first_sink, clock=FakeClock(), id_factory=FakeIds())
        correlation = first_bridge.admit_external(
            rpc_request_id="rpc-1",
            hermes_ui_session_id="ui-1",
            hermes_session_id="session-parent",
            prompt="hello",
        )
        first_bridge.start(
            correlation,
            runtime=RuntimeRefs(
                hermes_ui_session_id="ui-1",
                hermes_session_id="session-parent",
                provider="openai-codex",
                model="gpt-5.6-sol",
                identity_sha256=sha256_text("accepted Nox"),
            ),
        )

    with SqliteCausalSink(
        path,
        process_epoch="epoch-2",
        started_at="2026-07-13T12:01:00+00:00",
        pid=43,
    ) as second_sink:
        second_bridge = CausalBridge(
            second_sink, clock=FakeClock(), id_factory=FakeIds()
        )
        reconciled = second_bridge.reconcile_resume(
            hermes_ui_session_id="ui-2",
            hermes_session_id="session-tip",
            prior_hermes_session_ids=("session-parent",),
        )

        assert reconciled == (correlation.bridge_turn_id,)
        records = second_sink.records()
        assert [record.kind for record in records][-2:] == [
            "turn.abandoned",
            "session.resumed",
        ]
        assert records[-2].hermes_session_id == "session-parent"
        assert records[-1].hermes_session_id == "session-tip"
        assert records[-1].reconciled_turn_ids == (correlation.bridge_turn_id,)
