from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import sqlite3
from threading import Thread
from collections.abc import Iterator

from typing import cast

import pytest

from nox.causal_bridge import (
    CausalRecord,
    RecordConflictError,
    SqliteCausalSink,
    TerminalConflictError,
    sha256_text,
)
from nox.causal_bridge.events import LifecycleKind, TerminalStatus


OBSERVED_AT = "2026-07-13T12:00:00+00:00"


def record(
    *,
    event_id: str = "event-1",
    kind: str = "turn.started",
    process_epoch: str = "epoch-1",
    output_hash: str | None = None,
    terminal_status: str | None = None,
) -> CausalRecord:
    return CausalRecord(
        event_id=event_id,
        correlation_id="correlation-1",
        process_epoch=process_epoch,
        observed_at=OBSERVED_AT,
        monotonic_ns=100,
        kind=cast(LifecycleKind, kind),
        origin="external",
        hermes_ui_session_id="ui-session-1",
        hermes_session_id="hermes-session-1",
        bridge_turn_id="bridge-turn-1",
        admission_ids=("admission-1",),
        prompt_hash=sha256_text("private prompt"),
        provider="openai-codex",
        model="gpt-5.6-sol",
        identity_sha256=sha256_text("Nox revision"),
        output_hash=output_hash,
        terminal_status=cast(TerminalStatus | None, terminal_status),
    )


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    return tmp_path / "nox" / "journal.sqlite3"


@pytest.fixture
def sink(database_path: Path) -> Iterator[SqliteCausalSink]:
    with SqliteCausalSink(
        database_path,
        process_epoch="epoch-1",
        started_at=OBSERVED_AT,
        pid=42,
    ) as value:
        yield value


def test_append_is_durable_and_uses_required_pragmas(
    sink: SqliteCausalSink,
) -> None:
    result = sink.append(record())

    assert result.inserted is True
    assert result.sequence == 1
    assert sink.records() == [record()]
    assert sink.pragmas() == {
        "foreign_keys": 1,
        "journal_mode": "wal",
        "synchronous": 2,
    }


def test_exact_replay_is_idempotent(sink: SqliteCausalSink) -> None:
    first = sink.append(record())
    second = sink.append(record())

    assert first == replace(second, inserted=True)
    assert second.inserted is False
    assert len(sink.records()) == 1


def test_replay_from_a_new_process_epoch_preserves_first_observation(
    database_path: Path,
) -> None:
    with SqliteCausalSink(
        database_path,
        process_epoch="epoch-1",
        started_at=OBSERVED_AT,
        pid=42,
    ) as first:
        inserted = first.append(record())

    with SqliteCausalSink(
        database_path,
        process_epoch="epoch-2",
        started_at="2026-07-13T12:01:00+00:00",
        pid=43,
    ) as second:
        replayed = second.append(
            replace(
                record(),
                process_epoch="epoch-2",
                observed_at="2026-07-13T12:01:01+00:00",
                monotonic_ns=1,
            )
        )

        assert replayed.sequence == inserted.sequence
        assert replayed.inserted is False
        assert second.records() == [record()]


def test_append_many_rolls_back_the_whole_batch_on_failure(
    sink: SqliteCausalSink,
) -> None:
    with pytest.raises(ValueError, match="process_epoch"):
        sink.append_many((
            record(),
            record(event_id="event-2", process_epoch="other-epoch"),
        ))

    assert sink.records() == []


def test_conflicting_event_replay_is_rejected(sink: SqliteCausalSink) -> None:
    sink.append(record())

    with pytest.raises(RecordConflictError, match="conflicting content"):
        sink.append(replace(record(), prompt_hash=sha256_text("different prompt")))


def test_one_terminal_observation_per_turn(sink: SqliteCausalSink) -> None:
    sink.append(record())
    sink.append(
        record(
            event_id="terminal-1",
            kind="turn.completed",
            output_hash=sha256_text("visible output"),
            terminal_status="complete",
        )
    )

    with pytest.raises(TerminalConflictError, match="already terminal"):
        sink.append(
            record(
                event_id="terminal-2",
                kind="turn.interrupted",
                terminal_status="interrupted",
            )
        )


def test_prior_process_unsettled_turn_is_visible_for_reconciliation(
    database_path: Path,
) -> None:
    with SqliteCausalSink(
        database_path,
        process_epoch="epoch-1",
        started_at=OBSERVED_AT,
        pid=42,
    ) as first:
        first.append(record())

    with SqliteCausalSink(
        database_path,
        process_epoch="epoch-2",
        started_at="2026-07-13T12:01:00+00:00",
        pid=43,
    ) as second:
        unsettled_turns = second.unsettled_prior_turns()
        assert len(unsettled_turns) == 1
        unsettled = unsettled_turns[0]
        assert unsettled.bridge_turn_id == "bridge-turn-1"
        assert unsettled.process_epoch == "epoch-1"
        assert unsettled.lifecycle_kind == "turn.started"


def test_journal_contains_hashes_instead_of_transcript_bodies(
    database_path: Path,
) -> None:
    secret_prompt = "PRIVATE TRANSCRIPT BODY 17931"
    with SqliteCausalSink(
        database_path,
        process_epoch="epoch-1",
        started_at=OBSERVED_AT,
        pid=42,
    ) as value:
        value.append(replace(record(), prompt_hash=sha256_text(secret_prompt)))
        value.checkpoint()

    bytes_on_disk = database_path.read_bytes()
    assert secret_prompt.encode() not in bytes_on_disk
    assert sha256_text(secret_prompt).encode() in bytes_on_disk


def test_append_only_records_reject_mutation(
    sink: SqliteCausalSink,
) -> None:
    sink.append(record())

    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        sink._connection.execute(
            "UPDATE bridge_records SET kind = 'turn.bound' WHERE sequence = 1"
        )


def test_diagnostic_health_transitions_are_append_only(
    sink: SqliteCausalSink,
) -> None:
    sink.record_diagnostic(
        observed_at=OBSERVED_AT,
        health="degraded",
        lifecycle_kind="turn.started",
        exception_class="OperationalError",
        occurrence_count=1,
    )
    sink.record_diagnostic(
        observed_at="2026-07-13T12:00:01+00:00",
        health="healthy",
        lifecycle_kind="turn.completed",
        exception_class="OperationalError",
        occurrence_count=1,
    )

    assert [record.health for record in sink.diagnostic_records()] == [
        "degraded",
        "healthy",
    ]
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        sink._connection.execute(
            "UPDATE bridge_diagnostics SET health = 'healthy' WHERE sequence = 1"
        )


def test_concurrent_appends_receive_monotonic_unique_sequences(
    sink: SqliteCausalSink,
) -> None:
    results = []

    def append(index: int) -> None:
        results.append(
            sink.append(
                replace(
                    record(),
                    bridge_turn_id=f"bridge-turn-{index}",
                    correlation_id=f"correlation-{index}",
                    event_id=f"event-{index}",
                )
            )
        )

    threads = [Thread(target=append, args=(index,)) for index in range(1, 9)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sorted(result.sequence for result in results) == list(range(1, 9))
