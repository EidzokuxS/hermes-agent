"""Closed lifecycle vocabulary for observed Hermes turns."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
from typing import Literal, TypeAlias, cast


Origin: TypeAlias = Literal[
    "background-completion",
    "external",
    "goal-continuation",
    "notification",
    "queued-external",
]
LifecycleKind: TypeAlias = Literal[
    "external.admitted",
    "interrupt.requested",
    "session.resumed",
    "turn.abandoned",
    "turn.bound",
    "turn.completed",
    "turn.errored",
    "turn.interrupted",
    "turn.queued",
    "turn.started",
    "turn.steered",
]
TerminalStatus: TypeAlias = Literal["abandoned", "complete", "error", "interrupted"]

ORIGINS = frozenset({
    "background-completion",
    "external",
    "goal-continuation",
    "notification",
    "queued-external",
})
LIFECYCLE_KINDS = frozenset({
    "external.admitted",
    "interrupt.requested",
    "session.resumed",
    "turn.abandoned",
    "turn.bound",
    "turn.completed",
    "turn.errored",
    "turn.interrupted",
    "turn.queued",
    "turn.started",
    "turn.steered",
})
TERMINAL_KINDS = frozenset({
    "turn.abandoned",
    "turn.completed",
    "turn.errored",
    "turn.interrupted",
})
_TERMINAL_STATUS_BY_KIND = {
    "turn.abandoned": "abandoned",
    "turn.completed": "complete",
    "turn.errored": "error",
    "turn.interrupted": "interrupted",
}


def _require_bounded(value: str, field: str, *, maximum: int = 256) -> None:
    if not value or len(value) > maximum:
        raise ValueError(f"{field} must contain 1..{maximum} characters")


def _require_hash(value: str | None, field: str) -> None:
    if value is None:
        return
    if len(value) != 71 or not value.startswith("sha256:"):
        raise ValueError(f"{field} must be a sha256 content hash")
    digest = value[7:]
    if any(character not in "0123456789abcdef" for character in digest):
        raise ValueError(f"{field} must use lowercase hexadecimal")


def canonical_json(value: object) -> str:
    """Render the deterministic JSON representation used by record hashing."""
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def canonical_sha256(value: object) -> str:
    digest = hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def sha256_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


@dataclass(frozen=True, slots=True)
class CausalRecord:
    """One content-free lifecycle observation written by the bridge."""

    event_id: str
    correlation_id: str
    process_epoch: str
    observed_at: str
    monotonic_ns: int
    kind: LifecycleKind
    origin: Origin
    hermes_ui_session_id: str
    hermes_session_id: str | None = None
    bridge_turn_id: str | None = None
    hermes_turn_id: str | None = None
    parent_bridge_turn_id: str | None = None
    admission_ids: tuple[str, ...] = ()
    reconciled_turn_ids: tuple[str, ...] = ()
    prompt_hash: str | None = None
    output_hash: str | None = None
    provider: str | None = None
    model: str | None = None
    identity_sha256: str | None = None
    terminal_status: TerminalStatus | None = None
    stage: str | None = None

    def __post_init__(self) -> None:
        for field, value in (
            ("event_id", self.event_id),
            ("correlation_id", self.correlation_id),
            ("process_epoch", self.process_epoch),
            ("observed_at", self.observed_at),
            ("hermes_ui_session_id", self.hermes_ui_session_id),
        ):
            _require_bounded(value, field)
        for field, value in (
            ("bridge_turn_id", self.bridge_turn_id),
            ("hermes_session_id", self.hermes_session_id),
            ("hermes_turn_id", self.hermes_turn_id),
            ("parent_bridge_turn_id", self.parent_bridge_turn_id),
            ("provider", self.provider),
            ("model", self.model),
            ("stage", self.stage),
        ):
            if value is not None:
                _require_bounded(value, field)
        if self.monotonic_ns < 0:
            raise ValueError("monotonic_ns must be nonnegative")
        try:
            observed_at = datetime.fromisoformat(self.observed_at)
        except ValueError as exc:
            raise ValueError("observed_at must be an ISO-8601 timestamp") from exc
        if observed_at.tzinfo is None:
            raise ValueError("observed_at must include a UTC offset")
        if self.origin not in ORIGINS:
            raise ValueError(f"unsupported origin: {self.origin}")
        if self.kind not in LIFECYCLE_KINDS:
            raise ValueError(f"unsupported lifecycle kind: {self.kind}")
        if len(self.admission_ids) > 32 or len(self.reconciled_turn_ids) > 32:
            raise ValueError("causal ID collections are bounded to 32 items")
        for value in (*self.admission_ids, *self.reconciled_turn_ids):
            _require_bounded(value, "causal ID")
        _require_hash(self.prompt_hash, "prompt_hash")
        _require_hash(self.output_hash, "output_hash")
        _require_hash(self.identity_sha256, "identity_sha256")
        expected_status = _TERMINAL_STATUS_BY_KIND.get(self.kind)
        if self.terminal_status != expected_status:
            if expected_status is not None or self.terminal_status is not None:
                raise ValueError(
                    f"{self.kind} requires terminal_status={expected_status!r}"
                )
        if self.kind.startswith("turn.") and self.bridge_turn_id is None:
            raise ValueError(f"{self.kind} requires bridge_turn_id")
        if self.kind == "turn.started":
            required = {
                "hermes_session_id": self.hermes_session_id,
                "identity_sha256": self.identity_sha256,
                "model": self.model,
                "prompt_hash": self.prompt_hash,
                "provider": self.provider,
            }
            missing = sorted(
                field for field, value in required.items() if value is None
            )
            if missing:
                raise ValueError(f"turn.started requires: {', '.join(missing)}")
        if self.kind == "turn.bound" and self.hermes_turn_id is None:
            raise ValueError("turn.bound requires hermes_turn_id")
        if self.kind == "turn.completed" and self.output_hash is None:
            raise ValueError("turn.completed requires output_hash")

    def as_dict(self) -> dict[str, object]:
        return {
            "admission_ids": list(self.admission_ids),
            "bridge_turn_id": self.bridge_turn_id,
            "correlation_id": self.correlation_id,
            "event_id": self.event_id,
            "hermes_session_id": self.hermes_session_id,
            "hermes_turn_id": self.hermes_turn_id,
            "hermes_ui_session_id": self.hermes_ui_session_id,
            "identity_sha256": self.identity_sha256,
            "kind": self.kind,
            "model": self.model,
            "monotonic_ns": self.monotonic_ns,
            "observed_at": self.observed_at,
            "origin": self.origin,
            "output_hash": self.output_hash,
            "parent_bridge_turn_id": self.parent_bridge_turn_id,
            "process_epoch": self.process_epoch,
            "prompt_hash": self.prompt_hash,
            "provider": self.provider,
            "reconciled_turn_ids": list(self.reconciled_turn_ids),
            "stage": self.stage,
            "terminal_status": self.terminal_status,
        }

    @property
    def record_hash(self) -> str:
        return canonical_sha256(self.as_dict())

    @property
    def semantic_hash(self) -> str:
        value = self.as_dict()
        for field in ("monotonic_ns", "observed_at", "process_epoch"):
            value.pop(field)
        return canonical_sha256(value)

    @classmethod
    def from_dict(cls, value: dict[str, object]) -> CausalRecord:
        return cls(
            admission_ids=tuple(cast(list[str], value.get("admission_ids") or [])),
            bridge_turn_id=cast(str | None, value.get("bridge_turn_id")),
            correlation_id=cast(str, value["correlation_id"]),
            event_id=cast(str, value["event_id"]),
            hermes_session_id=cast(str | None, value.get("hermes_session_id")),
            hermes_turn_id=cast(str | None, value.get("hermes_turn_id")),
            hermes_ui_session_id=cast(str, value["hermes_ui_session_id"]),
            identity_sha256=cast(str | None, value.get("identity_sha256")),
            kind=cast(LifecycleKind, value["kind"]),
            model=cast(str | None, value.get("model")),
            monotonic_ns=cast(int, value["monotonic_ns"]),
            observed_at=cast(str, value["observed_at"]),
            origin=cast(Origin, value["origin"]),
            output_hash=cast(str | None, value.get("output_hash")),
            parent_bridge_turn_id=cast(str | None, value.get("parent_bridge_turn_id")),
            process_epoch=cast(str, value["process_epoch"]),
            prompt_hash=cast(str | None, value.get("prompt_hash")),
            provider=cast(str | None, value.get("provider")),
            reconciled_turn_ids=tuple(
                cast(list[str], value.get("reconciled_turn_ids") or [])
            ),
            stage=cast(str | None, value.get("stage")),
            terminal_status=cast(TerminalStatus | None, value.get("terminal_status")),
        )
