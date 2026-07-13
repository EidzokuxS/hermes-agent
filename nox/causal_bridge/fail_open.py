"""Fail-open lifecycle facade for Hermes gateway integration."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, TypeVar

from .bridge import (
    BridgeClock,
    CausalBridge,
    CausalCorrelation,
    InternalOrigin,
    RuntimeRefs,
    SystemBridgeClock,
)
from .events import LifecycleKind, TerminalStatus


DiagnosticHealth = Literal["degraded", "healthy"]
T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class BridgeDiagnostics:
    health: DiagnosticHealth = "healthy"
    failed_write_count: int = 0
    last_failure_at: str | None = None
    last_exception_class: str | None = None
    last_lifecycle_kind: str | None = None


class FailOpenCausalBridge:
    """Contains observational failures so Hermes remains the turn authority."""

    def __init__(
        self,
        bridge: CausalBridge,
        *,
        clock: BridgeClock | None = None,
    ) -> None:
        self._bridge = bridge
        self._clock = clock or SystemBridgeClock()
        self._diagnostics = BridgeDiagnostics()
        self._active_failure: tuple[str, str] | None = None
        self._runtime_by_turn: dict[str, RuntimeRefs] = {}

    @property
    def diagnostics(self) -> BridgeDiagnostics:
        return self._diagnostics

    def admit_external(
        self,
        *,
        rpc_request_id: str,
        hermes_ui_session_id: str,
        prompt: str,
        hermes_session_id: str | None = None,
    ) -> CausalCorrelation:
        correlation = self._bridge.correlate_external(
            rpc_request_id=rpc_request_id,
            hermes_ui_session_id=hermes_ui_session_id,
            prompt=prompt,
            hermes_session_id=hermes_session_id,
        )
        self._observe(
            "external.admitted",
            lambda: self._bridge.record_external_admission(
                correlation,
                hermes_ui_session_id=hermes_ui_session_id,
                hermes_session_id=hermes_session_id,
            ),
        )
        return correlation

    def queue(
        self,
        correlation: CausalCorrelation,
        *,
        hermes_ui_session_id: str,
        hermes_session_id: str | None = None,
    ) -> bool:
        succeeded, _ = self._observe(
            "turn.queued",
            lambda: self._bridge.queue(
                correlation,
                hermes_ui_session_id=hermes_ui_session_id,
                hermes_session_id=hermes_session_id,
            ),
        )
        return succeeded

    def merge_queued(
        self,
        correlations: tuple[CausalCorrelation, ...],
        *,
        combined_prompt: str,
    ) -> CausalCorrelation:
        return self._bridge.merge_queued(
            correlations,
            combined_prompt=combined_prompt,
        )

    def steer(
        self,
        admission: CausalCorrelation,
        active: CausalCorrelation,
        *,
        runtime: RuntimeRefs,
    ) -> bool:
        self._runtime_by_turn[active.bridge_turn_id] = runtime
        succeeded, _ = self._observe(
            "turn.steered",
            lambda: self._bridge.steer(
                admission,
                active,
                runtime=runtime,
            ),
        )
        return succeeded

    def new_internal(
        self,
        *,
        origin: InternalOrigin,
        prompt: str,
        parent_bridge_turn_id: str | None = None,
    ) -> CausalCorrelation:
        return self._bridge.new_internal(
            origin=origin,
            prompt=prompt,
            parent_bridge_turn_id=parent_bridge_turn_id,
        )

    def start(
        self,
        correlation: CausalCorrelation,
        *,
        runtime: RuntimeRefs,
    ) -> bool:
        self._runtime_by_turn[correlation.bridge_turn_id] = runtime
        succeeded, _ = self._observe(
            "turn.started",
            lambda: self._bridge.start(correlation, runtime=runtime),
        )
        return succeeded

    def bind_hermes_turn(
        self,
        correlation: CausalCorrelation,
        *,
        hermes_turn_id: str,
    ) -> bool:
        succeeded, _ = self._observe(
            "turn.bound",
            lambda: self._bridge.bind_hermes_turn(
                correlation,
                hermes_turn_id=hermes_turn_id,
                runtime=self._runtime_by_turn.get(correlation.bridge_turn_id),
            ),
        )
        return succeeded

    def request_interrupt(self, correlation: CausalCorrelation) -> bool:
        succeeded, _ = self._observe(
            "interrupt.requested",
            lambda: self._bridge.request_interrupt(
                correlation,
                runtime=self._runtime_by_turn.get(correlation.bridge_turn_id),
            ),
        )
        return succeeded

    def terminal(
        self,
        correlation: CausalCorrelation,
        *,
        status: TerminalStatus,
        output: str | None = None,
        stage: str | None = None,
        hermes_turn_id: str | None = None,
        hermes_ui_session_id: str | None = None,
        hermes_session_id: str | None = None,
        runtime: RuntimeRefs | None = None,
    ) -> bool:
        kind_by_status: dict[TerminalStatus, LifecycleKind] = {
            "abandoned": "turn.abandoned",
            "complete": "turn.completed",
            "error": "turn.errored",
            "interrupted": "turn.interrupted",
        }
        active_runtime = runtime or self._runtime_by_turn.get(correlation.bridge_turn_id)
        try:
            succeeded, _ = self._observe(
                kind_by_status[status],
                lambda: self._bridge.terminal(
                    correlation,
                    status=status,
                    output=output,
                    stage=stage,
                    hermes_turn_id=hermes_turn_id,
                    runtime=active_runtime,
                    hermes_ui_session_id=hermes_ui_session_id,
                    hermes_session_id=hermes_session_id,
                ),
            )
            return succeeded
        finally:
            self._runtime_by_turn.pop(correlation.bridge_turn_id, None)

    def reconcile_resume(
        self,
        *,
        hermes_ui_session_id: str,
        hermes_session_id: str,
        prior_hermes_session_ids: tuple[str, ...] = (),
    ) -> tuple[str, ...]:
        succeeded, result = self._observe(
            "session.resumed",
            lambda: self._bridge.reconcile_resume(
                hermes_ui_session_id=hermes_ui_session_id,
                hermes_session_id=hermes_session_id,
                prior_hermes_session_ids=prior_hermes_session_ids,
            ),
        )
        return result if succeeded and result is not None else ()

    def _observe(
        self,
        lifecycle_kind: str,
        operation: Callable[[], T],
    ) -> tuple[bool, T | None]:
        try:
            result = operation()
        except Exception as exc:
            self._record_failure(lifecycle_kind, exc)
            return False, None
        self._record_recovery(lifecycle_kind)
        return True, result

    def _record_failure(self, lifecycle_kind: str, exception: Exception) -> None:
        observed_at = self._clock.observed_at()
        exception_class = type(exception).__name__
        fingerprint = (lifecycle_kind, exception_class)
        occurrence_count = self._diagnostics.failed_write_count + 1
        changed = self._active_failure != fingerprint
        self._active_failure = fingerprint
        self._diagnostics = BridgeDiagnostics(
            health="degraded",
            failed_write_count=occurrence_count,
            last_failure_at=observed_at,
            last_exception_class=exception_class,
            last_lifecycle_kind=lifecycle_kind,
        )
        if changed:
            self._persist_diagnostic(
                observed_at=observed_at,
                health="degraded",
                lifecycle_kind=lifecycle_kind,
                exception_class=exception_class,
                occurrence_count=occurrence_count,
            )

    def _record_recovery(self, lifecycle_kind: str) -> None:
        if self._diagnostics.health != "degraded":
            return
        observed_at = self._clock.observed_at()
        exception_class = self._diagnostics.last_exception_class or "Unknown"
        self._persist_diagnostic(
            observed_at=observed_at,
            health="healthy",
            lifecycle_kind=lifecycle_kind,
            exception_class=exception_class,
            occurrence_count=self._diagnostics.failed_write_count,
        )
        self._active_failure = None
        self._diagnostics = BridgeDiagnostics(
            health="healthy",
            failed_write_count=self._diagnostics.failed_write_count,
            last_failure_at=self._diagnostics.last_failure_at,
            last_exception_class=self._diagnostics.last_exception_class,
            last_lifecycle_kind=self._diagnostics.last_lifecycle_kind,
        )

    def _persist_diagnostic(
        self,
        *,
        observed_at: str,
        health: DiagnosticHealth,
        lifecycle_kind: str,
        exception_class: str,
        occurrence_count: int,
    ) -> None:
        try:
            self._bridge.record_diagnostic(
                observed_at=observed_at,
                health=health,
                lifecycle_kind=lifecycle_kind,
                exception_class=exception_class,
                occurrence_count=occurrence_count,
            )
        except Exception:
            pass
