"""Production lifecycle hooks from the Hermes gateway into the Nox journal."""

from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

import pytest

from nox.causal_bridge import (
    CausalBridge,
    CausalJournalReader,
    CausalCorrelation,
    FailOpenCausalBridge,
    RuntimeRefs,
    SqliteCausalSink,
)
from nox.identity import ACCEPTED_NOX_IDENTITY_SHA256
from tui_gateway import server


REPO_ROOT = Path(__file__).resolve().parents[2]


def _bridge(path: Path, epoch: str) -> tuple[FailOpenCausalBridge, SqliteCausalSink]:
    sink = SqliteCausalSink(
        path,
        process_epoch=epoch,
        started_at=datetime.now(timezone.utc).isoformat(),
        pid=os.getpid(),
    )
    return FailOpenCausalBridge(CausalBridge(sink)), sink


class FakeAgent:
    model = "gpt-5.6-sol"
    provider = "openai-codex"
    reasoning_config = {"enabled": True, "effort": "medium"}
    service_tier = ""

    def __init__(self) -> None:
        self._current_turn_id = ""
        self.calls = 0
        self.interrupt_calls = 0

    def clear_interrupt(self) -> None:
        return None

    def interrupt(self) -> None:
        self.interrupt_calls += 1

    def run_conversation(self, _message: object, **_kwargs: object) -> dict[str, object]:
        self.calls += 1
        self._current_turn_id = "hermes-turn-1"
        return {
            "final_response": "",
            "messages": [],
        }


def _session(agent: FakeAgent, bridge: FailOpenCausalBridge) -> dict[str, object]:
    ready = threading.Event()
    ready.set()
    return {
        "_nox_causal_bridge": bridge,
        "agent": agent,
        "agent_error": None,
        "agent_ready": ready,
        "attached_images": [],
        "cols": 80,
        "cwd": ".",
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": False,
        "session_key": "hermes-session-1",
        "transport": None,
    }


def _patch_turn_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "_clear_session_context", lambda _tokens: None)
    monkeypatch.setattr(server, "_emit", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_ensure_session_db_row", lambda _session: None)
    monkeypatch.setattr(server, "_get_db", lambda: None)
    monkeypatch.setattr(server, "_get_usage", lambda _agent: {})
    monkeypatch.setattr(server, "_persist_branch_seed", lambda _session: None)
    monkeypatch.setattr(server, "_register_session_cwd", lambda _session: None)
    monkeypatch.setattr(server, "_session_info", lambda _agent, _session: {})
    monkeypatch.setattr(server, "_set_session_context", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(server, "_start_agent_build", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_sync_agent_model_with_config", lambda *_args: None)
    monkeypatch.setattr(server, "_wire_callbacks", lambda _sid: None)


def _wait_for_terminal(session: dict[str, object], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not session.get("running"):
            return
        time.sleep(0.01)
    raise AssertionError("gateway turn did not settle")


def test_prompt_submit_records_one_production_turn(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge, sink = _bridge(tmp_path / "journal.sqlite3", f"epoch-{uuid.uuid4().hex}")
    agent = FakeAgent()
    session = _session(agent, bridge)
    sid = "ui-session-1"
    server._sessions[sid] = session
    _patch_turn_environment(monkeypatch)

    try:
        response = server._methods["prompt.submit"](
            "rpc-1",
            {"session_id": sid, "text": "hello"},
        )
        assert response["result"]["status"] == "streaming"
        _wait_for_terminal(session)

        records = sink.records()
        assert [record.kind for record in records] == [
            "external.admitted",
            "turn.started",
            "turn.bound",
            "turn.completed",
        ]
        assert agent.calls == 1
        assert records[1].identity_sha256 == (
            f"sha256:{ACCEPTED_NOX_IDENTITY_SHA256}"
        )
        assert records[1].provider == "openai-codex"
        assert records[1].model == "gpt-5.6-sol"
        assert records[-1].hermes_turn_id == "hermes-turn-1"
    finally:
        server._sessions.pop(sid, None)
        sink.close()


def test_agent_init_failure_settles_admission_without_start(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge, sink = _bridge(tmp_path / "journal.sqlite3", f"epoch-{uuid.uuid4().hex}")
    agent = FakeAgent()
    session = _session(agent, bridge)
    session["agent_error"] = "agent unavailable"
    sid = "ui-session-init-error"
    server._sessions[sid] = session
    _patch_turn_environment(monkeypatch)

    try:
        response = server._methods["prompt.submit"](
            "rpc-init-error",
            {"session_id": sid, "text": "hello"},
        )
        assert response["result"]["status"] == "streaming"
        _wait_for_terminal(session)

        records = sink.records()
        assert [record.kind for record in records] == [
            "external.admitted",
            "turn.errored",
        ]
        assert records[-1].stage == "agent-init"
        assert agent.calls == 0
    finally:
        server._sessions.pop(sid, None)
        sink.close()


def test_model_error_records_started_turn_and_error_terminal(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge, sink = _bridge(tmp_path / "journal.sqlite3", f"epoch-{uuid.uuid4().hex}")

    class FailingAgent(FakeAgent):
        def run_conversation(
            self, _message: object, **_kwargs: object
        ) -> dict[str, object]:
            self.calls += 1
            self._current_turn_id = "hermes-turn-error"
            return {
                "error": "provider failure",
                "failed": True,
                "final_response": None,
                "messages": [],
            }

    agent = FailingAgent()
    session = _session(agent, bridge)
    sid = "ui-session-model-error"
    server._sessions[sid] = session
    _patch_turn_environment(monkeypatch)

    try:
        server._methods["prompt.submit"](
            "rpc-model-error",
            {"session_id": sid, "text": "hello"},
        )
        _wait_for_terminal(session)

        assert [record.kind for record in sink.records()] == [
            "external.admitted",
            "turn.started",
            "turn.bound",
            "turn.errored",
        ]
        assert agent.calls == 1
    finally:
        server._sessions.pop(sid, None)
        sink.close()


def test_terminal_tracks_a_compression_rotated_hermes_session(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge, sink = _bridge(tmp_path / "journal.sqlite3", f"epoch-{uuid.uuid4().hex}")
    agent = FakeAgent()
    session = _session(agent, bridge)
    sid = "ui-session-compressed"
    server._sessions[sid] = session
    _patch_turn_environment(monkeypatch)
    monkeypatch.setattr(
        server,
        "_sync_session_key_after_compress",
        lambda _sid, active, **_kwargs: active.__setitem__(
            "session_key", "hermes-session-2"
        ),
    )

    try:
        server._methods["prompt.submit"](
            "rpc-compressed",
            {"session_id": sid, "text": "compress this turn"},
        )
        _wait_for_terminal(session)

        records = sink.records()
        assert records[1].kind == "turn.started"
        assert records[1].hermes_session_id == "hermes-session-1"
        assert records[-2].kind == "turn.bound"
        assert records[-2].hermes_session_id == "hermes-session-2"
        assert records[-1].kind == "turn.completed"
        assert records[-1].hermes_session_id == "hermes-session-2"
        audit = CausalJournalReader(sink.path).verify()
        assert audit.turns[0].hermes_session_ids == (
            "hermes-session-1",
            "hermes-session-2",
        )
    finally:
        server._sessions.pop(sid, None)
        sink.close()


def test_session_interrupt_records_request_and_interrupted_terminal(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge, sink = _bridge(tmp_path / "journal.sqlite3", f"epoch-{uuid.uuid4().hex}")
    started = threading.Event()
    release = threading.Event()

    class InterruptibleAgent(FakeAgent):
        def interrupt(self) -> None:
            super().interrupt()
            release.set()

        def run_conversation(
            self, _message: object, **_kwargs: object
        ) -> dict[str, object]:
            self.calls += 1
            self._current_turn_id = "hermes-turn-interrupted"
            started.set()
            assert release.wait(5)
            return {"final_response": "", "interrupted": True, "messages": []}

    agent = InterruptibleAgent()
    session = _session(agent, bridge)
    sid = "ui-session-interrupt"
    server._sessions[sid] = session
    _patch_turn_environment(monkeypatch)
    monkeypatch.setattr(server, "_clear_pending", lambda _sid: None)

    try:
        server._methods["prompt.submit"](
            "rpc-interrupt",
            {"session_id": sid, "text": "long turn"},
        )
        assert started.wait(5)
        response = server._methods["session.interrupt"](
            "rpc-stop",
            {"session_id": sid},
        )
        assert response["result"]["status"] == "interrupted"
        _wait_for_terminal(session)

        assert [record.kind for record in sink.records()] == [
            "external.admitted",
            "turn.started",
            "interrupt.requested",
            "turn.bound",
            "turn.interrupted",
        ]
        assert agent.calls == 1
        assert agent.interrupt_calls == 1
    finally:
        release.set()
        server._sessions.pop(sid, None)
        sink.close()


def test_busy_steer_joins_the_active_turn_without_another_model_call(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge, sink = _bridge(tmp_path / "journal.sqlite3", f"epoch-{uuid.uuid4().hex}")
    started = threading.Event()
    release = threading.Event()

    class SteerableAgent(FakeAgent):
        def __init__(self) -> None:
            super().__init__()
            self.steered: list[str] = []

        def steer(self, text: str) -> bool:
            self.steered.append(text)
            return True

        def run_conversation(
            self, _message: object, **_kwargs: object
        ) -> dict[str, object]:
            self.calls += 1
            self._current_turn_id = "hermes-turn-steered"
            started.set()
            assert release.wait(5)
            return {"final_response": "", "messages": []}

    agent = SteerableAgent()
    session = _session(agent, bridge)
    sid = "ui-session-steer"
    server._sessions[sid] = session
    _patch_turn_environment(monkeypatch)
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")

    try:
        server._methods["prompt.submit"](
            "rpc-active",
            {"session_id": sid, "text": "start"},
        )
        assert started.wait(5)
        response = server._methods["prompt.submit"](
            "rpc-steer",
            {"session_id": sid, "text": "adjust"},
        )
        assert response["result"]["status"] == "steered"
        release.set()
        _wait_for_terminal(session)

        records = sink.records()
        assert [record.kind for record in records] == [
            "external.admitted",
            "turn.started",
            "external.admitted",
            "turn.steered",
            "turn.bound",
            "turn.completed",
        ]
        assert records[3].admission_ids == (
            *records[0].admission_ids,
            *records[2].admission_ids,
        )
        assert agent.steered == ["adjust"]
        assert agent.calls == 1
    finally:
        release.set()
        server._sessions.pop(sid, None)
        sink.close()


def test_busy_queue_carries_every_external_admission_to_one_turn(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge, sink = _bridge(tmp_path / "journal.sqlite3", f"epoch-{uuid.uuid4().hex}")
    agent = FakeAgent()
    session = _session(agent, bridge)
    session["running"] = True
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "queue")

    first = bridge.admit_external(
        rpc_request_id="rpc-2",
        hermes_ui_session_id="ui-session-1",
        hermes_session_id="hermes-session-1",
        prompt="first",
    )
    second = bridge.admit_external(
        rpc_request_id="rpc-3",
        hermes_ui_session_id="ui-session-1",
        hermes_session_id="hermes-session-1",
        prompt="second",
    )
    try:
        server._handle_busy_submit(
            "rpc-2", "ui-session-1", session, "first", None, first
        )
        server._handle_busy_submit(
            "rpc-3", "ui-session-1", session, "second", None, second
        )

        captured: dict[str, object] = {}

        def capture_run(*_args: object, **kwargs: object) -> None:
            captured.update(kwargs)

        monkeypatch.setattr(server, "_run_prompt_submit", capture_run)
        session["running"] = False
        assert server._drain_queued_prompt(
            "rpc-drain", "ui-session-1", session
        )

        merged = captured["correlation"]
        assert isinstance(merged, CausalCorrelation)
        assert merged.origin == "queued-external"
        assert merged.admission_ids == (
            *first.admission_ids,
            *second.admission_ids,
        )
        assert [record.kind for record in sink.records()] == [
            "external.admitted",
            "external.admitted",
            "turn.queued",
            "turn.queued",
        ]
    finally:
        sink.close()


def test_bridge_open_failure_is_visible_and_does_not_escape(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    session = {"profile_home": str(tmp_path / "unavailable-profile")}

    def fail_open(*_args: object, **_kwargs: object) -> None:
        raise PermissionError("unavailable")

    monkeypatch.setattr(server, "SqliteCausalSink", fail_open)

    assert server._nox_bridge(session) is None
    diagnostics = server._nox_bridge_diagnostics(session)
    assert diagnostics == {
        "failed_write_count": 1,
        "health": "degraded",
        "last_exception_class": "PermissionError",
        "last_lifecycle_kind": "bridge.open",
    }


def test_gateway_resume_reconciles_prior_process_once_per_resume(
    tmp_path: Path,
) -> None:
    path = tmp_path / "journal.sqlite3"
    first_bridge, first_sink = _bridge(path, f"epoch-{uuid.uuid4().hex}")
    correlation = first_bridge.admit_external(
        rpc_request_id="rpc-crash",
        hermes_ui_session_id="old-ui",
        hermes_session_id="hermes-session-1",
        prompt="unfinished",
    )
    first_bridge.start(
        correlation,
        runtime=RuntimeRefs(
            hermes_ui_session_id="old-ui",
            hermes_session_id="hermes-session-1",
            provider="openai-codex",
            model="gpt-5.6-sol",
            identity_sha256=f"sha256:{ACCEPTED_NOX_IDENTITY_SHA256}",
        ),
    )
    first_sink.close()

    second_bridge, second_sink = _bridge(path, f"epoch-{uuid.uuid4().hex}")
    session = {"_nox_causal_bridge": second_bridge}
    try:
        server._nox_observe_resume("new-ui", session, "hermes-session-1")
        server._nox_observe_resume("new-ui", session, "hermes-session-1")

        kinds = [record.kind for record in second_sink.records()]
        assert kinds.count("turn.abandoned") == 1
        assert kinds.count("session.resumed") == 2
    finally:
        second_sink.close()


def test_gateway_resume_reconciles_after_forced_process_kill(tmp_path: Path) -> None:
    path = tmp_path / "journal.sqlite3"
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            """
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
import time
from nox.causal_bridge import CausalBridge, RuntimeRefs, SqliteCausalSink

path = Path(sys.argv[1])
sink = SqliteCausalSink(
    path,
    process_epoch=f"child-{os.getpid()}",
    started_at=datetime.now(timezone.utc).isoformat(),
    pid=os.getpid(),
)
bridge = CausalBridge(sink)
correlation = bridge.admit_external(
    rpc_request_id="rpc-killed",
    hermes_ui_session_id="old-ui",
    hermes_session_id="hermes-session-killed",
    prompt="unfinished",
)
bridge.start(
    correlation,
    runtime=RuntimeRefs(
        hermes_ui_session_id="old-ui",
        hermes_session_id="hermes-session-killed",
        provider="openai-codex",
        model="gpt-5.6-sol",
        identity_sha256="sha256:"
        + "5d65771dfeec0ad50897fac123dfe4f358944d706edc5cc4fb9d7475b2f86a78",
    ),
)
print("ready", flush=True)
time.sleep(60)
""",
            str(path),
        ],
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert child.stdout is not None
        assert child.stdout.readline().strip() == "ready"
        child.kill()
        child.wait(timeout=10)

        bridge, sink = _bridge(path, f"parent-{uuid.uuid4().hex}")
        try:
            server._nox_observe_resume(
                "new-ui",
                {"_nox_causal_bridge": bridge},
                "hermes-session-killed",
            )
            records = sink.records()
            assert [record.kind for record in records][-2:] == [
                "turn.abandoned",
                "session.resumed",
            ]
        finally:
            sink.close()
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
