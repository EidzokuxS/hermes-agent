"""Append-only SQLite storage for Nox observations of Hermes turns."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import sqlite3
import threading

from .events import CausalRecord, TERMINAL_KINDS, canonical_json


_MIGRATION = """
CREATE TABLE IF NOT EXISTS bridge_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS bridge_process_epochs (
    process_epoch TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    pid INTEGER NOT NULL CHECK (pid >= 0)
) WITHOUT ROWID, STRICT;

CREATE TABLE IF NOT EXISTS bridge_records (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    record_hash TEXT NOT NULL UNIQUE,
    correlation_id TEXT NOT NULL,
    bridge_turn_id TEXT,
    process_epoch TEXT NOT NULL REFERENCES bridge_process_epochs(process_epoch),
    observed_at TEXT NOT NULL,
    monotonic_ns INTEGER NOT NULL CHECK (monotonic_ns >= 0),
    kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    hermes_ui_session_id TEXT NOT NULL,
    hermes_session_id TEXT,
    terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
    record_json TEXT NOT NULL CHECK (json_valid(record_json))
) STRICT;

CREATE INDEX IF NOT EXISTS bridge_records_correlation_sequence
ON bridge_records(correlation_id, sequence);

CREATE INDEX IF NOT EXISTS bridge_records_hermes_session_sequence
ON bridge_records(hermes_session_id, sequence);

CREATE INDEX IF NOT EXISTS bridge_records_turn_sequence
ON bridge_records(bridge_turn_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS bridge_records_one_terminal_per_turn
ON bridge_records(bridge_turn_id)
WHERE terminal = 1;

CREATE TABLE IF NOT EXISTS bridge_turn_heads (
    bridge_turn_id TEXT PRIMARY KEY,
    correlation_id TEXT NOT NULL,
    process_epoch TEXT NOT NULL,
    origin TEXT NOT NULL,
    hermes_session_id TEXT,
    last_sequence INTEGER NOT NULL REFERENCES bridge_records(sequence),
    lifecycle_kind TEXT NOT NULL,
    terminal INTEGER NOT NULL CHECK (terminal IN (0, 1))
) WITHOUT ROWID, STRICT;

CREATE TABLE IF NOT EXISTS bridge_diagnostics (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    process_epoch TEXT NOT NULL REFERENCES bridge_process_epochs(process_epoch),
    observed_at TEXT NOT NULL,
    health TEXT NOT NULL CHECK (health IN ('degraded', 'healthy')),
    lifecycle_kind TEXT NOT NULL,
    exception_class TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0)
) STRICT;

CREATE TRIGGER IF NOT EXISTS bridge_records_no_update
BEFORE UPDATE ON bridge_records
BEGIN
    SELECT RAISE(ABORT, 'bridge_records is append-only');
END;

CREATE TRIGGER IF NOT EXISTS bridge_records_no_delete
BEFORE DELETE ON bridge_records
BEGIN
    SELECT RAISE(ABORT, 'bridge_records is append-only');
END;

CREATE TRIGGER IF NOT EXISTS bridge_process_epochs_no_update
BEFORE UPDATE ON bridge_process_epochs
BEGIN
    SELECT RAISE(ABORT, 'bridge_process_epochs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS bridge_process_epochs_no_delete
BEFORE DELETE ON bridge_process_epochs
BEGIN
    SELECT RAISE(ABORT, 'bridge_process_epochs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS bridge_diagnostics_no_update
BEFORE UPDATE ON bridge_diagnostics
BEGIN
    SELECT RAISE(ABORT, 'bridge_diagnostics is append-only');
END;

CREATE TRIGGER IF NOT EXISTS bridge_diagnostics_no_delete
BEFORE DELETE ON bridge_diagnostics
BEGIN
    SELECT RAISE(ABORT, 'bridge_diagnostics is append-only');
END;
"""


class RecordConflictError(ValueError):
    """An event ID was replayed with different canonical content."""


class TerminalConflictError(ValueError):
    """A bridge turn already has a terminal observation."""


@dataclass(frozen=True, slots=True)
class AppendResult:
    sequence: int
    inserted: bool


@dataclass(frozen=True, slots=True)
class UnsettledTurn:
    bridge_turn_id: str
    correlation_id: str
    process_epoch: str
    origin: str
    hermes_session_id: str | None
    last_sequence: int
    lifecycle_kind: str
    prompt_hash: str | None
    admission_ids: tuple[str, ...]
    parent_bridge_turn_id: str | None


@dataclass(frozen=True, slots=True)
class DiagnosticRecord:
    sequence: int
    process_epoch: str
    observed_at: str
    health: str
    lifecycle_kind: str
    exception_class: str
    occurrence_count: int


class SqliteCausalSink:
    """Synchronous, thread-safe projection owner for causal records."""

    def __init__(
        self,
        path: Path,
        *,
        process_epoch: str,
        started_at: str,
        pid: int,
        busy_timeout_ms: int = 250,
    ) -> None:
        if not process_epoch:
            raise ValueError("process_epoch is required")
        if busy_timeout_ms < 1:
            raise ValueError("busy_timeout_ms must be positive")
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.process_epoch = process_epoch
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(
            path,
            check_same_thread=False,
            isolation_level=None,
        )
        self._connection.row_factory = sqlite3.Row
        with self._lock:
            self._connection.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
            self._connection.execute("PRAGMA foreign_keys = ON")
            self._connection.execute("PRAGMA journal_mode = WAL")
            self._connection.execute("PRAGMA synchronous = FULL")
            self._connection.executescript(_MIGRATION)
            self._connection.execute(
                "INSERT OR IGNORE INTO bridge_schema_migrations"
                "(version, name, applied_at) VALUES (1, ?, ?)",
                ("observed-hermes-lifecycle", started_at),
            )
            diagnostic_columns = {
                row["name"]
                for row in self._connection.execute(
                    "PRAGMA table_info(bridge_diagnostics)"
                ).fetchall()
            }
            if "health" not in diagnostic_columns:
                self._connection.execute(
                    "ALTER TABLE bridge_diagnostics ADD COLUMN health TEXT NOT NULL "
                    "DEFAULT 'degraded' CHECK (health IN ('degraded', 'healthy'))"
                )
            self._connection.execute(
                "INSERT OR IGNORE INTO bridge_schema_migrations"
                "(version, name, applied_at) VALUES (2, ?, ?)",
                ("diagnostic-health", started_at),
            )
            self._connection.execute(
                "INSERT OR IGNORE INTO bridge_process_epochs"
                "(process_epoch, started_at, pid) VALUES (?, ?, ?)",
                (process_epoch, started_at, pid),
            )
            epoch = self._connection.execute(
                "SELECT started_at, pid FROM bridge_process_epochs WHERE process_epoch = ?",
                (process_epoch,),
            ).fetchone()
            if (
                epoch is None
                or epoch["started_at"] != started_at
                or epoch["pid"] != pid
            ):
                raise RecordConflictError(
                    f"process_epoch {process_epoch!r} has conflicting metadata"
                )

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def __enter__(self) -> SqliteCausalSink:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def append(self, record: CausalRecord) -> AppendResult:
        return self.append_many((record,))[0]

    def append_many(
        self, records: tuple[CausalRecord, ...]
    ) -> tuple[AppendResult, ...]:
        if not records:
            raise ValueError("at least one causal record is required")
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                results = tuple(
                    self._append_in_transaction(record) for record in records
                )
                self._connection.execute("COMMIT")
                return results
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def _append_in_transaction(self, record: CausalRecord) -> AppendResult:
        payload = canonical_json(record.as_dict())
        terminal = int(record.kind in TERMINAL_KINDS)
        existing = self._connection.execute(
            "SELECT sequence, record_json FROM bridge_records WHERE event_id = ?",
            (record.event_id,),
        ).fetchone()
        if existing is not None:
            existing_record = CausalRecord.from_dict(
                json.loads(existing["record_json"])
            )
            if existing_record.semantic_hash != record.semantic_hash:
                raise RecordConflictError(
                    f"event_id {record.event_id!r} has conflicting content"
                )
            return AppendResult(sequence=int(existing["sequence"]), inserted=False)
        if record.process_epoch != self.process_epoch:
            raise ValueError("record process_epoch does not match the open sink")
        if record.bridge_turn_id is not None:
            head = self._connection.execute(
                "SELECT terminal FROM bridge_turn_heads WHERE bridge_turn_id = ?",
                (record.bridge_turn_id,),
            ).fetchone()
            if head is not None and int(head["terminal"]) == 1:
                raise TerminalConflictError(
                    f"bridge turn {record.bridge_turn_id!r} is already terminal"
                )
        try:
            cursor = self._connection.execute(
                """
                INSERT INTO bridge_records(
                    event_id, record_hash, correlation_id, bridge_turn_id,
                    process_epoch, observed_at, monotonic_ns, kind, origin,
                    hermes_ui_session_id, hermes_session_id, terminal, record_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.event_id,
                    record.record_hash,
                    record.correlation_id,
                    record.bridge_turn_id,
                    record.process_epoch,
                    record.observed_at,
                    record.monotonic_ns,
                    record.kind,
                    record.origin,
                    record.hermes_ui_session_id,
                    record.hermes_session_id,
                    terminal,
                    payload,
                ),
            )
        except sqlite3.IntegrityError as exc:
            if terminal and "bridge_records.bridge_turn_id" in str(exc):
                raise TerminalConflictError(
                    f"bridge turn {record.bridge_turn_id!r} is already terminal"
                ) from exc
            raise
        row_id = cursor.lastrowid
        if row_id is None:
            raise RuntimeError("SQLite did not return a record sequence")
        sequence = int(row_id)
        if record.bridge_turn_id is not None:
            self._connection.execute(
                """
                INSERT INTO bridge_turn_heads(
                    bridge_turn_id, correlation_id, process_epoch, origin,
                    hermes_session_id, last_sequence, lifecycle_kind, terminal
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(bridge_turn_id) DO UPDATE SET
                    correlation_id = excluded.correlation_id,
                    process_epoch = excluded.process_epoch,
                    origin = excluded.origin,
                    hermes_session_id = excluded.hermes_session_id,
                    last_sequence = excluded.last_sequence,
                    lifecycle_kind = excluded.lifecycle_kind,
                    terminal = excluded.terminal
                """,
                (
                    record.bridge_turn_id,
                    record.correlation_id,
                    record.process_epoch,
                    record.origin,
                    record.hermes_session_id,
                    sequence,
                    record.kind,
                    terminal,
                ),
            )
        return AppendResult(sequence=sequence, inserted=True)

    def records(self) -> list[CausalRecord]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT record_json FROM bridge_records ORDER BY sequence"
            ).fetchall()
        return [CausalRecord.from_dict(json.loads(row["record_json"])) for row in rows]

    def checkpoint(self) -> None:
        with self._lock:
            self._connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def turn_is_terminal(self, bridge_turn_id: str) -> bool:
        with self._lock:
            row = self._connection.execute(
                "SELECT terminal FROM bridge_turn_heads WHERE bridge_turn_id = ?",
                (bridge_turn_id,),
            ).fetchone()
        return row is not None and int(row["terminal"]) == 1

    def record_diagnostic(
        self,
        *,
        observed_at: str,
        health: str,
        lifecycle_kind: str,
        exception_class: str,
        occurrence_count: int,
    ) -> None:
        if health not in {"degraded", "healthy"}:
            raise ValueError("diagnostic health must be degraded or healthy")
        if not lifecycle_kind or not exception_class:
            raise ValueError("diagnostic fields must be non-empty")
        if occurrence_count < 1:
            raise ValueError("diagnostic occurrence_count must be positive")
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO bridge_diagnostics(
                    process_epoch, observed_at, health, lifecycle_kind,
                    exception_class, occurrence_count
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    self.process_epoch,
                    observed_at,
                    health,
                    lifecycle_kind,
                    exception_class,
                    occurrence_count,
                ),
            )

    def diagnostic_records(self) -> list[DiagnosticRecord]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT sequence, process_epoch, observed_at, health,
                       lifecycle_kind, exception_class, occurrence_count
                FROM bridge_diagnostics ORDER BY sequence
                """
            ).fetchall()
        return [
            DiagnosticRecord(
                sequence=int(row["sequence"]),
                process_epoch=row["process_epoch"],
                observed_at=row["observed_at"],
                health=row["health"],
                lifecycle_kind=row["lifecycle_kind"],
                exception_class=row["exception_class"],
                occurrence_count=int(row["occurrence_count"]),
            )
            for row in rows
        ]

    def unsettled_prior_turns(
        self, *, hermes_session_id: str | None = None
    ) -> list[UnsettledTurn]:
        session_clause = ""
        parameters: tuple[object, ...] = (self.process_epoch,)
        if hermes_session_id is not None:
            session_clause = " AND heads.hermes_session_id = ?"
            parameters = (*parameters, hermes_session_id)
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT heads.bridge_turn_id, heads.correlation_id,
                       heads.process_epoch, heads.origin, heads.hermes_session_id,
                       heads.last_sequence, heads.lifecycle_kind, records.record_json
                FROM bridge_turn_heads AS heads
                JOIN bridge_records AS records ON records.sequence = heads.last_sequence
                WHERE heads.terminal = 0 AND heads.process_epoch <> ?{session_clause}
                ORDER BY heads.last_sequence
                """,
                parameters,
            ).fetchall()
        unsettled: list[UnsettledTurn] = []
        for row in rows:
            latest = CausalRecord.from_dict(json.loads(row["record_json"]))
            unsettled.append(
                UnsettledTurn(
                    bridge_turn_id=row["bridge_turn_id"],
                    correlation_id=row["correlation_id"],
                    process_epoch=row["process_epoch"],
                    origin=row["origin"],
                    hermes_session_id=row["hermes_session_id"],
                    last_sequence=int(row["last_sequence"]),
                    lifecycle_kind=row["lifecycle_kind"],
                    prompt_hash=latest.prompt_hash,
                    admission_ids=latest.admission_ids,
                    parent_bridge_turn_id=latest.parent_bridge_turn_id,
                )
            )
        return unsettled

    def pragmas(self) -> dict[str, object]:
        with self._lock:
            return {
                "foreign_keys": self._connection.execute(
                    "PRAGMA foreign_keys"
                ).fetchone()[0],
                "journal_mode": self._connection.execute(
                    "PRAGMA journal_mode"
                ).fetchone()[0],
                "synchronous": self._connection.execute(
                    "PRAGMA synchronous"
                ).fetchone()[0],
            }
