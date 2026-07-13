"""Independent read-only audit view over the Nox causal journal."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import sqlite3

from .events import CausalRecord, TERMINAL_KINDS, canonical_json


@dataclass(frozen=True, slots=True)
class AuditIssue:
    code: str
    detail: str
    sequence: int | None = None
    bridge_turn_id: str | None = None


@dataclass(frozen=True, slots=True)
class AuditedTurn:
    bridge_turn_id: str
    correlation_id: str
    origin: str
    admission_ids: tuple[str, ...]
    lifecycle: tuple[str, ...]
    hermes_session_id: str | None
    hermes_session_ids: tuple[str, ...]
    hermes_turn_id: str | None
    provider: str | None
    model: str | None
    identity_sha256: str | None
    terminal_status: str | None


@dataclass(frozen=True, slots=True)
class JournalAudit:
    record_count: int
    last_sequence: int
    turns: tuple[AuditedTurn, ...]
    issues: tuple[AuditIssue, ...]

    @property
    def ok(self) -> bool:
        return not self.issues


class JournalAuditError(ValueError):
    """The journal failed one or more independent consistency checks."""


class CausalJournalReader:
    """Reads the bridge database without importing Hermes or opening write access."""

    def __init__(self, path: Path) -> None:
        self.path = path.resolve()

    def inspect(self) -> JournalAudit:
        connection = sqlite3.connect(
            f"{self.path.as_uri()}?mode=ro",
            isolation_level=None,
            uri=True,
        )
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA query_only = ON")
            rows = connection.execute(
                "SELECT sequence, record_hash, record_json "
                "FROM bridge_records ORDER BY sequence"
            ).fetchall()
        finally:
            connection.close()

        issues: list[AuditIssue] = []
        records: list[tuple[int, CausalRecord]] = []
        prior_sequence = 0
        monotonic_by_epoch: dict[str, int] = {}
        for row in rows:
            sequence = int(row["sequence"])
            if sequence <= prior_sequence:
                issues.append(
                    AuditIssue(
                        code="sequence-order",
                        detail="record sequence is not strictly increasing",
                        sequence=sequence,
                    )
                )
            prior_sequence = sequence
            try:
                raw = json.loads(row["record_json"])
                if not isinstance(raw, dict):
                    raise ValueError("record_json must decode to an object")
                record = CausalRecord.from_dict(raw)
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                issues.append(
                    AuditIssue(
                        code="invalid-record",
                        detail=f"{type(exc).__name__}: {exc}",
                        sequence=sequence,
                    )
                )
                continue
            if row["record_json"] != canonical_json(record.as_dict()):
                issues.append(
                    AuditIssue(
                        code="noncanonical-record",
                        detail="record_json differs from its canonical representation",
                        sequence=sequence,
                        bridge_turn_id=record.bridge_turn_id,
                    )
                )
            if row["record_hash"] != record.record_hash:
                issues.append(
                    AuditIssue(
                        code="record-hash-mismatch",
                        detail="stored record hash does not match canonical content",
                        sequence=sequence,
                        bridge_turn_id=record.bridge_turn_id,
                    )
                )
            prior_monotonic = monotonic_by_epoch.get(record.process_epoch)
            if prior_monotonic is not None and record.monotonic_ns < prior_monotonic:
                issues.append(
                    AuditIssue(
                        code="monotonic-regression",
                        detail="monotonic time regressed within one process epoch",
                        sequence=sequence,
                        bridge_turn_id=record.bridge_turn_id,
                    )
                )
            monotonic_by_epoch[record.process_epoch] = record.monotonic_ns
            records.append((sequence, record))

        turns = self._audit_turns(records, issues)
        return JournalAudit(
            record_count=len(rows),
            last_sequence=int(rows[-1]["sequence"]) if rows else 0,
            turns=tuple(turns),
            issues=tuple(issues),
        )

    def verify(self) -> JournalAudit:
        audit = self.inspect()
        if audit.issues:
            summary = ", ".join(issue.code for issue in audit.issues[:5])
            raise JournalAuditError(f"causal journal verification failed: {summary}")
        return audit

    @staticmethod
    def _audit_turns(
        records: list[tuple[int, CausalRecord]],
        issues: list[AuditIssue],
    ) -> list[AuditedTurn]:
        grouped: dict[str, list[tuple[int, CausalRecord]]] = {}
        for sequence, record in records:
            if record.bridge_turn_id is not None:
                grouped.setdefault(record.bridge_turn_id, []).append((sequence, record))

        audited: list[AuditedTurn] = []
        for bridge_turn_id, entries in grouped.items():
            turn_records = [record for _, record in entries]
            correlation_ids = {record.correlation_id for record in turn_records}
            origins = {record.origin for record in turn_records}
            terminal_entries = [
                (sequence, record)
                for sequence, record in entries
                if record.kind in TERMINAL_KINDS
            ]
            started = [
                record for record in turn_records if record.kind == "turn.started"
            ]
            bound_ids = {
                record.hermes_turn_id
                for record in turn_records
                if record.hermes_turn_id is not None
            }
            if len(correlation_ids) != 1:
                issues.append(
                    AuditIssue(
                        code="turn-correlation-conflict",
                        detail="one bridge turn contains multiple correlation IDs",
                        bridge_turn_id=bridge_turn_id,
                    )
                )
            if len(origins) != 1:
                issues.append(
                    AuditIssue(
                        code="turn-origin-conflict",
                        detail="one bridge turn contains multiple origins",
                        bridge_turn_id=bridge_turn_id,
                    )
                )
            if len(started) > 1:
                issues.append(
                    AuditIssue(
                        code="multiple-starts",
                        detail="one bridge turn contains multiple start records",
                        bridge_turn_id=bridge_turn_id,
                    )
                )
            if len(terminal_entries) > 1:
                issues.append(
                    AuditIssue(
                        code="multiple-terminals",
                        detail="one bridge turn contains multiple terminal records",
                        bridge_turn_id=bridge_turn_id,
                    )
                )
            if terminal_entries and terminal_entries[0][0] != entries[-1][0]:
                issues.append(
                    AuditIssue(
                        code="record-after-terminal",
                        detail="a lifecycle record follows the terminal outcome",
                        bridge_turn_id=bridge_turn_id,
                    )
                )
            if len(bound_ids) > 1:
                issues.append(
                    AuditIssue(
                        code="hermes-turn-conflict",
                        detail="one bridge turn refers to multiple Hermes turn IDs",
                        bridge_turn_id=bridge_turn_id,
                    )
                )

            admission_ids = tuple(
                dict.fromkeys(
                    admission_id
                    for record in turn_records
                    for admission_id in record.admission_ids
                )
            )
            started_record = started[0] if started else None
            terminal_record = terminal_entries[0][1] if terminal_entries else None
            hermes_session_ids = tuple(
                dict.fromkeys(
                    record.hermes_session_id
                    for record in turn_records
                    if record.hermes_session_id is not None
                )
            )
            session_sequence = tuple(
                record.hermes_session_id
                for record in turn_records
                if record.hermes_session_id is not None
            )
            session_rotation_is_valid = False
            if len(hermes_session_ids) == 2 and started and terminal_entries:
                parent_session_id, tip_session_id = hermes_session_ids
                first_tip_index = session_sequence.index(tip_session_id)
                session_rotation_is_valid = (
                    started[0].hermes_session_id == parent_session_id
                    and terminal_entries[0][1].hermes_session_id == tip_session_id
                    and all(
                        session_id == tip_session_id
                        for session_id in session_sequence[first_tip_index:]
                    )
                    and any(
                        record.kind == "turn.bound"
                        and record.hermes_session_id == tip_session_id
                        for record in turn_records
                    )
                )
            if len(hermes_session_ids) > 1 and not session_rotation_is_valid:
                issues.append(
                    AuditIssue(
                        code="hermes-session-conflict",
                        detail="one bridge turn refers to multiple Hermes sessions",
                        bridge_turn_id=bridge_turn_id,
                    )
                )
            audited.append(
                AuditedTurn(
                    bridge_turn_id=bridge_turn_id,
                    correlation_id=turn_records[0].correlation_id,
                    origin=turn_records[0].origin,
                    admission_ids=admission_ids,
                    lifecycle=tuple(record.kind for record in turn_records),
                    hermes_session_id=(
                        hermes_session_ids[-1] if hermes_session_ids else None
                    ),
                    hermes_session_ids=hermes_session_ids,
                    hermes_turn_id=next(iter(bound_ids), None),
                    provider=started_record.provider if started_record else None,
                    model=started_record.model if started_record else None,
                    identity_sha256=(
                        started_record.identity_sha256 if started_record else None
                    ),
                    terminal_status=(
                        terminal_record.terminal_status if terminal_record else None
                    ),
                )
            )
        return audited
