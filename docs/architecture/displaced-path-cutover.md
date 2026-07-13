# Displaced path cutover

## Status

Task 6 preflight is complete. The production graph already uses one Desktop (`apps/desktop`) and one Hermes model/tool loop. The files below are unreachable remnants of the completed first-causal-loop implementation. Destructive relocation or deletion has not started because the accepted plan requires a clean checkpoint first.

## Checkpoint gate

The migration branch is `migration/hermes-foundation` at parent `19eafbd4a14686fdb0f65e480ec09f43f03ebc65`. Tasks 0–5 currently comprise 153 tracked changes and 18 migration-owned untracked entries. `.claude/`, packaged QA output, screenshots and generated Python build output are outside the checkpoint scope. `NOX-CONVERGENCE.md`, `NOX-RETHINK.md` and `REFERENCE ONLY/**` have no diff.

Task 6 deletion starts only after these accepted Tasks 0–5 changes become one local checkpoint commit. This keeps the displaced-path deletion independently reviewable and makes rollback exact.

## Production authority

- Root npm workspaces contain only `apps/bootstrap-installer`, `apps/desktop`, `apps/shared`, `ui-tui`, `ui-tui/packages/*` and `web`.
- Desktop launches `hermes_cli.main serve`; no production entrypoint launches the Node Nox runtime.
- Python production reaches only `nox.identity` and `nox.causal_bridge`.
- `tests/nox/test_production_graph.py` traverses the Electron main, preload and renderer graph and rejects any old runtime, second cortex, testkit or closed-path reference.

## Displaced source set

| Root | Files | Bytes | Disposition |
| --- | ---: | ---: | --- |
| `apps/audit` | 8 | 15,738 | delete after checkpoint; final audit is Python/SQLite evidence owned by the Hermes migration lane |
| `apps/runtime` | 8 | 13,078 | delete after checkpoint; this is the displaced second production runtime |
| `packages/cortex-pi` | 8 | 26,285 | delete after checkpoint; Hermes owns the only production cortex/model loop |
| `packages/interface-rpc` | 8 | 32,617 | delete after checkpoint; Desktop uses the Hermes gateway transport |
| `packages/protocol` | 22 | 58,701 | delete after checkpoint; its protocol is specific to the displaced runtime |
| `packages/runtime` | 22 | 81,190 | delete after checkpoint; superseded by Hermes runtime plus the observational Nox bridge |
| `packages/store-sqlite` | 11 | 65,039 | delete after checkpoint; Hermes `state.db` and the Python Nox Journal own the accepted truths |
| `packages/testkit` | 7 | 19,014 | delete after checkpoint; tests exercise only the displaced runtime |

Total: 94 files and 311,662 bytes. The full implementation and its verified evidence remain recoverable from the pre-migration rollback commit and the retained `docs/goals/nox-first-causal-loop/` documentation. Keeping a second live package tree in the current product would make production ownership ambiguous without adding executable coverage, because these packages are no longer installed by the authoritative lockfile.

## Displaced support files

Delete the TypeScript-only first-loop support files after the checkpoint:

- `scripts/build-evidence.mjs`
- `scripts/check-kill-criteria.mjs`
- `scripts/evidence-secret-scan.mjs`
- `scripts/verify-evidence.mjs`
- `tests/e2e/desktop-first-loop.test.ts`
- `tests/e2e/desktop-projection.test.ts`
- `tests/integration/cancellation-fence.test.ts`
- `tests/integration/evidence-secret-scan.test.ts`
- `tests/integration/first-causal-loop.test.ts`
- `tests/integration/kill-criteria-scope.test.ts`
- `tests/integration/production-continuation.test.ts`
- `tests/integration/restart-recovery.test.ts`
- `tests/live/real-pi-first-loop.ts`

The Python files sharing `tests/e2e`, `tests/integration` and `tests/live` are Hermes tests and remain.

Root `tsconfig.json` and `vitest.workspace.ts` still enumerate the displaced packages. Task 6 will replace them with the minimal current Desktop configuration or remove them if no authoritative command consumes them. `eslint.config.js` remains because Desktop lint resolves it from the repository root.

## Historical donor manifest

`docs/upstream/hermes-desktop-slice.json` describes the superseded small donor slice used by the first causal-loop Desktop. Task 6 will keep the file for provenance but add an explicit historical/superseded marker. `docs/upstream/hermes-foundation.json` is the current full-foundation provenance authority.

## Cutover proof

After the clean checkpoint, Task 6 must:

1. Remove the displaced source and support set above without changing the foundation package lock.
2. Update root TypeScript/test configuration and historical provenance references.
3. Extend `tests/nox/test_production_graph.py` to require every displaced root and support entrypoint to be absent.
4. Add negative fixtures showing that restoring an old runtime spawn, package import or support entrypoint fails the graph gate.
5. Run the production graph, identity/causal tests, Desktop typecheck/lint/UI/platform suites, Python tests and package build.
6. Re-run repository search and record zero reachable custom composer, Node runtime, Nox JSON-RPC client or second cortex.

The stop condition is any evidence that one of these files still owns a required product behavior. No such dependency was found in preflight.
