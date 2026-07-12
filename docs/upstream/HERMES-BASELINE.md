# Hermes Foundation — Task 0 Baseline

**Status:** runtime gate passed; full Python denominator rerunning with a persistent log.

## Fixed inputs

- Accepted Nox migration base: `833dafc34bd7c37b99bf26110419c7edade1af76`
- Rollback tag: annotated object `9a909556a23364c8fb30b688d6d46d48c31beefa` → commit `833dafc34bd7c37b99bf26110419c7edade1af76`
- Accepted plan SHA-256: `F453963F6B002C9DA343E8A100FE429E66896AFC7BBAECC318955B4896B6D493`
- Donor: `NousResearch/hermes-agent@4281151ae859241351ba14d8c7682dc67ff4c126`
- Donor tree: `735e875e12c18ebf3d6b2dd26928d72d155455d0`, 6250 tracked files
- Desktop version: `0.17.0`
- Nox foundation fork: `EidzokuxS/hermes-agent`
- Packaged proof commit: `7c87c4781194fc03013d584ab95ee0f45313f4c8`
- Node/npm: `24.18.0` / `11.16.0`
- Python: `3.13.5`, within the locked `>=3.11,<3.14` range

The fork's `main` was fast-forwarded from `5038678647ee2e043779fdb4eabb11d73751a701` to upstream `7b5ba2054721dde998ed47fd4a0f031955278e99` with zero divergent commits. Migration work remains isolated on `migration/hermes-foundation`; it does not merge current upstream `main` into the accepted pinned donor tree.

## Import result

The complete pinned Hermes tree is materialized at repository root. The colliding custom `apps/desktop` was replaced rather than copied into a legacy directory. Nox canonical documents, goal evidence and causal-loop source remain recoverable; the old TypeScript runtime is outside every Hermes npm workspace and production entrypoint pending the Task 1 graph fence and Task 6 disposition.

Relative to the donor tree, the current foundation has 184 Nox-owned additions, 16 bounded adaptations and zero deleted upstream paths. The adaptations are root policy/manifests, Windows test-harness corrections, fork provenance/bootstrap seams and the long-path installer fix. There is no identity, prompt, causal bridge, branding or data-home change in Task 0.

The historical Pi package cannot join the Hermes lock because its exact registry pin is unavailable under the configured publication cutoff. It remains source-only rather than creating a second executable dependency graph; see `D-001` in the migration deviations log.

## Dependency baseline

| Command | Result |
| --- | --- |
| `npm ci` under Node `24.18.0` | PASS — 1301 packages installed, 1308 audited, 0 vulnerabilities |
| `uv sync --locked --no-config` | PASS — 233 packages resolved, base runtime installed without changing `uv.lock` |
| `uv sync --locked --no-config --extra all --extra dev` | PASS — the full offline test denominator, including ACP, installed from the same lock |
| Node archive integrity | PASS — official `node-v24.18.0-win-x64.zip` SHA-256 `0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821` |

The host has a user-level uv `exclude-newer` policy newer than the lock. `--no-config` is intentional: it proves the repository lock rather than allowing unrelated host policy to alter resolution.

## Desktop baseline

| Command | Result |
| --- | --- |
| `npm run test:desktop:platforms --workspace hermes` | PASS — 321 tests: 318 passed, 3 POSIX-only relaunch tests skipped on Windows |
| `npm run typecheck --workspace hermes` | PASS |
| `npm run build --workspace hermes` | PASS — 4300 renderer modules plus Electron main/preload and staged `node-pty` |
| `npm run pack --workspace hermes` | PASS — `apps/desktop/release/win-unpacked/Hermes.exe` |
| `vitest run src --environment jsdom --reporter=json` | BASELINE FAIL — 1197 tests: 1174 passed, 23 failed; 440/463 suites passed; 137/148 files passed |

The 23 UI failures are the pinned upstream Windows/Node baseline, not a green claim. They are concentrated in 11 files:

| File | Failed tests |
| --- | ---: |
| `src/store/panes.test.ts` | 1 |
| `src/lib/model-options.test.ts` | 3 |
| `src/app/messaging/index.test.tsx` | 1 |
| `src/app/skills/index.test.tsx` | 1 |
| `src/app/settings/model-settings.test.tsx` | 7 |
| `src/components/pane-shell/pane-shell.test.tsx` | 1 |
| `src/app/chat/composer/attachments.test.tsx` | 1 |
| `src/app/session/hooks/use-preview-routing.test.tsx` | 1 |
| `src/components/assistant-ui/thread/block-direction.test.tsx` | 4 |
| `src/components/assistant-ui/thread/streaming.test.tsx` | 1 |
| `src/components/assistant-ui/thread/user-message-edit.test.tsx` | 2 |

The JSON result is retained in the ignored local test lane at `.tools/desktop-ui-results.json`. Later parity checks must compare against this denominator and may not call these failures Nox regressions unless their behavior or count worsens.

The production build emits three non-fatal upstream warnings: one malformed generated CSS comment near `.btn-arc`, the large `@tabler/icons-react` barrel, and a renderer chunk above the configured warning threshold. Packaging still exits 0.

## Python baseline

Hermes' canonical `scripts/run_tests.sh` is POSIX-only and looks for `.venv/bin/python`; the locked Windows environment correctly provides `.venv/Scripts/python.exe`. Task 0 therefore invokes the same `scripts/run_tests_parallel.py` directly in a native Windows process with a cleared environment, the same UTC/locale/hash isolation, `PYTHONUTF8=1`, and no credential variables. Denominator: 1976 files / approximately 37,759 tests under `tests/`, eight workers.

The first complete execution reached the end, but its PTY was reclaimed before the final summary could be read. Intermediate counters are not accepted as a denominator. The identical hermetic command is therefore running again with output retained at `.tools/python-baseline-full.log`; only its final summary will be recorded here. Failed setup attempts caused by a missing ACP extra, WSL path translation and cp1251 progress output are harness diagnostics and are not counted as product results.

## Packaged Desktop proof

The first clean packaged boot exposed two real foundation seams and led to bounded fixes:

1. Nox build SHAs did not exist in the donor repository, so bootstrap and update provenance now point to the synchronized Nox fork while donor provenance stays immutable (`D-005`).
2. The complete Hermes tree exceeded Windows `MAX_PATH` under the managed app-data root. The installer now enables `core.longpaths=true` before every repository probe/clone, uses fork ZIPs and force-replaces archive payload only on the fresh checkout path (`D-006`). Existing-checkout updates retain stash/restore behavior.

An ordinary `%LOCALAPPDATA%\hermes` launch later exposed a third seam: Electron inherited PowerShell 7's `PSModulePath` and passed it to Windows PowerShell 5.1, which selected an incompatible `Microsoft.PowerShell.Security` module before Astral's installer could run. Desktop now omits `PSModulePath` only for `powershell.exe`, allowing version-correct defaults while preserving it for `pwsh.exe`. The pinned installer also makes at most two attempts, uses `UV_NO_MODIFY_PATH=1`, retains the last child diagnostics and restores its environment (`D-009`). No arbitrary host uv is accepted.

At commit `7c87c4781194fc03013d584ab95ee0f45313f4c8` the packaged Desktop then proved:

- installer manifest fetched from the exact fork commit;
- all 15 one-time setup stages completed;
- managed checkout HEAD and tracked branch equal the packaged commit/branch;
- managed checkout `origin` is `https://github.com/EidzokuxS/hermes-agent.git`;
- managed checkout has `core.longpaths=true`;
- the production backend runs from the managed checkout venv;
- the Desktop reached the full Hermes chat shell with `Gateway ready` and no model/provider call;
- after closing and reopening, `Gateway ready` returned in 8297 ms without re-entering the installer.

Because the GUI was launched by Codex Desktop, Windows placed the clean proof profile under Codex's package-local `%LOCALAPPDATA%` virtualization. This does not change repository identity or runtime resolution and is recorded rather than hidden.

Evidence:

- [First packaged ready shell](../../artifacts/evidence/hermes-foundation/task0/packaged-hermes-ready.png)
- [Restarted packaged ready shell](../../artifacts/evidence/hermes-foundation/task0/packaged-hermes-restart-ready.png)

## Remaining Task 0 gates

- Finish and classify the full native Windows Python denominator.
- Record the final source/report commit and close the Task 0 checklist only after the Python gate has evidence.

## Rollback proof

The annotated rollback tag was materialized as a separate detached worktree at its peeled commit. A clean `npm ci` installed 627 packages and audited 637 with 0 vulnerabilities. The predecessor requires its root project-reference build before per-workspace typecheck on a clean checkout; in the correct order, `npm run build`, `npm run typecheck` and `npm run test:foundation` exit 0.

The predecessor Electron Desktop then launched unchanged, started its original Node runtime, and reported `Online` in the Nox activity shell. No migration files were copied into that checkout. After screenshot capture the proof process tree was terminated explicitly because the predecessor Electron main process remained resident after its window closed.

- [Rollback Nox online](../../artifacts/evidence/hermes-foundation/task0/rollback-nox-online.png)
