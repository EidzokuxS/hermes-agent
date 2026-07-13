"""Pure lifecycle coordinator for the observational causal bridge."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
import time
from typing import Literal, Protocol, cast
import uuid

from .events import (
    CausalRecord,
    LifecycleKind,
    Origin,
    TerminalStatus,
    canonical_sha256,
    sha256_text,
)
from .sqlite_sink import AppendResult, SqliteCausalSink, TerminalConflictError


InternalOrigin = Literal["background-completion", "goal-continuation", "notification"]


class BridgeClock(Protocol):
    def observed_at(self) -> str: ...

    def monotonic_ns(self) -> int: ...


class SystemBridgeClock:
    def observed_at(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def monotonic_ns(self) -> int:
        return time.monotonic_ns()


@dataclass(frozen=True, slots=True)
class RuntimeRefs:
    hermes_ui_session_id: str
    hermes_session_id: str
    provider: str
    model: str
    identity_sha256: str


@dataclass(frozen=True, slots=True)
class CausalCorrelation:
    correlation_id: str
    bridge_turn_id: str
    origin: Origin
    prompt_hash: str
    admission_ids: tuple[str, ...] = ()
    parent_bridge_turn_id: str | None = None


class CausalBridge:
    """Coordinates content-free lifecycle records through an injected sink."""

    def __init__(
        self,
        sink: SqliteCausalSink,
        *,
        clock: BridgeClock | None = None,
        id_factory: Callable[[str], str] | None = None,
    ) -> None:
        self._sink = sink
        self._clock = clock or SystemBridgeClock()
        self._id_factory = id_factory or (lambda prefix: f"{prefix}-{uuid.uuid4().hex}")
        self._runtime_by_turn: dict[str, RuntimeRefs] = {}
        self._hermes_turn_by_bridge: dict[str, str] = {}

    @property
    def process_epoch(self) -> str:
        return self._sink.process_epoch

    def record_diagnostic(
        self,
        *,
        observed_at: str,
        health: str,
        lifecycle_kind: str,
        exception_class: str,
        occurrence_count: int,
    ) -> None:
        self._sink.record_diagnostic(
            observed_at=observed_at,
            health=health,
            lifecycle_kind=lifecycle_kind,
            exception_class=exception_class,
            occurrence_count=occurrence_count,
        )

    def admit_external(
        self,
        *,
        rpc_request_id: str,
        hermes_ui_session_id: str,
        prompt: str,
        hermes_session_id: str | None = None,
    ) -> CausalCorrelation:
        correlation = self.correlate_external(
            rpc_request_id=rpc_request_id,
            hermes_ui_session_id=hermes_ui_session_id,
            prompt=prompt,
            hermes_session_id=hermes_session_id,
        )
        return self.record_external_admission(
            correlation,
            hermes_ui_session_id=hermes_ui_session_id,
            hermes_session_id=hermes_session_id,
        )

    def correlate_external(
        self,
        *,
        rpc_request_id: str,
        hermes_ui_session_id: str,
        prompt: str,
        hermes_session_id: str | None = None,
    ) -> CausalCorrelation:
        prompt_hash = sha256_text(prompt)
        admission_seed = {
            "hermes_session_id": hermes_session_id,
            "hermes_ui_session_id": hermes_ui_session_id,
            "prompt_hash": prompt_hash,
            "rpc_request_id": rpc_request_id,
        }
        admission_digest = canonical_sha256(admission_seed)[7:]
        admission_id = f"admission-{admission_digest[:40]}"
        return CausalCorrelation(
            correlation_id=f"correlation-{admission_digest[:40]}",
            bridge_turn_id=f"turn-{admission_digest[:40]}",
            origin="external",
            prompt_hash=prompt_hash,
            admission_ids=(admission_id,),
        )

    def record_external_admission(
        self,
        correlation: CausalCorrelation,
        *,
        hermes_ui_session_id: str,
        hermes_session_id: str | None = None,
    ) -> CausalCorrelation:
        if correlation.origin != "external" or len(correlation.admission_ids) != 1:
            raise ValueError("external admission requires one external correlation")
        admission_id = correlation.admission_ids[0]
        self._append(
            correlation,
            kind="external.admitted",
            event_id=admission_id,
            hermes_ui_session_id=hermes_ui_session_id,
            hermes_session_id=hermes_session_id,
        )
        return correlation

    def queue(
        self,
        correlation: CausalCorrelation,
        *,
        hermes_ui_session_id: str,
        hermes_session_id: str | None = None,
    ) -> AppendResult:
        return self._append(
            correlation,
            kind="turn.queued",
            hermes_ui_session_id=hermes_ui_session_id,
            hermes_session_id=hermes_session_id,
        )

    def merge_queued(
        self,
        correlations: tuple[CausalCorrelation, ...],
        *,
        combined_prompt: str,
    ) -> CausalCorrelation:
        if not correlations:
            raise ValueError("at least one queued correlation is required")
        admission_ids = tuple(
            admission_id
            for correlation in correlations
            for admission_id in correlation.admission_ids
        )
        digest = canonical_sha256({
            "admission_ids": admission_ids,
            "prompt_hash": sha256_text(combined_prompt),
        })[7:]
        return CausalCorrelation(
            admission_ids=admission_ids,
            bridge_turn_id=f"turn-{digest[:40]}",
            correlation_id=f"correlation-{digest[:40]}",
            origin="queued-external",
            prompt_hash=sha256_text(combined_prompt),
        )

    def steer(
        self,
        admission: CausalCorrelation,
        active: CausalCorrelation,
        *,
        runtime: RuntimeRefs,
    ) -> AppendResult:
        joined = CausalCorrelation(
            admission_ids=(*active.admission_ids, *admission.admission_ids),
            bridge_turn_id=active.bridge_turn_id,
            correlation_id=active.correlation_id,
            origin=active.origin,
            parent_bridge_turn_id=active.parent_bridge_turn_id,
            prompt_hash=active.prompt_hash,
        )
        return self._append(
            joined,
            kind="turn.steered",
            runtime=runtime,
            stage="busy-input",
        )

    def new_internal(
        self,
        *,
        origin: InternalOrigin,
        prompt: str,
        parent_bridge_turn_id: str | None = None,
    ) -> CausalCorrelation:
        identifier = cast(str, self._id_factory("correlation"))
        turn_identifier = cast(str, self._id_factory("turn"))
        return CausalCorrelation(
            bridge_turn_id=turn_identifier,
            correlation_id=identifier,
            origin=origin,
            parent_bridge_turn_id=parent_bridge_turn_id,
            prompt_hash=sha256_text(prompt),
        )

    def start(
        self,
        correlation: CausalCorrelation,
        *,
        runtime: RuntimeRefs,
    ) -> AppendResult:
        result = self._append(correlation, kind="turn.started", runtime=runtime)
        self._runtime_by_turn[correlation.bridge_turn_id] = runtime
        return result

    def bind_hermes_turn(
        self,
        correlation: CausalCorrelation,
        *,
        hermes_turn_id: str,
        runtime: RuntimeRefs | None = None,
        hermes_ui_session_id: str | None = None,
        hermes_session_id: str | None = None,
    ) -> AppendResult:
        bound_turn_id = self._hermes_turn_by_bridge.get(correlation.bridge_turn_id)
        if bound_turn_id is not None and bound_turn_id != hermes_turn_id:
            raise ValueError(
                f"bridge turn {correlation.bridge_turn_id!r} is already bound to "
                f"{bound_turn_id!r}"
            )
        result = self._append(
            correlation,
            kind="turn.bound",
            runtime=runtime or self._runtime_by_turn.get(correlation.bridge_turn_id),
            hermes_ui_session_id=hermes_ui_session_id,
            hermes_session_id=hermes_session_id,
            hermes_turn_id=hermes_turn_id,
        )
        self._hermes_turn_by_bridge[correlation.bridge_turn_id] = hermes_turn_id
        return result

    def request_interrupt(
        self,
        correlation: CausalCorrelation,
        *,
        runtime: RuntimeRefs | None = None,
        hermes_ui_session_id: str | None = None,
        hermes_session_id: str | None = None,
    ) -> AppendResult:
        return self._append(
            correlation,
            kind="interrupt.requested",
            runtime=runtime or self._runtime_by_turn.get(correlation.bridge_turn_id),
            hermes_ui_session_id=hermes_ui_session_id,
            hermes_session_id=hermes_session_id,
        )

    def terminal(
        self,
        correlation: CausalCorrelation,
        *,
        status: TerminalStatus,
        output: str | None = None,
        stage: str | None = None,
        hermes_turn_id: str | None = None,
        runtime: RuntimeRefs | None = None,
        hermes_ui_session_id: str | None = None,
        hermes_session_id: str | None = None,
    ) -> AppendResult:
        kind_by_status = {
            "abandoned": "turn.abandoned",
            "complete": "turn.completed",
            "error": "turn.errored",
            "interrupted": "turn.interrupted",
        }
        active_runtime = runtime or self._runtime_by_turn.get(
            correlation.bridge_turn_id
        )
        if (
            active_runtime is None
            and hermes_ui_session_id is None
            and self._sink.turn_is_terminal(correlation.bridge_turn_id)
        ):
            raise TerminalConflictError(
                f"bridge turn {correlation.bridge_turn_id!r} is already terminal"
            )
        bound_turn_id = self._hermes_turn_by_bridge.get(correlation.bridge_turn_id)
        if (
            hermes_turn_id is not None
            and bound_turn_id is not None
            and hermes_turn_id != bound_turn_id
        ):
            raise ValueError(
                f"bridge turn {correlation.bridge_turn_id!r} is already bound to "
                f"{bound_turn_id!r}"
            )
        resolved_turn_id = hermes_turn_id or bound_turn_id
        terminal_kind = cast(
            Literal[
                "turn.abandoned",
                "turn.completed",
                "turn.errored",
                "turn.interrupted",
            ],
            kind_by_status[status],
        )
        if hermes_turn_id is not None and bound_turn_id is None:
            bound_record = self._make_record(
                correlation,
                kind="turn.bound",
                runtime=active_runtime,
                hermes_ui_session_id=hermes_ui_session_id,
                hermes_session_id=hermes_session_id,
                hermes_turn_id=hermes_turn_id,
            )
            terminal_record = self._make_record(
                correlation,
                kind=terminal_kind,
                runtime=active_runtime,
                hermes_ui_session_id=hermes_ui_session_id,
                hermes_session_id=hermes_session_id,
                hermes_turn_id=resolved_turn_id,
                output_hash=(
                    sha256_text(output or "") if status == "complete" else None
                ),
                stage=stage,
                terminal_status=status,
            )
            results = self._append_records((bound_record, terminal_record))
            self._forget_terminal_context(correlation.bridge_turn_id)
            return results[-1]
        result = self._append(
            correlation,
            kind=terminal_kind,
            runtime=active_runtime,
            hermes_ui_session_id=hermes_ui_session_id,
            hermes_session_id=hermes_session_id,
            hermes_turn_id=resolved_turn_id,
            output_hash=sha256_text(output or "") if status == "complete" else None,
            stage=stage,
            terminal_status=status,
        )
        self._forget_terminal_context(correlation.bridge_turn_id)
        return result

    def reconcile_resume(
        self,
        *,
        hermes_ui_session_id: str,
        hermes_session_id: str,
        prior_hermes_session_ids: tuple[str, ...] = (),
    ) -> tuple[str, ...]:
        reconciled: list[str] = []
        session_ids = tuple(
            dict.fromkeys((*prior_hermes_session_ids, hermes_session_id))
        )
        unsettled_turns = {
            unsettled.bridge_turn_id: unsettled
            for session_id in session_ids
            for unsettled in self._sink.unsettled_prior_turns(
                hermes_session_id=session_id
            )
        }
        for unsettled in sorted(
            unsettled_turns.values(), key=lambda turn: turn.last_sequence
        ):
            correlation = CausalCorrelation(
                admission_ids=unsettled.admission_ids,
                bridge_turn_id=unsettled.bridge_turn_id,
                correlation_id=unsettled.correlation_id,
                origin=cast(Origin, unsettled.origin),
                parent_bridge_turn_id=unsettled.parent_bridge_turn_id,
                prompt_hash=unsettled.prompt_hash or sha256_text(""),
            )
            self._append(
                correlation,
                kind="turn.abandoned",
                hermes_ui_session_id=hermes_ui_session_id,
                hermes_session_id=unsettled.hermes_session_id,
                stage="process-restart",
                terminal_status="abandoned",
            )
            reconciled.append(unsettled.bridge_turn_id)
        resume_correlation_id = cast(str, self._id_factory("resume"))
        resume_event_id = self._semantic_event_id(
            "session.resumed",
            {
                "hermes_session_id": hermes_session_id,
                "process_epoch": self.process_epoch,
                "prior_hermes_session_ids": prior_hermes_session_ids,
                "resume_correlation_id": resume_correlation_id,
                "reconciled_turn_ids": reconciled,
            },
        )
        record = CausalRecord(
            event_id=resume_event_id,
            correlation_id=resume_correlation_id,
            process_epoch=self.process_epoch,
            observed_at=self._clock.observed_at(),
            monotonic_ns=self._clock.monotonic_ns(),
            kind="session.resumed",
            origin="external",
            hermes_ui_session_id=hermes_ui_session_id,
            hermes_session_id=hermes_session_id,
            reconciled_turn_ids=tuple(reconciled),
            stage="resume",
        )
        self._append_record(record)
        return tuple(reconciled)

    def _append(
        self,
        correlation: CausalCorrelation,
        *,
        kind: LifecycleKind,
        event_id: str | None = None,
        hermes_ui_session_id: str | None = None,
        hermes_session_id: str | None = None,
        hermes_turn_id: str | None = None,
        output_hash: str | None = None,
        runtime: RuntimeRefs | None = None,
        stage: str | None = None,
        terminal_status: TerminalStatus | None = None,
    ) -> AppendResult:
        return self._append_record(
            self._make_record(
                correlation,
                kind=kind,
                event_id=event_id,
                hermes_ui_session_id=hermes_ui_session_id,
                hermes_session_id=hermes_session_id,
                hermes_turn_id=hermes_turn_id,
                output_hash=output_hash,
                runtime=runtime,
                stage=stage,
                terminal_status=terminal_status,
            )
        )

    def _make_record(
        self,
        correlation: CausalCorrelation,
        *,
        kind: LifecycleKind,
        event_id: str | None = None,
        hermes_ui_session_id: str | None = None,
        hermes_session_id: str | None = None,
        hermes_turn_id: str | None = None,
        output_hash: str | None = None,
        runtime: RuntimeRefs | None = None,
        stage: str | None = None,
        terminal_status: TerminalStatus | None = None,
    ) -> CausalRecord:
        ui_session_id = (
            runtime.hermes_ui_session_id
            if runtime is not None
            else hermes_ui_session_id
        )
        durable_session_id = (
            runtime.hermes_session_id if runtime is not None else hermes_session_id
        )
        if ui_session_id is None:
            raise ValueError("hermes_ui_session_id is required")
        semantic = {
            "admission_ids": correlation.admission_ids,
            "bridge_turn_id": correlation.bridge_turn_id,
            "correlation_id": correlation.correlation_id,
            "hermes_session_id": durable_session_id,
            "hermes_turn_id": hermes_turn_id,
            "hermes_ui_session_id": ui_session_id,
            "identity_sha256": runtime.identity_sha256 if runtime else None,
            "kind": kind,
            "model": runtime.model if runtime else None,
            "origin": correlation.origin,
            "output_hash": output_hash,
            "parent_bridge_turn_id": correlation.parent_bridge_turn_id,
            "prompt_hash": correlation.prompt_hash,
            "provider": runtime.provider if runtime else None,
            "stage": stage,
            "terminal_status": terminal_status,
        }
        return CausalRecord(
            event_id=event_id or self._semantic_event_id(kind, semantic),
            correlation_id=correlation.correlation_id,
            process_epoch=self.process_epoch,
            observed_at=self._clock.observed_at(),
            monotonic_ns=self._clock.monotonic_ns(),
            kind=kind,
            origin=correlation.origin,
            hermes_ui_session_id=ui_session_id,
            hermes_session_id=durable_session_id,
            bridge_turn_id=correlation.bridge_turn_id,
            hermes_turn_id=hermes_turn_id,
            parent_bridge_turn_id=correlation.parent_bridge_turn_id,
            admission_ids=correlation.admission_ids,
            prompt_hash=correlation.prompt_hash,
            output_hash=output_hash,
            provider=runtime.provider if runtime else None,
            model=runtime.model if runtime else None,
            identity_sha256=runtime.identity_sha256 if runtime else None,
            terminal_status=terminal_status,
            stage=stage,
        )

    def _append_record(self, record: CausalRecord) -> AppendResult:
        return self._sink.append(record)

    def _append_records(
        self, records: tuple[CausalRecord, ...]
    ) -> tuple[AppendResult, ...]:
        return self._sink.append_many(records)

    def _forget_terminal_context(self, bridge_turn_id: str) -> None:
        self._runtime_by_turn.pop(bridge_turn_id, None)
        self._hermes_turn_by_bridge.pop(bridge_turn_id, None)

    @staticmethod
    def _semantic_event_id(kind: str, semantic: object) -> str:
        digest = canonical_sha256({"kind": kind, "semantic": semantic})[7:]
        return f"event-{digest[:48]}"
