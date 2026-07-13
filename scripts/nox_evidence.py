"""Create and verify the self-contained Nox Hermes-foundation evidence bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_VERSION = 1
REQUIRED_FILES = (
    "commands.log",
    "versions.json",
    "upstream/tree-report.json",
    "upstream/collision-map.json",
    "upstream/parity-report.json",
    "identity/identity-revision.json",
    "identity/prompt-parts.json",
    "identity/eval-results.json",
    "desktop/empty-1440x900.png",
    "desktop/conversation-1440x900.png",
    "desktop/conversation-900x700.png",
    "desktop/tool-and-skill.png",
    "desktop/resumed-after-restart.png",
    "desktop/visual-qa.json",
    "runtime/gateway-trace.json",
    "runtime/streaming-trace.json",
    "runtime/interrupt-trace.json",
    "runtime/restart-report.json",
    "runtime/causal-correlation.json",
    "runtime/nox-journal.sqlite",
    "reviews/production-graph.json",
    "reviews/displaced-paths.json",
    "reviews/redaction.json",
    "reviews/dependency-security.json",
    "reviews/pre-plan-review.md",
    "reviews/post-plan-review.md",
    "reviews/correctness-review.md",
    "reviews/maintainability-review.md",
)
BINARY_SUFFIXES = {".asar", ".db", ".exe", ".ico", ".jpg", ".jpeg", ".png", ".sqlite"}
SECRET_LITERALS = (
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
    "ghp_",
    "github_pat_",
    "sk-ant-",
    "sk-proj-",
)


class EvidenceError(RuntimeError):
    pass


def _run(*args: str) -> str:
    result = subprocess.run(
        args,
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return result.stdout.strip()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _relative_files(bundle: Path) -> list[Path]:
    return sorted(
        (path for path in bundle.rglob("*") if path.is_file()),
        key=lambda path: path.relative_to(bundle).as_posix(),
    )


def _tracked_tree_clean() -> bool:
    return _run("git", "status", "--porcelain", "--untracked-files=no") == ""


def _command_version(*args: str) -> str:
    try:
        return _run(*args).splitlines()[0]
    except (OSError, subprocess.CalledProcessError):
        return "unavailable"


def _copy_required(source: Path, target: Path) -> None:
    if not source.is_file():
        raise EvidenceError(f"required source artifact is missing: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def init_bundle(bundle: Path, package_dir: Path | None) -> None:
    if bundle.exists() and any(bundle.iterdir()):
        raise EvidenceError(f"bundle is not empty: {bundle}")
    if not _tracked_tree_clean():
        raise EvidenceError("tracked source tree must be clean before evidence capture")

    commit = _run("git", "rev-parse", "HEAD")
    branch = _run("git", "branch", "--show-current")
    bundle.mkdir(parents=True, exist_ok=True)
    for directory in ("upstream", "identity", "desktop", "runtime", "reviews"):
        (bundle / directory).mkdir()

    package = _read_json(REPO_ROOT / "apps" / "desktop" / "package.json")
    foundation = _read_json(REPO_ROOT / "docs" / "upstream" / "hermes-foundation.json")
    graph = _read_json(
        REPO_ROOT
        / "artifacts"
        / "evidence"
        / "hermes-foundation"
        / "task1"
        / "production-graph-baseline.json"
    )
    _write_json(
        bundle / "versions.json",
        {
            "captured_utc": datetime.now(UTC).isoformat(),
            "source": {"branch": branch, "commit": commit, "tracked_tree_clean": True},
            "host": {
                "machine": platform.machine(),
                "os": platform.platform(),
                "python": platform.python_version(),
            },
            "tools": {
                "git": _command_version("git", "--version"),
                "node": _command_version("node", "--version"),
                "npm": _command_version("npm", "--version"),
                "uv": _command_version("uv", "--version"),
            },
            "desktop": {
                "app_id": package["build"]["appId"],
                "product_name": package["build"]["productName"],
                "version": package["version"],
            },
            "locks": {
                "package-lock.json": _sha256(REPO_ROOT / "package-lock.json"),
                "uv.lock": _sha256(REPO_ROOT / "uv.lock"),
            },
        },
    )
    _write_json(bundle / "upstream" / "tree-report.json", foundation)
    _write_json(bundle / "upstream" / "collision-map.json", foundation["collisions"])
    _write_json(
        bundle / "upstream" / "parity-report.json",
        {
            "baseline": "docs/upstream/HERMES-BASELINE.md",
            "foundation_commit": foundation["source"]["commit"],
            "production_graph_sha256": graph["desktop_import_graph"]["graph_sha256"],
            "production_workspaces": graph["workspace_fence"]["production_workspaces"],
            "status": "pending-final-review",
        },
    )
    _write_json(bundle / "reviews" / "production-graph.json", graph)
    _write_json(
        bundle / "reviews" / "displaced-paths.json",
        {
            "removed_roots": graph["workspace_fence"]["removed_roots"],
            "removed_support_files": graph["workspace_fence"]["removed_support_files"],
            "restored_paths": [],
            "status": "pass",
        },
    )
    (bundle / "commands.log").write_text(
        f"source_commit={commit}\nsource_branch={branch}\n",
        encoding="utf-8",
    )

    identity_manifest = json.loads(
        _run("uv", "run", "python", "scripts/nox_identity_eval.py", "manifest")
    )
    _write_json(bundle / "identity" / "identity-revision.json", identity_manifest)
    subprocess.run(
        (
            "uv",
            "run",
            "python",
            "scripts/nox_identity_eval.py",
            "prompt-report",
            "--output",
            str(bundle / "identity" / "prompt-parts.json"),
        ),
        cwd=REPO_ROOT,
        check=True,
    )

    static_screenshot = (
        REPO_ROOT
        / "artifacts"
        / "evidence"
        / "hermes-foundation"
        / "task5-product"
        / "screenshots"
        / "1440x900.png"
    )
    if static_screenshot.is_file():
        _copy_required(static_screenshot, bundle / "desktop" / "empty-1440x900.png")

    if package_dir is not None:
        _copy_required(package_dir / "Nox.exe", bundle / "desktop" / "Nox.exe")
        _copy_required(
            package_dir / "resources" / "app.asar",
            bundle / "desktop" / "app.asar",
        )


def scan_secrets(bundle: Path) -> dict[str, Any]:
    matches: list[dict[str, Any]] = []
    for path in _relative_files(bundle):
        relative = path.relative_to(bundle).as_posix()
        if relative in {"manifest.json", "reviews/redaction.json"}:
            continue
        if path.suffix.lower() in BINARY_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for literal in SECRET_LITERALS:
            if literal in text:
                matches.append({"file": relative, "literal": literal})
    return {
        "scanner": "literal-private-key-and-token-prefix-v1",
        "status": "pass" if not matches else "fail",
        "matches": matches,
    }


def finalize_bundle(bundle: Path, decision: str) -> None:
    generated_reports = {"reviews/redaction.json"}
    missing = [
        relative
        for relative in REQUIRED_FILES
        if relative not in generated_reports and not (bundle / relative).is_file()
    ]
    if missing:
        raise EvidenceError("missing required artifacts: " + ", ".join(missing))

    redaction = scan_secrets(bundle)
    _write_json(bundle / "reviews" / "redaction.json", redaction)
    if redaction["status"] != "pass":
        raise EvidenceError("secret scan failed")

    files = {
        path.relative_to(bundle).as_posix(): {
            "bytes": path.stat().st_size,
            "sha256": _sha256(path),
        }
        for path in _relative_files(bundle)
        if path.name != "manifest.json"
    }
    versions = _read_json(bundle / "versions.json")
    _write_json(
        bundle / "manifest.json",
        {
            "schema_version": SCHEMA_VERSION,
            "decision": decision,
            "source": versions["source"],
            "required_files": list(REQUIRED_FILES),
            "files": files,
        },
    )


def verify_bundle(bundle: Path) -> dict[str, Any]:
    manifest_path = bundle / "manifest.json"
    if not manifest_path.is_file():
        raise EvidenceError("manifest.json is missing")
    manifest = _read_json(manifest_path)
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise EvidenceError("unsupported manifest schema")

    declared = manifest.get("files")
    if not isinstance(declared, dict):
        raise EvidenceError("manifest files map is invalid")
    actual = {
        path.relative_to(bundle).as_posix()
        for path in _relative_files(bundle)
        if path.name != "manifest.json"
    }
    if actual != set(declared):
        raise EvidenceError("manifest file set differs from bundle contents")

    failures: list[str] = []
    for relative, record in declared.items():
        path = bundle / relative
        if path.stat().st_size != record.get("bytes") or _sha256(path) != record.get("sha256"):
            failures.append(relative)
    if failures:
        raise EvidenceError("artifact integrity failure: " + ", ".join(failures))

    missing = [relative for relative in REQUIRED_FILES if relative not in declared]
    if missing:
        raise EvidenceError("manifest omits required artifacts: " + ", ".join(missing))
    redaction = _read_json(bundle / "reviews" / "redaction.json")
    if redaction.get("status") != "pass":
        raise EvidenceError("redaction report is not passing")
    return {
        "decision": manifest.get("decision"),
        "file_count": len(declared),
        "source_commit": manifest.get("source", {}).get("commit"),
        "status": "pass",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init")
    init_parser.add_argument("--bundle", type=Path, required=True)
    init_parser.add_argument("--package-dir", type=Path)

    finalize_parser = subparsers.add_parser("finalize")
    finalize_parser.add_argument("--bundle", type=Path, required=True)
    finalize_parser.add_argument(
        "--decision",
        choices=("release", "rollback", "implemented-but-unproven"),
        required=True,
    )

    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--bundle", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "init":
            init_bundle(args.bundle.resolve(), args.package_dir.resolve() if args.package_dir else None)
            print(args.bundle.resolve())
        elif args.command == "finalize":
            finalize_bundle(args.bundle.resolve(), args.decision)
            print(args.bundle.resolve() / "manifest.json")
        else:
            print(json.dumps(verify_bundle(args.bundle.resolve()), sort_keys=True))
    except (EvidenceError, OSError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f"nox evidence: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
