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
    (bundle / "identity" / "identity-revision.json").write_text(
        json.dumps({"identity_sha256": "b" * 64}),
        encoding="utf-8",
    )
    (bundle / "runtime" / "backend-provenance.json").write_text(
        json.dumps(
            {
                "identity": {
                    "identity_revision": "b" * 64,
                    "prefix_matches": True,
                    "status": "pass",
                },
                "runtimes": [
                    {
                        "executable_path": "C:\\Nox\\hermes-agent\\venv\\Scripts\\python.exe",
                        "expected_root": "C:\\Nox\\hermes-agent",
                        "source_override": False,
                        "status": "pass",
                    }
                ],
            }
        ),
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


def test_verify_rejects_source_override_as_release_proof(tmp_path: Path) -> None:
    bundle = _complete_bundle(tmp_path)
    report_path = bundle / "runtime" / "backend-provenance.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["runtimes"][0]["source_override"] = True
    report_path.write_text(json.dumps(report), encoding="utf-8")
    finalize_bundle(bundle, "implemented-but-unproven")

    with pytest.raises(EvidenceError, match="unaccepted runtime path"):
        verify_bundle(bundle)


def test_verify_rejects_live_identity_revision_mismatch(tmp_path: Path) -> None:
    bundle = _complete_bundle(tmp_path)
    report_path = bundle / "runtime" / "backend-provenance.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["identity"]["identity_revision"] = "c" * 64
    report_path.write_text(json.dumps(report), encoding="utf-8")
    finalize_bundle(bundle, "implemented-but-unproven")

    with pytest.raises(EvidenceError, match="differs from the accepted"):
        verify_bundle(bundle)
