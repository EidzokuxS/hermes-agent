#!/usr/bin/env python3
"""Validate, export, and score the model-agnostic Nox identity eval corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import statistics
import subprocess
import sys
import tempfile
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

import yaml


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
IDENTITY_DIR = ROOT / "identity"
NOX_PATH = IDENTITY_DIR / "NOX.md"
EVAL_DIR = IDENTITY_DIR / "evals"
CORE_PATH = EVAL_DIR / "cases.yaml"
NEGATIVE_PATH = EVAL_DIR / "negative-cases.yaml"
DIAGNOSTIC_PATH = EVAL_DIR / "style-diagnostics.yaml"
RUBRIC_PATH = EVAL_DIR / "rubric.md"

SCHEMA_VERSION = 3
SUITES = {"core", "diagnostic", "negative"}
ACCEPTANCE_SUITES = {"core", "negative"}
ROLES = {"assistant", "user"}
DIMENSIONS = {
    "epistemic_posture",
    "judgment",
    "self_definition",
    "substance",
    "voice",
}
HARD_INVARIANTS = {
    "epistemic_honesty",
    "identity_nox",
    "purposeful_agency",
    "system_grounding",
    "task_engagement",
}
MEDIAN_GATES = {"epistemic_posture", "self_definition", "voice"}
BASELINE_RUNNER_ID = "hermes-no-tools-v4"
CANDIDATE_RUNNER_ID = "nox-identity-no-tools-v3"
ZAI_CODING_REJECTED_IDENTITY = "You run on Hermes Agent (by Nous Research). "


class CorpusError(ValueError):
    """Raised when corpus or review data violates the eval contract."""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def case_sha256(case: dict[str, Any]) -> str:
    payload = json.dumps(
        case, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_yaml(path: Path) -> dict[str, Any]:
    try:
        value = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, yaml.YAMLError) as exc:
        raise CorpusError(f"cannot load {path.relative_to(ROOT)}: {exc}") from exc
    if not isinstance(value, dict):
        raise CorpusError(f"{path.relative_to(ROOT)} must contain a mapping")
    return value


def require_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CorpusError(f"{field} must be a non-empty string")
    return value


def require_text_list(value: Any, field: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise CorpusError(f"{field} must be a non-empty list")
    return [require_text(item, f"{field}[]") for item in value]


def validate_case(raw: Any, suite: str, index: int) -> dict[str, Any]:
    prefix = f"{suite}.cases[{index}]"
    if not isinstance(raw, dict):
        raise CorpusError(f"{prefix} must be a mapping")

    case_id = require_text(raw.get("id"), f"{prefix}.id")
    if not case_id.startswith(f"{suite}."):
        raise CorpusError(f"{prefix}.id must begin with {suite}.")
    category = require_text(raw.get("category"), f"{prefix}.category")

    messages = raw.get("messages")
    if not isinstance(messages, list) or not messages:
        raise CorpusError(f"{prefix}.messages must be a non-empty list")
    normalized_messages: list[dict[str, str]] = []
    previous_role: str | None = None
    for message_index, message in enumerate(messages):
        message_field = f"{prefix}.messages[{message_index}]"
        if not isinstance(message, dict):
            raise CorpusError(f"{message_field} must be a mapping")
        role = require_text(message.get("role"), f"{message_field}.role")
        if role not in ROLES:
            raise CorpusError(f"{message_field}.role must be one of {sorted(ROLES)}")
        if role == previous_role:
            raise CorpusError(f"{message_field}.role must alternate")
        content = require_text(message.get("content"), f"{message_field}.content")
        normalized_messages.append({"role": role, "content": content})
        previous_role = role
    if normalized_messages[-1]["role"] != "user":
        raise CorpusError(f"{prefix}.messages must end with a user turn")

    evaluates = require_text_list(raw.get("evaluates"), f"{prefix}.evaluates")
    unknown_dimensions = set(evaluates) - DIMENSIONS
    if unknown_dimensions:
        raise CorpusError(
            f"{prefix}.evaluates contains unknown dimensions: {sorted(unknown_dimensions)}"
        )

    return {
        "id": case_id,
        "suite": suite,
        "category": category,
        "messages": normalized_messages,
        "evaluates": evaluates,
        "expected": require_text_list(raw.get("expected"), f"{prefix}.expected"),
    }


def load_corpus() -> list[dict[str, Any]]:
    missing = [
        path.relative_to(ROOT).as_posix()
        for path in (NOX_PATH, CORE_PATH, NEGATIVE_PATH, DIAGNOSTIC_PATH, RUBRIC_PATH)
        if not path.is_file()
    ]
    if missing:
        raise CorpusError(f"missing required files: {', '.join(missing)}")
    if not NOX_PATH.read_text(encoding="utf-8").strip():
        raise CorpusError("identity/NOX.md is empty")
    if not RUBRIC_PATH.read_text(encoding="utf-8").strip():
        raise CorpusError("identity/evals/rubric.md is empty")

    cases: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for path, expected_suite in (
        (CORE_PATH, "core"),
        (NEGATIVE_PATH, "negative"),
        (DIAGNOSTIC_PATH, "diagnostic"),
    ):
        document = load_yaml(path)
        if document.get("schema_version") != SCHEMA_VERSION:
            raise CorpusError(
                f"{path.relative_to(ROOT)} schema_version must be {SCHEMA_VERSION}"
            )
        if document.get("suite") != expected_suite:
            raise CorpusError(
                f"{path.relative_to(ROOT)} suite must be {expected_suite}"
            )
        raw_cases = document.get("cases")
        if not isinstance(raw_cases, list) or not raw_cases:
            raise CorpusError(
                f"{path.relative_to(ROOT)} cases must be a non-empty list"
            )
        for index, raw_case in enumerate(raw_cases):
            case = validate_case(raw_case, expected_suite, index)
            if case["id"] in seen_ids:
                raise CorpusError(f"duplicate case id: {case['id']}")
            seen_ids.add(case["id"])
            cases.append(case)

    if not any(case["suite"] == "core" for case in cases):
        raise CorpusError("core suite has no cases")
    if not any(case["suite"] == "negative" for case in cases):
        raise CorpusError("negative suite has no cases")
    if not any(case["suite"] == "diagnostic" for case in cases):
        raise CorpusError("diagnostic suite has no cases")
    return cases


def manifest(cases: list[dict[str, Any]]) -> dict[str, Any]:
    files = [NOX_PATH, CORE_PATH, NEGATIVE_PATH, DIAGNOSTIC_PATH, RUBRIC_PATH]
    return {
        "schema_version": SCHEMA_VERSION,
        "identity_id": "nox",
        "identity_sha256": sha256(NOX_PATH),
        "files": {path.relative_to(ROOT).as_posix(): sha256(path) for path in files},
        "case_counts": {
            suite: sum(case["suite"] == suite for case in cases)
            for suite in sorted(SUITES)
        },
        "case_ids": [case["id"] for case in cases],
    }


def export_cases(
    cases: list[dict[str, Any]], output: Path, *, include_identity: bool, suite: str
) -> None:
    system = NOX_PATH.read_text(encoding="utf-8").strip() if include_identity else ""
    selected = [case for case in cases if suite == "all" or case["suite"] == suite]
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="\n") as handle:
        for case in selected:
            record = {
                **case,
                "identity": {
                    "id": "nox" if include_identity else None,
                    "sha256": sha256(NOX_PATH) if include_identity else None,
                    "system": system,
                },
            }
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def render_case_prompt(case: dict[str, Any]) -> str:
    messages = case["messages"]
    if len(messages) == 1 and messages[0]["role"] == "user":
        return messages[0]["content"]
    transcript = "\n\n".join(
        f"{message['role'].upper()}: {message['content']}" for message in messages
    )
    return f"Continue this conversation by answering the final USER message.\n\n{transcript}"


def run_baseline(
    cases: list[dict[str, Any]],
    output: Path,
    *,
    model: str,
    max_tokens: int,
    provider: str,
    reasoning_effort: str,
    resume: bool,
    suite: str,
    timeout_seconds: int,
) -> None:
    run_evaluation(
        cases,
        output,
        include_identity=False,
        max_tokens=max_tokens,
        model=model,
        provider=provider,
        reasoning_effort=reasoning_effort,
        resume=resume,
        suite=suite,
        timeout_seconds=timeout_seconds,
    )


def run_candidate(
    cases: list[dict[str, Any]],
    output: Path,
    *,
    model: str,
    max_tokens: int,
    provider: str,
    reasoning_effort: str,
    resume: bool,
    suite: str,
    timeout_seconds: int,
) -> None:
    run_evaluation(
        cases,
        output,
        include_identity=True,
        max_tokens=max_tokens,
        model=model,
        provider=provider,
        reasoning_effort=reasoning_effort,
        resume=resume,
        suite=suite,
        timeout_seconds=timeout_seconds,
    )


def run_evaluation(
    cases: list[dict[str, Any]],
    output: Path,
    *,
    include_identity: bool,
    model: str,
    max_tokens: int,
    provider: str,
    reasoning_effort: str,
    resume: bool,
    suite: str,
    timeout_seconds: int,
) -> None:
    runner_id = CANDIDATE_RUNNER_ID if include_identity else BASELINE_RUNNER_ID
    identity = {"id": "nox", "sha256": sha256(NOX_PATH)} if include_identity else None
    selected = [case for case in cases if suite == "all" or case["suite"] == suite]
    selected_ids = {case["id"] for case in selected}
    case_by_id = {case["id"]: case for case in selected}
    output.parent.mkdir(parents=True, exist_ok=True)
    partial_output = output.with_name(f"{output.name}.partial")
    completed_ids: set[str] = set()
    retained_records: list[dict[str, Any]] = []
    resume_source = None
    if resume:
        if partial_output.is_file():
            resume_source = partial_output
        elif output.is_file():
            resume_source = output
    if resume_source is not None:
        for record in load_results(resume_source):
            case_id = require_text(record.get("case_id"), "baseline.case_id")
            if case_id not in selected_ids:
                continue
            if record.get("runner") != runner_id:
                continue
            if record.get("case_sha256") != case_sha256(case_by_id[case_id]):
                continue
            if case_id in completed_ids:
                raise CorpusError(f"duplicate baseline result for case: {case_id}")
            if record.get("model") != model or record.get("provider") != provider:
                raise CorpusError(
                    f"baseline result {case_id} does not match {provider}/{model}"
                )
            if record.get("reasoning_effort") != reasoning_effort:
                raise CorpusError(
                    f"baseline result {case_id} does not match {reasoning_effort} effort"
                )
            if record.get("identity") != identity:
                raise CorpusError(
                    f"result {case_id} does not match the selected identity revision"
                )
            completed_ids.add(case_id)
            retained_records.append(record)
        partial_output.write_text(
            "".join(
                json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n"
                for record in retained_records
            ),
            encoding="utf-8",
            newline="\n",
        )
    pending = [case for case in selected if case["id"] not in completed_ids]
    mode = "a" if resume_source is not None else "w"
    failures: list[str] = []
    with (
        tempfile.TemporaryDirectory(prefix="nox-identity-baseline-") as isolated_cwd,
        partial_output.open(mode, encoding="utf-8", newline="\n") as handle,
    ):
        for index, case in enumerate(pending, start=1):
            completed = len(completed_ids) + index
            print(f"[{completed}/{len(selected)}] {case['id']}", flush=True)
            command = [
                sys.executable,
                str(Path(__file__).resolve()),
                "_worker",
                "--provider",
                provider,
                "--model",
                model,
                "--max-tokens",
                str(max_tokens),
                "--reasoning-effort",
                reasoning_effort,
                "--prompt",
                render_case_prompt(case),
            ]
            if include_identity:
                command.append("--with-identity")
            try:
                environment = os.environ.copy()
                completed = subprocess.run(
                    command,
                    cwd=isolated_cwd,
                    capture_output=True,
                    check=False,
                    encoding="utf-8",
                    env=environment,
                    errors="replace",
                    timeout=timeout_seconds,
                )
            except subprocess.TimeoutExpired:
                failure = f"{case['id']}: timed out after {timeout_seconds}s"
                failures.append(failure)
                print(f"FAILED {failure}", file=sys.stderr, flush=True)
                continue
            if completed.returncode != 0:
                error = (completed.stderr or completed.stdout).strip()
                failure = f"{case['id']}: exit {completed.returncode}: {error}"
                failures.append(failure)
                print(f"FAILED {failure}", file=sys.stderr, flush=True)
                continue
            response = completed.stdout.strip()
            if not response:
                failure = f"{case['id']}: empty response"
                failures.append(failure)
                print(f"FAILED {failure}", file=sys.stderr, flush=True)
                continue
            record = {
                "case_sha256": case_sha256(case),
                "case_id": case["id"],
                "identity": identity,
                "model": model,
                "provider": provider,
                "reasoning_effort": reasoning_effort,
                "response": response,
                "runner": runner_id,
                "suite": case["suite"],
            }
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
    if failures:
        raise CorpusError(
            "baseline completed with failed cases; rerun with --resume: "
            + "; ".join(failures)
        )
    if len(completed_ids) + len(pending) != len(selected):
        raise CorpusError("baseline did not settle every selected case")
    partial_output.replace(output)


def run_no_tools_worker(
    *,
    include_identity: bool = False,
    max_tokens: int,
    model: str,
    prompt: str,
    provider: str,
    reasoning_effort: str,
) -> int:
    """Run one isolated Hermes turn with no tools, memory, or project rules."""
    import run_agent
    from hermes_cli.runtime_provider import resolve_runtime_provider

    os.environ["HERMES_YOLO_MODE"] = "1"
    logging.disable(logging.CRITICAL)
    runtime = resolve_runtime_provider(requested=provider, target_model=model)
    identity_override = nullcontext()
    if not include_identity:
        # Task 3 makes Nox the production identity. The historical Hermes
        # comparison now needs an explicit, worker-local baseline seam; the
        # candidate follows the unmodified production prompt path.
        import agent.system_prompt as system_prompt_module
        from agent.prompt_builder import DEFAULT_AGENT_IDENTITY
        from nox.identity import NoxIdentitySnapshot

        baseline = NoxIdentitySnapshot(
            revision="hermes-baseline",
            prompt_sha256=text_sha256(DEFAULT_AGENT_IDENTITY),
            prompt_text=DEFAULT_AGENT_IDENTITY,
        )
        identity_override = patch.object(
            system_prompt_module,
            "bound_nox_identity",
            return_value=baseline,
        )

    with identity_override, open(os.devnull, "w", encoding="utf-8") as devnull:
        with redirect_stdout(devnull), redirect_stderr(devnull):
            agent = run_agent.AIAgent(
                api_key=cast(str, runtime.get("api_key")),
                base_url=cast(str, runtime.get("base_url")),
                provider=cast(str, runtime.get("provider")),
                api_mode=cast(str, runtime.get("api_mode")),
                model=model,
                max_iterations=8,
                max_tokens=max_tokens,
                reasoning_config={"effort": reasoning_effort},
                enabled_toolsets=[],
                load_soul_identity=False,
                quiet_mode=True,
                platform="cli",
                session_db=None,
                skip_context_files=True,
                skip_memory=True,
                credential_pool=runtime.get("credential_pool"),
                fallback_model=cast(dict[str, Any], None),
            )
            # This worker is evidence-only. `session_db=None` means "no DB was
            # supplied" and Hermes may lazily open the default state.db; it is
            # not a persistence opt-out. Use the runtime's explicit isolation
            # switch so no eval input or output can enter user session state.
            setattr(agent, "_persist_disabled", True)
            agent._session_db = None
            setattr(agent, "_session_json_enabled", False)
            system_prompt = agent._build_system_prompt()
            if "/api/coding/" in str(runtime.get("base_url") or ""):
                system_prompt = system_prompt.replace(
                    ZAI_CODING_REJECTED_IDENTITY,
                    "",
                )
            setattr(agent, "_cached_system_prompt", system_prompt)
            setattr(agent, "suppress_status_output", True)
            setattr(agent, "stream_delta_callback", None)
            setattr(agent, "tool_gen_callback", None)
            result = agent.run_conversation(prompt)
    response = (result.get("final_response") or "").strip()
    if result.get("failed") or result.get("partial"):
        print("nox identity eval worker: provider run failed", file=sys.stderr)
        return 1
    if not response:
        print("nox identity eval worker: no final response", file=sys.stderr)
        return 1
    print(response)
    return 0


def load_results(path: Path) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise CorpusError(
                        f"{path}:{line_number}: invalid JSON: {exc}"
                    ) from exc
                if not isinstance(value, dict):
                    raise CorpusError(f"{path}:{line_number}: result must be an object")
                results.append(value)
    except OSError as exc:
        raise CorpusError(f"cannot read {path}: {exc}") from exc
    return results


def validate_result(
    raw: dict[str, Any], known_ids: set[str], index: int
) -> dict[str, Any]:
    prefix = f"results[{index}]"
    case_id = require_text(raw.get("case_id"), f"{prefix}.case_id")
    if case_id not in known_ids:
        raise CorpusError(f"{prefix}.case_id is unknown: {case_id}")
    require_text(raw.get("response"), f"{prefix}.response")
    if not isinstance(raw.get("engaged"), bool):
        raise CorpusError(f"{prefix}.engaged must be boolean")

    hard = raw.get("hard_invariants")
    if not isinstance(hard, dict) or set(hard) != HARD_INVARIANTS:
        raise CorpusError(
            f"{prefix}.hard_invariants must contain exactly {sorted(HARD_INVARIANTS)}"
        )
    if not all(isinstance(value, bool) for value in hard.values()):
        raise CorpusError(f"{prefix}.hard_invariants values must be boolean")

    scores = raw.get("scores")
    if not isinstance(scores, dict) or set(scores) != DIMENSIONS:
        raise CorpusError(f"{prefix}.scores must contain exactly {sorted(DIMENSIONS)}")
    for dimension, score in scores.items():
        if isinstance(score, bool) or not isinstance(score, int) or not 1 <= score <= 5:
            raise CorpusError(
                f"{prefix}.scores.{dimension} must be an integer from 1 to 5"
            )

    notes = raw.get("notes")
    if notes is not None and not isinstance(notes, str):
        raise CorpusError(f"{prefix}.notes must be a string when present")
    return raw


def bind_review_responses(
    cases: list[dict[str, Any]],
    reviews: list[dict[str, Any]],
    responses_path: Path,
) -> list[dict[str, Any]]:
    case_by_id = {case["id"]: case for case in cases}
    responses: dict[str, str] = {}
    for index, raw in enumerate(load_results(responses_path)):
        prefix = f"responses[{index}]"
        case_id = require_text(raw.get("case_id"), f"{prefix}.case_id")
        if case_id not in case_by_id:
            raise CorpusError(f"{prefix}.case_id is unknown: {case_id}")
        if case_id in responses:
            raise CorpusError(f"duplicate response for case: {case_id}")
        if raw.get("case_sha256") != case_sha256(case_by_id[case_id]):
            raise CorpusError(f"{prefix} does not match the current case revision")
        if raw.get("identity") != {"id": "nox", "sha256": sha256(NOX_PATH)}:
            raise CorpusError(f"{prefix} does not match the current identity revision")
        if raw.get("runner") != CANDIDATE_RUNNER_ID:
            raise CorpusError(f"{prefix} is not a candidate identity result")
        responses[case_id] = require_text(raw.get("response"), f"{prefix}.response")

    missing_responses = sorted(set(case_by_id) - set(responses))
    if missing_responses:
        raise CorpusError(
            "response source is missing cases: " + ", ".join(missing_responses)
        )

    bound: list[dict[str, Any]] = []
    for index, review in enumerate(reviews):
        prefix = f"reviews[{index}]"
        case_id = require_text(review.get("case_id"), f"{prefix}.case_id")
        if case_id not in responses:
            raise CorpusError(f"{prefix}.case_id is absent from response source")
        response = responses[case_id]
        reviewed_hash = require_text(
            review.get("reviewed_response_sha256"),
            f"{prefix}.reviewed_response_sha256",
        )
        if reviewed_hash != text_sha256(response):
            raise CorpusError(f"{prefix} does not match the reviewed response")
        supplied_response = review.get("response")
        if supplied_response is not None and supplied_response != response:
            raise CorpusError(f"{prefix}.response conflicts with the response source")
        bound.append({**review, "response": response})
    return bound


def score_results(
    cases: list[dict[str, Any]],
    results_path: Path,
    responses_path: Path | None = None,
) -> dict[str, Any]:
    case_by_id = {case["id"]: case for case in cases}
    raw_results = load_results(results_path)
    if responses_path is not None:
        raw_results = bind_review_responses(cases, raw_results, responses_path)
    results: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(raw_results):
        result = validate_result(raw, set(case_by_id), index)
        case_id = result["case_id"]
        if case_id in results:
            raise CorpusError(f"duplicate result for case: {case_id}")
        results[case_id] = result

    missing = sorted(set(case_by_id) - set(results))
    if missing:
        raise CorpusError(f"missing results for: {', '.join(missing)}")

    dimensions: dict[str, list[int]] = {dimension: [] for dimension in DIMENSIONS}
    hard_total = 0
    hard_true = 0
    suite_passes = {suite: 0 for suite in SUITES}
    suite_totals = {suite: 0 for suite in SUITES}
    case_results: list[dict[str, Any]] = []

    for case in cases:
        result = results[case["id"]]
        hard_values = list(result["hard_invariants"].values())
        if case["suite"] in ACCEPTANCE_SUITES:
            for dimension, value in result["scores"].items():
                dimensions[dimension].append(value)
            hard_total += len(hard_values)
            hard_true += sum(hard_values)
        mean_score = statistics.fmean(result["scores"].values())
        passed = (
            result["engaged"]
            and all(hard_values)
            and min(result["scores"].values()) >= 3
            and mean_score >= 3.5
        )
        suite = case["suite"]
        suite_totals[suite] += 1
        suite_passes[suite] += int(passed)
        case_results.append({
            "case_id": case["id"],
            "suite": suite,
            "passed": passed,
            "mean_score": round(mean_score, 2),
        })

    medians = {
        dimension: float(statistics.median(values))
        for dimension, values in sorted(dimensions.items())
    }
    core_rate = suite_passes["core"] / suite_totals["core"]
    negative_rate = suite_passes["negative"] / suite_totals["negative"]
    diagnostic_rate = suite_passes["diagnostic"] / suite_totals["diagnostic"]
    hard_rate = hard_true / hard_total
    gates = {
        "all_hard_invariants": hard_rate == 1.0,
        "all_negative_cases": negative_rate == 1.0,
        "core_cases_at_least_90_percent": core_rate >= 0.9,
        "median_gates_at_least_4": all(medians[name] >= 4 for name in MEDIAN_GATES),
    }
    report = {
        "schema_version": SCHEMA_VERSION,
        "identity_id": "nox",
        "identity_sha256": sha256(NOX_PATH),
        "passed": all(gates.values()),
        "gates": gates,
        "rates": {
            "hard_invariants": round(hard_rate, 4),
            "core_cases": round(core_rate, 4),
            "diagnostic_cases": round(diagnostic_rate, 4),
            "negative_cases": round(negative_rate, 4),
        },
        "medians": medians,
        "cases": case_results,
    }
    if responses_path is not None:
        report["evidence"] = {
            "responses_sha256": sha256(responses_path),
            "reviews_sha256": sha256(results_path),
        }
    return report


def build_prompt_report() -> dict[str, Any]:
    """Build a deterministic, content-free report of the production prompt tiers."""
    from datetime import datetime
    from types import SimpleNamespace

    from agent.prompt_builder import HERMES_AGENT_HELP_GUIDANCE
    from agent.system_prompt import build_system_prompt_parts
    from nox.identity import NoxIdentitySnapshot

    profile_fixture = "Task 3 additive profile fixture."
    agent = SimpleNamespace(
        load_soul_identity=True,
        skip_context_files=True,
        valid_tool_names=[],
        _task_completion_guidance=False,
        _tool_use_enforcement=False,
        _environment_probe=False,
        _kanban_worker_guidance="",
        _memory_store=None,
        _memory_manager=None,
        _nox_identity_snapshot=None,
        _preserve_system_prompt_snapshot=False,
        model="gpt-5.6-sol",
        provider="openai-codex",
        platform="cli",
        pass_session_id=True,
        session_id="task3-prompt-evidence",
    )
    with (
        patch("run_agent.load_soul_md", return_value=profile_fixture),
        patch("run_agent.build_nous_subscription_prompt", return_value=""),
        patch("run_agent.build_environment_hints", return_value=""),
        patch("agent.file_safety._resolve_active_profile_name", return_value="default"),
        patch("hermes_time.now", return_value=datetime(2026, 7, 13, 12, 0, 0)),
    ):
        parts = build_system_prompt_parts(agent)

    identity = agent._nox_identity_snapshot
    if not isinstance(identity, NoxIdentitySnapshot):
        raise CorpusError("production prompt did not bind a Nox identity snapshot")
    stable = parts["stable"]
    profile_index = stable.find("## Current profile")
    hermes_index = stable.find(HERMES_AGENT_HELP_GUIDANCE)
    full_prompt = "\n\n".join(
        part for part in (parts["stable"], parts["context"], parts["volatile"]) if part
    )

    def part_record(value: str) -> dict[str, Any]:
        return {"chars": len(value), "sha256": text_sha256(value)}

    return {
        "schema_version": 1,
        "runner": CANDIDATE_RUNNER_ID,
        "identity": {
            "revision": identity.revision,
            "prompt_chars": identity.prompt_chars,
            "prompt_sha256": identity.prompt_sha256,
        },
        "profile_fixture_sha256": text_sha256(profile_fixture),
        "parts": {name: part_record(value) for name, value in parts.items()},
        "full_prompt": part_record(full_prompt),
        "ordering": {
            "identity_is_first": stable.startswith(identity.prompt_text),
            "profile_after_identity": profile_index >= identity.prompt_chars,
            "hermes_guidance_after_profile": hermes_index > profile_index,
            "context_empty": parts["context"] == "",
            "volatile_is_last": full_prompt.endswith(parts["volatile"]),
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("validate", help="Validate Nox and eval corpus schemas")
    subparsers.add_parser(
        "manifest", help="Print deterministic identity and corpus hashes"
    )
    prompt_report_parser = subparsers.add_parser(
        "prompt-report", help="Write deterministic prompt-tier hashes without prompt text"
    )
    prompt_report_parser.add_argument("--output", type=Path, required=True)

    export_parser = subparsers.add_parser(
        "export", help="Export model-agnostic JSONL cases"
    )
    export_parser.add_argument("--output", type=Path, required=True)
    export_parser.add_argument(
        "--suite", choices=["all", *sorted(SUITES)], default="all"
    )
    export_parser.add_argument(
        "--without-identity",
        action="store_true",
        help="Export a comparison baseline with an empty identity system message",
    )

    baseline_parser = subparsers.add_parser(
        "run-baseline",
        help="Run cases through unmodified Hermes without project identity rules",
    )
    candidate_parser = subparsers.add_parser(
        "run-candidate",
        help="Run cases with the current Nox identity in an isolated stable prompt tier",
    )
    for run_parser in (baseline_parser, candidate_parser):
        run_parser.add_argument("--output", type=Path, required=True)
        run_parser.add_argument(
            "--suite", choices=["all", *sorted(SUITES)], default="all"
        )
        run_parser.add_argument("--provider", default="zai")
        run_parser.add_argument("--model", default="glm-5.2")
        run_parser.add_argument("--max-tokens", type=int, default=1024)
        run_parser.add_argument(
            "--reasoning-effort",
            choices=["low", "medium", "high", "xhigh"],
            default="medium",
        )
        run_parser.add_argument("--timeout-seconds", type=int, default=180)
        run_parser.add_argument(
            "--resume",
            action="store_true",
            help="Keep valid existing results and run missing cases",
        )

    worker_parser = subparsers.add_parser("_worker", help=argparse.SUPPRESS)
    worker_parser.add_argument("--provider", required=True)
    worker_parser.add_argument("--model", required=True)
    worker_parser.add_argument("--max-tokens", type=int, required=True)
    worker_parser.add_argument("--reasoning-effort", required=True)
    worker_parser.add_argument("--prompt", required=True)
    worker_parser.add_argument("--with-identity", action="store_true")

    score_parser = subparsers.add_parser(
        "score", help="Validate and score reviewed JSONL results"
    )
    score_parser.add_argument("--results", type=Path, required=True)
    score_parser.add_argument("--responses", type=Path)
    score_parser.add_argument("--output", type=Path)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "_worker":
        return run_no_tools_worker(
            include_identity=args.with_identity,
            max_tokens=args.max_tokens,
            model=args.model,
            prompt=args.prompt,
            provider=args.provider,
            reasoning_effort=args.reasoning_effort,
        )
    try:
        cases = load_corpus()
        if args.command == "validate":
            print(
                json.dumps(
                    {"valid": True, **manifest(cases)},
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                )
            )
            return 0
        if args.command == "manifest":
            print(
                json.dumps(
                    manifest(cases), ensure_ascii=False, indent=2, sort_keys=True
                )
            )
            return 0
        if args.command == "prompt-report":
            report = build_prompt_report()
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(
                json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
                newline="\n",
            )
            print(f"prompt report written to {args.output}")
            return 0
        if args.command == "export":
            export_cases(
                cases,
                args.output,
                include_identity=not args.without_identity,
                suite=args.suite,
            )
            print(f"exported {args.output}")
            return 0
        if args.command == "run-baseline":
            run_baseline(
                cases,
                args.output,
                max_tokens=args.max_tokens,
                model=args.model,
                provider=args.provider,
                reasoning_effort=args.reasoning_effort,
                resume=args.resume,
                suite=args.suite,
                timeout_seconds=args.timeout_seconds,
            )
            print(f"baseline written to {args.output}")
            return 0
        if args.command == "run-candidate":
            run_candidate(
                cases,
                args.output,
                max_tokens=args.max_tokens,
                model=args.model,
                provider=args.provider,
                reasoning_effort=args.reasoning_effort,
                resume=args.resume,
                suite=args.suite,
                timeout_seconds=args.timeout_seconds,
            )
            print(f"candidate written to {args.output}")
            return 0
        if args.command == "score":
            report = score_results(cases, args.results, args.responses)
            rendered = (
                json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
            )
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(rendered, encoding="utf-8", newline="\n")
            else:
                print(rendered, end="")
            return 0 if report["passed"] else 1
    except CorpusError as exc:
        print(f"nox identity eval: {exc}", file=sys.stderr)
        return 2
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
