from __future__ import annotations

from pathlib import Path
import sqlite3

import pytest

from nox.causal_bridge import (
    CausalBridge,
    CausalJournalReader,
    JournalAuditError,
    RuntimeRefs,
    SqliteCausalSink,
    sha256_text,
)

from .test_bridge import FakeClock, FakeIds


def write_normal_turn(path: Path) -> None:
    with SqliteCausalSink(
        path,
        process_epoch="epoch-1",
        started_at="2026-07-13T12:00:00+00:00",
        pid=42,
    ) as sink:
        bridge = CausalBridge(sink, clock=FakeClock(), id_factory=FakeIds())
        correlation = bridge.admit_external(
            rpc_request_id="rpc-1",
            hermes_ui_session_id="ui-1",
            hermes_session_id="session-1",
            prompt="private prompt",
        )
        bridge.start(
            correlation,
            runtime=RuntimeRefs(
                hermes_ui_session_id="ui-1",
                hermes_session_id="session-1",
                provider="openai-codex",
                model="gpt-5.6-sol",
                identity_sha256=sha256_text("accepted Nox"),
            ),
        )
        bridge.terminal(
            correlation,
            status="complete",
            output="private response",
            hermes_turn_id="hermes-turn-1",
        )


def test_reader_reconstructs_content_free_turn_trace(tmp_path: Path) -> None:
    path = tmp_path / "journal.sqlite3"
    write_normal_turn(path)

    audit = CausalJournalReader(path).verify()

    assert audit.ok is True
    assert audit.record_count == 4
    assert audit.last_sequence == 4
    assert len(audit.turns) == 1
    turn = audit.turns[0]
    assert turn.lifecycle == (
        "external.admitted",
        "turn.started",
        "turn.bound",
        "turn.completed",
    )
    assert turn.hermes_session_id == "session-1"
    assert turn.hermes_session_ids == ("session-1",)
    assert turn.hermes_turn_id == "hermes-turn-1"
    assert turn.model == "gpt-5.6-sol"
    assert turn.terminal_status == "complete"


def test_reader_detects_record_hash_tampering(tmp_path: Path) -> None:
    path = tmp_path / "journal.sqlite3"
    write_normal_turn(path)
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TRIGGER bridge_records_no_update")
        connection.execute(
            "UPDATE bridge_records SET record_hash = ? WHERE sequence = 2",
            (sha256_text("tampered"),),
        )

    audit = CausalJournalReader(path).inspect()

    assert audit.ok is False
    assert [issue.code for issue in audit.issues] == ["record-hash-mismatch"]
    with pytest.raises(JournalAuditError, match="record-hash-mismatch"):
        CausalJournalReader(path).verify()


def test_reader_accepts_one_way_session_rotation_within_a_bound_turn(
    tmp_path: Path,
) -> None:
    path = tmp_path / "journal.sqlite3"
    with SqliteCausalSink(
        path,
        process_epoch="epoch-1",
        started_at="2026-07-13T12:00:00+00:00",
        pid=42,
    ) as sink:
        bridge = CausalBridge(sink, clock=FakeClock(), id_factory=FakeIds())
        correlation = bridge.admit_external(
            rpc_request_id="rpc-1",
            hermes_ui_session_id="ui-1",
            hermes_session_id="session-parent",
            prompt="private prompt",
        )
        bridge.start(
            correlation,
            runtime=RuntimeRefs(
                hermes_ui_session_id="ui-1",
                hermes_session_id="session-parent",
                provider="openai-codex",
                model="gpt-5.6-sol",
                identity_sha256=sha256_text("accepted Nox"),
            ),
        )
        bridge.terminal(
            correlation,
            status="complete",
            output="private response",
            hermes_turn_id="hermes-turn-1",
            runtime=RuntimeRefs(
                hermes_ui_session_id="ui-1",
                hermes_session_id="session-tip",
                provider="openai-codex",
                model="gpt-5.6-sol",
                identity_sha256=sha256_text("accepted Nox"),
            ),
        )

    audit = CausalJournalReader(path).verify()

    assert audit.turns[0].hermes_session_id == "session-tip"
    assert audit.turns[0].hermes_session_ids == (
        "session-parent",
        "session-tip",
    )


def test_reader_rejects_unbound_session_id_change(tmp_path: Path) -> None:
    path = tmp_path / "journal.sqlite3"
    with SqliteCausalSink(
        path,
        process_epoch="epoch-1",
        started_at="2026-07-13T12:00:00+00:00",
        pid=42,
    ) as sink:
        bridge = CausalBridge(sink, clock=FakeClock(), id_factory=FakeIds())
        correlation = bridge.admit_external(
            rpc_request_id="rpc-1",
            hermes_ui_session_id="ui-1",
            hermes_session_id="session-parent",
            prompt="private prompt",
        )
        bridge.start(
            correlation,
            runtime=RuntimeRefs(
                hermes_ui_session_id="ui-1",
                hermes_session_id="session-parent",
                provider="openai-codex",
                model="gpt-5.6-sol",
                identity_sha256=sha256_text("accepted Nox"),
            ),
        )
        bridge.terminal(
            correlation,
            status="error",
            runtime=RuntimeRefs(
                hermes_ui_session_id="ui-1",
                hermes_session_id="session-unrelated",
                provider="openai-codex",
                model="gpt-5.6-sol",
                identity_sha256=sha256_text("accepted Nox"),
            ),
        )

    audit = CausalJournalReader(path).inspect()

    assert [issue.code for issue in audit.issues] == ["hermes-session-conflict"]
