from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType
from typing import Any

import pytest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "nox_identity_eval.py"


def load_eval_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("nox_identity_eval", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


eval_module = load_eval_module()


def passing_result(case_id: str) -> dict[str, Any]:
    return {
        "case_id": case_id,
        "response": "Reviewed visible response.",
        "engaged": True,
        "hard_invariants": {name: True for name in eval_module.HARD_INVARIANTS},
        "scores": {name: 5 for name in eval_module.DIMENSIONS},
        "notes": "Synthetic scorer contract test.",
    }


def write_results(path: Path, results: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(result, sort_keys=True) + "\n" for result in results),
        encoding="utf-8",
        newline="\n",
    )


def test_corpus_manifest_is_complete_and_deterministic() -> None:
    cases = eval_module.load_corpus()
    first = eval_module.manifest(cases)
    second = eval_module.manifest(cases)

    assert first == second
    assert first["identity_id"] == "nox"
    assert first["case_counts"] == {"core": 12, "diagnostic": 2, "negative": 7}
    assert len(first["case_ids"]) == 21
    assert len(first["identity_sha256"]) == 64


def test_export_cli_uses_direct_identity_vocabulary(tmp_path: Path) -> None:
    args = eval_module.build_parser().parse_args([
        "export",
        "--output",
        str(tmp_path / "cases.jsonl"),
        "--without-identity",
    ])

    assert args.without_identity is True


def test_candidate_cli_is_separate_from_production_integration(tmp_path: Path) -> None:
    args = eval_module.build_parser().parse_args([
        "run-candidate",
        "--output",
        str(tmp_path / "candidate.jsonl"),
    ])

    assert args.command == "run-candidate"


def test_all_pass_review_meets_suite_thresholds(tmp_path: Path) -> None:
    cases = eval_module.load_corpus()
    results_path = tmp_path / "reviews.jsonl"
    write_results(results_path, [passing_result(case["id"]) for case in cases])

    report = eval_module.score_results(cases, results_path)

    assert report["passed"] is True
    assert all(report["gates"].values())
    assert report["rates"] == {
        "hard_invariants": 1.0,
        "core_cases": 1.0,
        "diagnostic_cases": 1.0,
        "negative_cases": 1.0,
    }


def test_diagnostic_failure_is_reported_without_blocking_acceptance(
    tmp_path: Path,
) -> None:
    cases = eval_module.load_corpus()
    results = [passing_result(case["id"]) for case in cases]
    target = next(
        result for result in results if result["case_id"].startswith("diagnostic.")
    )
    target["hard_invariants"]["purposeful_agency"] = False
    target["scores"]["voice"] = 1
    results_path = tmp_path / "reviews.jsonl"
    write_results(results_path, results)

    report = eval_module.score_results(cases, results_path)

    assert report["passed"] is True
    assert report["rates"]["diagnostic_cases"] == 0.5
    diagnostic = next(
        case for case in report["cases"] if case["case_id"] == target["case_id"]
    )
    assert diagnostic["passed"] is False


def test_one_negative_hard_failure_blocks_acceptance(tmp_path: Path) -> None:
    cases = eval_module.load_corpus()
    results = [passing_result(case["id"]) for case in cases]
    target = next(
        result for result in results if result["case_id"].startswith("negative.")
    )
    target["hard_invariants"]["purposeful_agency"] = False
    results_path = tmp_path / "reviews.jsonl"
    write_results(results_path, results)

    report = eval_module.score_results(cases, results_path)

    assert report["passed"] is False
    assert report["gates"]["all_hard_invariants"] is False
    assert report["gates"]["all_negative_cases"] is False


def test_missing_review_is_rejected(tmp_path: Path) -> None:
    cases = eval_module.load_corpus()
    results_path = tmp_path / "reviews.jsonl"
    write_results(results_path, [passing_result(case["id"]) for case in cases[:-1]])

    with pytest.raises(eval_module.CorpusError, match="missing results"):
        eval_module.score_results(cases, results_path)


def test_scoring_binds_reviews_to_candidate_response_hashes(tmp_path: Path) -> None:
    cases = eval_module.load_corpus()
    responses_path = tmp_path / "candidate.jsonl"
    reviews_path = tmp_path / "reviews.jsonl"
    identity = {"id": "nox", "sha256": eval_module.sha256(eval_module.NOX_PATH)}
    responses = []
    reviews = []
    for case in cases:
        response = f"Visible response for {case['id']}"
        responses.append({
            "case_id": case["id"],
            "case_sha256": eval_module.case_sha256(case),
            "identity": identity,
            "response": response,
            "runner": eval_module.CANDIDATE_RUNNER_ID,
        })
        review = passing_result(case["id"])
        review.pop("response")
        review["reviewed_response_sha256"] = eval_module.text_sha256(response)
        reviews.append(review)
    write_results(responses_path, responses)
    write_results(reviews_path, reviews)

    report = eval_module.score_results(cases, reviews_path, responses_path)

    assert report["passed"] is True
    assert report["evidence"] == {
        "responses_sha256": eval_module.sha256(responses_path),
        "reviews_sha256": eval_module.sha256(reviews_path),
    }

    reviews[0]["reviewed_response_sha256"] = "0" * 64
    write_results(reviews_path, reviews)
    with pytest.raises(eval_module.CorpusError, match="reviewed response"):
        eval_module.score_results(cases, reviews_path, responses_path)


def test_baseline_failure_keeps_previous_complete_output(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cases = eval_module.load_corpus()[:1]
    output = tmp_path / "baseline.jsonl"
    output.write_text("previous-complete-evidence\n", encoding="utf-8")

    def timeout(*args: object, **kwargs: object) -> object:
        raise eval_module.subprocess.TimeoutExpired(cmd="worker", timeout=1)

    monkeypatch.setattr(eval_module.subprocess, "run", timeout)

    with pytest.raises(eval_module.CorpusError, match="timed out"):
        eval_module.run_baseline(
            cases,
            output,
            max_tokens=32,
            model="test-model",
            provider="test-provider",
            reasoning_effort="medium",
            resume=False,
            suite="all",
            timeout_seconds=1,
        )

    assert output.read_text(encoding="utf-8") == "previous-complete-evidence\n"
    assert output.with_name("baseline.jsonl.partial").is_file()


def test_complete_baseline_is_case_bound_and_atomically_promoted(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cases = eval_module.load_corpus()[:2]
    output = tmp_path / "baseline.jsonl"

    class Completed:
        returncode = 0
        stderr = ""
        stdout = "Visible response"

    commands: list[list[str]] = []

    def complete(command: list[str], **kwargs: object) -> Completed:
        commands.append(command)
        return Completed()

    monkeypatch.setattr(eval_module.subprocess, "run", complete)

    eval_module.run_baseline(
        cases,
        output,
        max_tokens=32,
        model="test-model",
        provider="test-provider",
        reasoning_effort="medium",
        resume=False,
        suite="all",
        timeout_seconds=1,
    )

    records = [
        json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()
    ]
    assert len(records) == 2
    assert not output.with_name("baseline.jsonl.partial").exists()
    assert all(record["runner"] == eval_module.BASELINE_RUNNER_ID for record in records)
    assert all(record["reasoning_effort"] == "medium" for record in records)
    assert records[0]["case_sha256"] == eval_module.case_sha256(cases[0])
    assert all(
        command[command.index("--max-tokens") + 1] == "32" for command in commands
    )


def test_complete_candidate_is_bound_to_identity_revision(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    cases = eval_module.load_corpus()[:1]
    output = tmp_path / "candidate.jsonl"

    class Completed:
        returncode = 0
        stderr = ""
        stdout = "Visible response"

    commands: list[list[str]] = []

    def complete(command: list[str], **kwargs: object) -> Completed:
        commands.append(command)
        return Completed()

    monkeypatch.setattr(eval_module.subprocess, "run", complete)

    eval_module.run_candidate(
        cases,
        output,
        max_tokens=32,
        model="test-model",
        provider="test-provider",
        reasoning_effort="medium",
        resume=False,
        suite="all",
        timeout_seconds=1,
    )

    record = json.loads(output.read_text(encoding="utf-8"))
    assert record["runner"] == eval_module.CANDIDATE_RUNNER_ID
    assert record["identity"] == {
        "id": "nox",
        "sha256": eval_module.sha256(eval_module.NOX_PATH),
    }
    assert "--with-identity" in commands[0]


def test_zai_rejected_identity_marker_is_exact_and_redundant() -> None:
    prompt = (
        "You are Hermes Agent. "
        + eval_module.ZAI_CODING_REJECTED_IDENTITY
        + "Use the normal runtime guidance."
    )

    normalized = prompt.replace(eval_module.ZAI_CODING_REJECTED_IDENTITY, "")

    assert normalized == "You are Hermes Agent. Use the normal runtime guidance."


def test_prompt_report_proves_order_without_storing_prompt_text() -> None:
    report = eval_module.build_prompt_report()

    assert report["identity"]["revision"] == eval_module.sha256(eval_module.NOX_PATH)
    assert all(report["ordering"].values())
    rendered = json.dumps(report, ensure_ascii=False)
    assert "I'm Nox" not in rendered
    assert "Task 3 additive profile fixture." not in rendered


@pytest.mark.parametrize("include_identity", [False, True])
def test_no_tools_worker_disables_persistence_before_running_turn(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    include_identity: bool,
) -> None:
    observed: dict[str, object] = {}
    runtime_module = ModuleType("hermes_cli.runtime_provider")
    setattr(
        runtime_module,
        "resolve_runtime_provider",
        lambda **_kwargs: {
            "api_key": "test-key",
            "api_mode": "chat_completions",
            "base_url": "https://example.test/v1",
            "credential_pool": None,
            "provider": "test-provider",
        },
    )

    class FakeAgent:
        def __init__(self, **kwargs: object) -> None:
            self._persist_disabled = False
            self._session_db = object()
            self._session_json_enabled = True
            self._cached_system_prompt = ""
            self.load_soul_identity = kwargs.get("load_soul_identity")
            self.reasoning_config = kwargs.get("reasoning_config")
            self.skip_context_files = kwargs.get("skip_context_files")
            self.skip_memory = kwargs.get("skip_memory")

        def _build_system_prompt(self) -> str:
            return "Hermes default identity"

        def run_conversation(self, prompt: str) -> dict[str, object]:
            observed.update({
                "persist_disabled": self._persist_disabled,
                "prompt": prompt,
                "reasoning_config": self.reasoning_config,
                "session_db": self._session_db,
                "session_json_enabled": self._session_json_enabled,
                "load_soul_identity": self.load_soul_identity,
                "skip_context_files": self.skip_context_files,
                "skip_memory": self.skip_memory,
                "system_prompt": self._cached_system_prompt,
            })
            return {"final_response": "4", "failed": False, "partial": False}

    agent_module = ModuleType("run_agent")
    setattr(agent_module, "AIAgent", FakeAgent)
    monkeypatch.setitem(sys.modules, "hermes_cli.runtime_provider", runtime_module)
    monkeypatch.setitem(sys.modules, "run_agent", agent_module)
    monkeypatch.setenv("HERMES_YOLO_MODE", "0")

    exit_code = eval_module.run_no_tools_worker(
        include_identity=include_identity,
        max_tokens=32,
        model="test-model",
        prompt="what is 2 + 2?",
        provider="test-provider",
        reasoning_effort="medium",
    )

    assert exit_code == 0
    assert observed == {
        "persist_disabled": True,
        "prompt": "what is 2 + 2?",
        "reasoning_config": {"effort": "medium"},
        "session_db": None,
        "session_json_enabled": False,
        "load_soul_identity": False,
        "skip_context_files": True,
        "skip_memory": True,
        "system_prompt": "Hermes default identity",
    }
    assert capsys.readouterr().out.strip() == "4"
