from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.nox_evidence import EvidenceError, REQUIRED_FILES, finalize_bundle, verify_bundle


def _complete_bundle(root: Path) -> Path:
    bundle = root / "bundle"
    for relative in REQUIRED_FILES:
        path = bundle / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"sqlite" if path.suffix == ".sqlite" else b"evidence\n")
    (bundle / "versions.json").write_text(
        json.dumps({"source": {"commit": "a" * 40, "tracked_tree_clean": True}}),
        encoding="utf-8",
    )
    return bundle


def test_finalize_and_verify_round_trip(tmp_path: Path) -> None:
    bundle = _complete_bundle(tmp_path)
    finalize_bundle(bundle, "release")

    result = verify_bundle(bundle)

    assert result == {
        "decision": "release",
        "file_count": len(REQUIRED_FILES),
        "source_commit": "a" * 40,
        "status": "pass",
    }


def test_verify_rejects_tampering(tmp_path: Path) -> None:
    bundle = _complete_bundle(tmp_path)
    finalize_bundle(bundle, "implemented-but-unproven")
    (bundle / "commands.log").write_text("tampered\n", encoding="utf-8")

    with pytest.raises(EvidenceError, match="integrity failure"):
        verify_bundle(bundle)


def test_finalize_rejects_incomplete_bundle(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle"
    bundle.mkdir()

    with pytest.raises(EvidenceError, match="missing required artifacts"):
        finalize_bundle(bundle, "rollback")
