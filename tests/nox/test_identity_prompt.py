"""Task 3 contracts for Nox identity loading and Hermes prompt assembly."""

from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agent.prompt_builder import HERMES_AGENT_HELP_GUIDANCE
from agent.system_prompt import build_system_prompt_parts
from hermes_cli.default_soul import DEFAULT_SOUL_MD
from hermes_state import SessionDB
from nox.identity import (
    ACCEPTED_NOX_IDENTITY_SHA256,
    NoxIdentityError,
    NoxIdentitySnapshot,
    bind_nox_identity,
    identity_persistence_fields,
    load_nox_identity,
    profile_soul_block,
    restore_nox_identity,
)


def _make_agent(**overrides):
    values = {
        "load_soul_identity": False,
        "skip_context_files": False,
        "valid_tool_names": [],
        "_task_completion_guidance": False,
        "_tool_use_enforcement": False,
        "_environment_probe": False,
        "_kanban_worker_guidance": "",
        "_memory_store": None,
        "_memory_manager": None,
        "_nox_identity_snapshot": None,
        "_preserve_system_prompt_snapshot": False,
        "model": "openai-codex/gpt-5.6-sol",
        "provider": "openai-codex",
        "platform": "cli",
        "pass_session_id": False,
        "session_id": "identity-test",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _build_parts(agent, *, soul: str = ""):
    with (
        patch("run_agent.load_soul_md", return_value=soul),
        patch("run_agent.build_nous_subscription_prompt", return_value=""),
        patch("run_agent.build_environment_hints", return_value=""),
        patch("run_agent.build_context_files_prompt", return_value=""),
        patch("agent.file_safety._resolve_active_profile_name", return_value="default"),
    ):
        return build_system_prompt_parts(agent)


def _snapshot(text: str, revision: str = "a" * 64) -> NoxIdentitySnapshot:
    return NoxIdentitySnapshot(
        revision=revision,
        prompt_sha256=sha256(text.encode("utf-8")).hexdigest(),
        prompt_text=text,
    )


def test_loads_the_accepted_canonical_document():
    identity = load_nox_identity()

    assert identity.revision == ACCEPTED_NOX_IDENTITY_SHA256
    assert identity.prompt_text.startswith("# Nox\n\nI'm Nox:")
    assert identity.prompt_chars == len(identity.prompt_text)


def test_windows_line_endings_preserve_the_accepted_revision(tmp_path):
    canonical = Path("identity/NOX.md").read_text(encoding="utf-8")
    windows_checkout = tmp_path / "NOX.md"
    windows_checkout.write_bytes(canonical.replace("\n", "\r\n").encode("utf-8"))

    with patch("nox.identity._candidate_paths", return_value=(windows_checkout,)):
        identity = load_nox_identity()

    assert identity.revision == ACCEPTED_NOX_IDENTITY_SHA256
    assert "\r" not in identity.prompt_text


def test_rejects_an_unaccepted_identity_revision(tmp_path):
    changed = tmp_path / "NOX.md"
    changed.write_text("# Nox\n\nChanged without acceptance.\n", encoding="utf-8")

    with (
        patch("nox.identity._candidate_paths", return_value=(changed,)),
        pytest.raises(NoxIdentityError, match="revision mismatch"),
    ):
        load_nox_identity()


def test_custom_soul_is_an_additive_profile_after_nox():
    agent = _make_agent()
    parts = _build_parts(agent, soul="Prefer terse status updates.")
    identity = agent._nox_identity_snapshot

    assert isinstance(identity, NoxIdentitySnapshot)
    assert parts["stable"].startswith(identity.prompt_text)
    profile_index = parts["stable"].index("## Current profile")
    hermes_index = parts["stable"].index(HERMES_AGENT_HELP_GUIDANCE)
    assert 0 < profile_index < hermes_index
    assert "same Nox" in parts["stable"]
    assert "Prefer terse status updates." in parts["stable"]


def test_seeded_generic_hermes_soul_does_not_compete_with_nox():
    parts = _build_parts(_make_agent(), soul=DEFAULT_SOUL_MD)

    assert "## Current profile" not in parts["stable"]
    assert "You are Hermes Agent, an intelligent AI assistant" not in parts["stable"]
    assert "You run on Hermes Agent" in parts["stable"]


def test_profile_helper_preserves_custom_content_only():
    assert profile_soul_block(None) == ""
    assert profile_soul_block(DEFAULT_SOUL_MD) == ""
    assert profile_soul_block("Likes exact evidence.").endswith("Likes exact evidence.")


def test_session_row_persists_and_restores_exact_identity_prefix(tmp_path):
    db = SessionDB(tmp_path / "state.db")
    original = _snapshot("# Nox\n\nSession-bound identity.", revision="b" * 64)
    prompt = f"{original.prompt_text}\n\nOperational guidance."
    fields = {
        "nox_identity_revision": original.revision,
        "nox_identity_chars": original.prompt_chars,
        "nox_identity_prompt_sha256": original.prompt_sha256,
    }
    db.create_session(
        "session-1",
        "cli",
        system_prompt=prompt,
        **fields,
    )

    restored_agent = _make_agent()
    row = db.get_session("session-1")
    assert row is not None
    restored = restore_nox_identity(
        restored_agent,
        row,
        prompt,
    )

    assert restored == original
    assert identity_persistence_fields(restored_agent) == fields
    db.close()


def test_restored_revision_survives_a_rebuild_after_current_identity_changes():
    original = _snapshot("# Nox\n\nOriginal session identity.", revision="c" * 64)
    newer = _snapshot("# Nox\n\nNew identity for new sessions.", revision="d" * 64)
    prompt = f"{original.prompt_text}\n\nOperational guidance."
    row = {
        "nox_identity_revision": original.revision,
        "nox_identity_chars": original.prompt_chars,
        "nox_identity_prompt_sha256": original.prompt_sha256,
    }
    agent = _make_agent()
    restore_nox_identity(agent, row, prompt)

    with patch("nox.identity.load_nox_identity", return_value=newer):
        rebuilt = _build_parts(agent)

    assert rebuilt["stable"].startswith(original.prompt_text)
    assert newer.prompt_text not in rebuilt["stable"]


def test_legacy_session_without_nox_metadata_is_preserved_verbatim():
    agent = _make_agent()
    row = {
        "nox_identity_revision": None,
        "nox_identity_chars": None,
        "nox_identity_prompt_sha256": None,
    }

    restored = restore_nox_identity(agent, row, "You are Hermes Agent.")

    assert restored is None
    assert agent._preserve_system_prompt_snapshot is True


def test_tampered_stored_identity_prefix_fails_closed():
    original = _snapshot("# Nox\n\nStored identity.", revision="e" * 64)
    row = {
        "nox_identity_revision": original.revision,
        "nox_identity_chars": original.prompt_chars,
        "nox_identity_prompt_sha256": original.prompt_sha256,
    }

    with pytest.raises(NoxIdentityError, match="does not match"):
        restore_nox_identity(
            _make_agent(),
            row,
            "# Nox\n\nTampered identity.\n\nOperational guidance.",
        )


def test_bound_identity_is_byte_stable_across_prompt_builds():
    identity = _snapshot("# Nox\n\nPinned identity.", revision="f" * 64)
    agent = _make_agent()
    bind_nox_identity(agent, identity)

    first = _build_parts(agent)["stable"]
    second = _build_parts(agent)["stable"]

    assert first.encode("utf-8") == second.encode("utf-8")
