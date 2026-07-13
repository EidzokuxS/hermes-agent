from __future__ import annotations

import ast
import hashlib
import json
import re
import tomllib
from collections import deque
from pathlib import Path
from typing import Any

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
BASELINE_PATH = (
    REPO_ROOT
    / "artifacts"
    / "evidence"
    / "hermes-foundation"
    / "task1"
    / "production-graph-baseline.json"
)

DESKTOP_ENTRYPOINTS = (
    "apps/desktop/electron/main.ts",
    "apps/desktop/electron/preload.ts",
    "apps/desktop/src/main.tsx",
)
EXPECTED_WORKSPACES = (
    "apps/bootstrap-installer",
    "apps/desktop",
    "apps/shared",
    "ui-tui",
    "ui-tui/packages/*",
    "web",
)
DISPLACED_ROOTS = (
    "apps/audit",
    "apps/runtime",
    "packages/cortex-pi",
    "packages/interface-rpc",
    "packages/protocol",
    "packages/runtime",
    "packages/store-sqlite",
    "packages/testkit",
)
DISPLACED_SUPPORT_FILES = (
    "scripts/build-evidence.mjs",
    "scripts/check-kill-criteria.mjs",
    "scripts/evidence-secret-scan.mjs",
    "scripts/verify-evidence.mjs",
    "tests/e2e/desktop-first-loop.test.ts",
    "tests/e2e/desktop-projection.test.ts",
    "tests/integration/cancellation-fence.test.ts",
    "tests/integration/evidence-secret-scan.test.ts",
    "tests/integration/first-causal-loop.test.ts",
    "tests/integration/kill-criteria-scope.test.ts",
    "tests/integration/production-continuation.test.ts",
    "tests/integration/restart-recovery.test.ts",
    "tests/live/real-pi-first-loop.ts",
    "tsconfig.base.json",
    "tsconfig.json",
    "vitest.config.ts",
    "vitest.workspace.ts",
)
FORBIDDEN_PRODUCTION_MARKERS = (
    "@nox/cortex-pi",
    "@nox/interface-rpc",
    "@nox/protocol",
    "@nox/runtime",
    "@nox/store-sqlite",
    "@nox/testkit",
    "apps/audit",
    "apps/runtime",
    "packages/cortex-pi",
    "packages/interface-rpc",
    "packages/protocol",
    "packages/runtime",
    "packages/store-sqlite",
    "packages/testkit",
    "NOX-RETHINK.md",
    "REFERENCE ONLY",
)
CODE_SUFFIXES = (".d.ts", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
PYTHON_PRODUCTION_ROOTS = ("agent", "gateway", "hermes_cli", "tui_gateway")
PYTHON_PRODUCTION_FILES = ("hermes_state.py", "run_agent.py")
ALLOWED_PRODUCTION_NOX_MODULES = frozenset({"nox.causal_bridge", "nox.identity"})
IMPORT_PATTERNS = (
    re.compile(r"\bfrom\s+['\"]([^'\"]+)['\"]"),
    re.compile(r"\b(?:import|require)\s*\(\s*['\"]([^'\"]+)['\"]\s*\)"),
    re.compile(r"^\s*import\s+['\"]([^'\"]+)['\"]", re.MULTILINE),
)


def _relative(path: Path) -> str:
    return path.resolve().relative_to(REPO_ROOT).as_posix()


def _restored_displaced_paths(root: Path = REPO_ROOT) -> list[str]:
    return [
        path
        for path in (*DISPLACED_ROOTS, *DISPLACED_SUPPORT_FILES)
        if (root / path).exists()
    ]


def _extract_import_specifiers(source: str) -> tuple[str, ...]:
    return tuple(
        sorted(
            {
                match.group(1)
                for pattern in IMPORT_PATTERNS
                for match in pattern.finditer(source)
            }
        )
    )


def _resolve_code_import(importer: Path, specifier: str) -> Path | None:
    if specifier.startswith("@/"):
        candidate = REPO_ROOT / "apps" / "desktop" / "src" / specifier[2:]
    elif specifier == "@hermes/shared":
        candidate = REPO_ROOT / "apps" / "shared" / "src" / "index.ts"
    elif specifier.startswith("@hermes/shared/"):
        candidate = REPO_ROOT / "apps" / "shared" / "src" / specifier.removeprefix("@hermes/shared/")
    elif specifier.startswith("."):
        candidate = importer.parent / specifier
    else:
        return None

    if candidate.suffix:
        if candidate.suffix in CODE_SUFFIXES and candidate.is_file():
            return candidate.resolve()
        return None

    for suffix in CODE_SUFFIXES:
        resolved = candidate.with_suffix(suffix)
        if resolved.is_file():
            return resolved.resolve()

    for suffix in CODE_SUFFIXES:
        resolved = candidate / f"index{suffix}"
        if resolved.is_file():
            return resolved.resolve()

    raise AssertionError(f"Unresolved production code import: {_relative(importer)} -> {specifier}")


def _production_violations(source: str) -> list[str]:
    normalized = source.replace("\\", "/")
    return [marker for marker in FORBIDDEN_PRODUCTION_MARKERS if marker in normalized]


def _extract_python_nox_modules(source: str, *, filename: str = "<fixture>") -> set[str]:
    tree = ast.parse(source, filename=filename)
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(
                alias.name
                for alias in node.names
                if alias.name == "nox" or alias.name.startswith("nox.")
            )
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module == "nox" or node.module.startswith("nox."):
                modules.add(node.module)
    return modules


def _python_nox_imports() -> dict[str, list[str]]:
    """Return Nox imports reachable from the Hermes Python product surface."""
    sources = [REPO_ROOT / path for path in PYTHON_PRODUCTION_FILES]
    for root in PYTHON_PRODUCTION_ROOTS:
        sources.extend((REPO_ROOT / root).rglob("*.py"))

    imports: dict[str, list[str]] = {}
    for path in sorted(sources):
        modules = _extract_python_nox_modules(
            path.read_text(encoding="utf-8"), filename=str(path)
        )
        if modules:
            imports[_relative(path)] = sorted(modules)

    imported_modules = {module for modules in imports.values() for module in modules}
    assert imported_modules == ALLOWED_PRODUCTION_NOX_MODULES, (
        "Only the accepted identity and observational causal seams may be reachable; "
        f"found Nox imports: {imports}"
    )
    return imports


def _walk_desktop_graph() -> tuple[list[str], list[str]]:
    queue = deque((REPO_ROOT / entrypoint).resolve() for entrypoint in DESKTOP_ENTRYPOINTS)
    seen: set[Path] = set()
    edges: set[tuple[str, str]] = set()

    while queue:
        source_path = queue.popleft()
        if source_path in seen:
            continue

        seen.add(source_path)
        source = source_path.read_text(encoding="utf-8")
        violations = _production_violations(source)
        assert not violations, f"Forbidden production reference in {_relative(source_path)}: {violations}"

        for specifier in _extract_import_specifiers(source):
            target = _resolve_code_import(source_path, specifier)
            if target is None:
                continue
            edges.add((_relative(source_path), _relative(target)))
            if target not in seen:
                queue.append(target)

    return (
        sorted(_relative(path) for path in seen),
        [f"{source} -> {target}" for source, target in sorted(edges)],
    )


def _assert_backend_contract() -> dict[str, Any]:
    main_path = REPO_ROOT / "apps" / "desktop" / "electron" / "main.ts"
    backend_command_path = REPO_ROOT / "apps" / "desktop" / "electron" / "backend-command.ts"
    cli_path = REPO_ROOT / "hermes_cli" / "main.py"
    serve_path = REPO_ROOT / "hermes_cli" / "subcommands" / "dashboard.py"

    main_source = main_path.read_text(encoding="utf-8")
    backend_command_source = backend_command_path.read_text(encoding="utf-8")
    serve_source = serve_path.read_text(encoding="utf-8")

    required_main_fragments = (
        "const backendArgs = ['serve', '--host', '127.0.0.1', '--port', '0']",
        "const backend = await ensureRuntime(resolveHermesBackend(backendArgs))",
        "hermesProcess = spawn(\n      backend.command,\n      backend.args,",
        "args: ['-m', 'hermes_cli.main', ...backendArgs]",
    )
    for fragment in required_main_fragments:
        assert fragment in main_source, f"Desktop backend contract missing: {fragment!r}"

    assert "dashboardFallbackArgs" in backend_command_source
    assert "'dashboard', '--no-open'" in backend_command_source
    assert 'subparsers.add_parser(\n        "serve"' in serve_source
    assert "serve_parser.set_defaults(func=cmd_dashboard, no_open=True, headless_backend=True)" in serve_source

    project = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    scripts = project["project"]["scripts"]
    assert scripts["hermes"] == "hermes_cli.main:main"

    contract = {
        "desktop_command": "hermes serve --host 127.0.0.1 --port 0",
        "python_module_fallback": "python -m hermes_cli.main serve --host 127.0.0.1 --port 0",
        "legacy_compatibility": "hermes dashboard --no-open --host 127.0.0.1 --port 0",
        "server_registration": "hermes_cli.subcommands.dashboard:cmd_dashboard",
        "source_files": sorted(
            _relative(path)
            for path in (main_path, backend_command_path, cli_path, serve_path)
        ),
    }
    contract["contract_sha256"] = hashlib.sha256(
        json.dumps(contract, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return contract


def _assert_workspace_contract() -> dict[str, Any]:
    package_path = REPO_ROOT / "package.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))
    workspaces = tuple(package["workspaces"])

    assert workspaces == EXPECTED_WORKSPACES
    for displaced_root in DISPLACED_ROOTS:
        assert displaced_root not in workspaces
    assert "apps/*" not in workspaces
    assert "packages/*" not in workspaces

    restored_paths = _restored_displaced_paths()
    assert not restored_paths, f"Displaced paths were restored: {restored_paths}"

    return {
        "manifest": _relative(package_path),
        "production_workspaces": list(workspaces),
        "removed_roots": list(DISPLACED_ROOTS),
        "removed_support_files": list(DISPLACED_SUPPORT_FILES),
    }


def build_production_graph_baseline() -> dict[str, Any]:
    nodes, edges = _walk_desktop_graph()
    graph_sha256 = hashlib.sha256(
        json.dumps({"nodes": nodes, "edges": edges}, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return {
        "schema_version": 1,
        "authority": {
            "operational": "Hermes state.db owns sessions, messages, tool calls, tool results, and model-loop state.",
            "causal": "Nox Journal may record observed provenance and constitutional State; it does not author Hermes outcomes.",
            "projections": "Desktop stores, transcripts, snapshots, and evidence are rebuildable views.",
        },
        "production_entrypoints": {
            "electron_main": "apps/desktop/electron/main.ts",
            "electron_preload": "apps/desktop/electron/preload.ts",
            "renderer": "apps/desktop/src/main.tsx",
            "python_cli": "hermes_cli.main:main",
        },
        "desktop_import_graph": {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "graph_sha256": graph_sha256,
            "nodes": nodes,
            "edges": edges,
        },
        "backend_process": _assert_backend_contract(),
        "workspace_fence": _assert_workspace_contract(),
        "python_nox_imports": _python_nox_imports(),
        "invariants": {
            "desktop_count": 1,
            "model_tool_loop_count": 1,
            "old_node_runtime_spawned": False,
            "shadow_cortex_reachable": False,
            "testkit_reachable": False,
            "closed_paths_referenced": False,
            "causal_bridge_reachable": True,
        },
    }


def test_checked_in_production_graph_matches_sources() -> None:
    assert BASELINE_PATH.is_file(), f"Missing acceptance evidence: {_relative(BASELINE_PATH)}"
    expected = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    assert build_production_graph_baseline() == expected


@pytest.mark.parametrize(
    ("source", "expected_marker"),
    (
        ("spawn('node', ['apps/runtime/dist/main.js'])", "apps/runtime"),
        ("import { cortex } from '@nox/cortex-pi'", "@nox/cortex-pi"),
        ("import { fakeClock } from '@nox/testkit'", "@nox/testkit"),
        ("import '../../packages/runtime/src/index'", "packages/runtime"),
        ("import secrets from '../../REFERENCE ONLY/notes'", "REFERENCE ONLY"),
    ),
)
def test_forbidden_route_fixtures_fail(source: str, expected_marker: str) -> None:
    assert expected_marker in _production_violations(source)


def test_canonical_hermes_route_fixture_passes() -> None:
    source = "spawn(backend.command, ['-m', 'hermes_cli.main', 'serve'])"
    assert _production_violations(source) == []


@pytest.mark.parametrize(
    ("restored_path", "detected_path"),
    (
        ("apps/runtime/src/main.ts", "apps/runtime"),
        ("packages/runtime/src/index.ts", "packages/runtime"),
        ("scripts/build-evidence.mjs", "scripts/build-evidence.mjs"),
        ("vitest.workspace.ts", "vitest.workspace.ts"),
    ),
)
def test_restored_displaced_path_fixture_fails(
    restored_path: str, detected_path: str, tmp_path: Path
) -> None:
    fake_root = tmp_path / "repo"
    path = fake_root / restored_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("restored", encoding="utf-8")
    assert _restored_displaced_paths(fake_root) == [detected_path]


@pytest.mark.parametrize(
    "source",
    (
        "import nox.runtime",
        "from nox.causal_bridge.bridge import CausalBridge",
        "from nox.causal_bridge.sqlite_sink import SqliteCausalSink",
    ),
)
def test_unapproved_python_nox_route_fixture_fails(source: str) -> None:
    assert not _extract_python_nox_modules(source).issubset(
        ALLOWED_PRODUCTION_NOX_MODULES
    )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--write-baseline", action="store_true")
    args = parser.parse_args()
    if not args.write_baseline:
        parser.error("pass --write-baseline to refresh the checked-in acceptance evidence")
    BASELINE_PATH.parent.mkdir(parents=True, exist_ok=True)
    BASELINE_PATH.write_text(
        json.dumps(build_production_graph_baseline(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(_relative(BASELINE_PATH))
