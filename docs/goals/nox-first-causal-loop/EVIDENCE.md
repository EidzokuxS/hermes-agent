# Первая причинная петля Nox — Evidence

**Status:** `implemented but unproven`

## Acceptance Evidence

The original `task11-deterministic` bundle at commit `87fbc5c` is retained as historical evidence but is superseded: final review found that its first screenshot came from a Task 8 fixture and that the Event was submitted through the headless harness before Desktop restored the database. It must not be used as acceptance proof.

The corrected deterministic lane now:

- submits E1 through the compiled Electron renderer/preload/main path;
- captures the observed `delivered -> admitted -> thinking` order from DOM mutations;
- shows State `v1`, E1/A1 emission and open C1 before killing the runtime process;
- reopens the same Desktop user-data directory with a different runtime PID and shows C1/E2/A2 at State `v3`;
- captures all screenshots from that run and binds DOM capture reports to their hashes, State and Journal cursor;
- compares the exported causal trace record-for-record with SQLite, verifies every CortexInput blob/hash and binds RPC receipts to durable receipt rows;
- independently scans every bundle artifact for configured secrets, credential patterns and hidden-reasoning payloads;
- runs on pinned Node `24.18.0`; deterministic-only verification is explicit, while the default verifier requires a passing real-Pi lane.

Final clean deterministic bundle `artifacts/evidence/first-causal-loop/task11-deterministic-a28cb6f/` was produced from commit `a28cb6f58b6bf414f7bf099dae5bb8705bf0539e` and passes with 16 artifacts and final State:

- manifest: `status=pass`, `evidenceLane=deterministic`, `sourceTreeDirty=false`, `redaction=pass`;
- independent final State: `sha256:ae02f42d1597c655b4e8b2d400e093e8222df2b941ed3ad77d7b50b2dd245c34`, version 3;
- process restart: different PIDs, forced termination recorded, two CortexInput hashes;
- actual compiled Electron displayed State `v1`/cursor `10` before restart and State `v3`/cursor `20` after restart;
- receipt matrix: six crash boundaries, exactly one Event/admission/Act after recovery and zero admission at every pre-release boundary;
- offline audit replay: genesis through v3, runtime reducer and Desktop projection excluded;
- deterministic-only verification passed twice from the sealed bundle; default verification rejected it because a full real-Pi lane is intentionally mandatory.

The required real Pi run was attempted once and preserved at `artifacts/evidence/first-causal-loop/real-pi-attempt-01/`. `openai-codex / gpt-5.4-mini` returned `The usage limit has been reached` before producing a proposal. Its `real-pi-run.json` is `status=fail`; no retry or scripted substitution was counted as real evidence.

Therefore deterministic implementation evidence is complete, but the goal's real-model acceptance condition is not.

## Verification

Passed:

```text
npm run node:check           # v24.18.0 matches
npm run test                 # 19 files, 84 tests
npm test --workspace @nox/desktop  # 10 files, 19 tests
npm run lint                 # pass
npm run fmt:check            # pass
npm run typecheck            # all workspaces pass
npm run build                # pass
npm run test:foundation      # 6 files, 14 tests, including production Continuation restart
npm run test:desktop-integration  # 2 files, 3 tests
npm run check:kill-criteria  # 8/8 rules pass
npm run evidence:first-loop -- --run-id task11-deterministic-a28cb6f
npm run verify:first-loop -- --bundle artifacts/evidence/first-causal-loop/task11-deterministic-a28cb6f --deterministic-only
                               # 16 artifacts, status=pass
npm run verify:first-loop -- --bundle artifacts/evidence/first-causal-loop/task11-deterministic-a28cb6f
                               # exit 1: full verification requires real-Pi evidence
```

Tamper proof: modifying a copied `deterministic/state-replay.json` caused offline verification to exit `1` with `Artifact byte length mismatch`.

Ten-run process repetition passed 10/10. The PLAN's literal `--runs 10` flag is not supported by pinned Vitest 4.1.5, so the equivalent was executed as ten separate `npm run test:foundation` invocations; the incompatibility is recorded in `docs/architecture/runtime-restart-evidence.md`.

## Review Notes

First POST/correctness passes found production Continuation scheduling, Journal tail/pagination, Cortex config integrity, diagnostic redaction, Desktop IPC origin, evidence provenance and import-graph gaps. Later reviews also found unbounded Desktop/runtime Journal projections, invisible post-ready runtime failures, ambiguous secret-scan paths and two destroyed-window/health ordering races.

Repeated POST, correctness and maintainability reviews now report no remaining internal blocker: Journal lookups/projections are bounded, operational failures are journaled and surfaced, destroyed Electron objects are fenced, and unhealthy state survives pre-window and pre-hydration ordering. Completion still requires a successful configured real Pi run.
