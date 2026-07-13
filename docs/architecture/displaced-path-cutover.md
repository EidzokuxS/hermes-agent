# Displaced path cutover

## Status

Task 6 cutover is complete. The production graph uses one Desktop (`apps/desktop`) and one Hermes model/tool loop. The unreachable first-causal-loop implementation and its obsolete support configuration were deleted after the clean checkpoint.

## Checkpoint gate

Tasks 0–5 were committed as `8515ee78cc` (`feat: migrate Nox through Hermes product mode`) before deletion. `.claude/`, packaged QA output, screenshots and generated build output remained outside the checkpoint. The deleted implementation remains exactly recoverable from that checkpoint and the pre-migration rollback tag.

## Production authority

- Root npm workspaces contain only `apps/bootstrap-installer`, `apps/desktop`, `apps/shared`, `ui-tui`, `ui-tui/packages/*` and `web`.
- Desktop launches `hermes_cli.main serve`; no production entrypoint launches the Node Nox runtime.
- Python production reaches only `nox.identity` and `nox.causal_bridge`.
- `tests/nox/test_production_graph.py` traverses the Electron main, preload and renderer graph and rejects any old runtime, second cortex, testkit or closed-path reference.

## Displaced source set

| Root | Files | Bytes | Disposition |
| --- | ---: | ---: | --- |
| `apps/audit` | 8 | 15,738 | deleted; final audit is Python/SQLite evidence owned by the Hermes migration lane |
| `apps/runtime` | 8 | 13,078 | deleted; this was the displaced second production runtime |
| `packages/cortex-pi` | 8 | 26,285 | deleted; Hermes owns the only production cortex/model loop |
| `packages/interface-rpc` | 8 | 32,617 | deleted; Desktop uses the Hermes gateway transport |
| `packages/protocol` | 22 | 58,701 | deleted; its protocol was specific to the displaced runtime |
| `packages/runtime` | 22 | 81,190 | deleted; superseded by Hermes runtime plus the observational Nox bridge |
| `packages/store-sqlite` | 11 | 65,039 | deleted; Hermes `state.db` and the Python Nox Journal own the accepted truths |
| `packages/testkit` | 7 | 19,014 | deleted; its tests exercised only the displaced runtime |

Total: 94 files and 311,662 bytes. The full implementation and its verified evidence remain recoverable from the pre-migration rollback commit and the retained `docs/goals/nox-first-causal-loop/` documentation. Keeping a second live package tree in the current product would make production ownership ambiguous without adding executable coverage, because these packages are no longer installed by the authoritative lockfile.

## Displaced support files

The following TypeScript-only first-loop support files were deleted after the checkpoint:

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

The unconsumed root `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts` and `vitest.workspace.ts` were also deleted. Desktop owns its TypeScript and direct Vitest commands; `eslint.config.js` remains because Desktop lint resolves it from the repository root.

## Historical donor manifest

`docs/upstream/hermes-desktop-slice.json` now carries an explicit `historical-superseded` marker and points to `docs/upstream/hermes-foundation.json`, the current full-foundation provenance authority.

## Cutover proof

The foundation lockfile remained unchanged. `tests/nox/test_production_graph.py` now rejects both reachable references and physical restoration of every displaced root/support file; negative fixtures cover the old runtime, runtime package, evidence script and root Vitest workspace. Production graph plus Nox identity/causal tests passed (`85`), focused launcher/uninstaller and graph regressions passed (`92`, one host skip), Desktop platform tests passed (`330`, three host skips), Desktop UI passed (`1,197`), Bootstrap Rust tests passed (`27`), and both Desktop and Bootstrap typecheck/build gates passed. Desktop lint reports zero errors.

The cutover also corrected a product-path mismatch discovered during validation: the packaged product was already `Nox.exe`/`Nox.app`, while install, update, relaunch and uninstall code still searched for Hermes executable paths. Those paths, shortcuts, installer metadata and visible setup copy now use Nox. The isolated Windows package is `apps/desktop/release-cutover/win-unpacked/Nox.exe`; its SHA-256 is `ccc85da7ee2bf88a1cdf035853248f5332ebaf8bad52196c1daa6800442f20c0`.
