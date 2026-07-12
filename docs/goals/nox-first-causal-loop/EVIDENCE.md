# Первая причинная петля Nox — Evidence

**Status:** `proven`

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

The final full bundle `artifacts/evidence/first-causal-loop/real-pi-zai-glm47-20260712-1629/` was produced from clean commit `486eabff3113d60f0da7bd4ea921760f437c169c` and passes with 27 manifest-bound artifacts:

- real Pi provider/model: `zai / glm-4.7`, one provider attempt per Act;
- exactly two external Events, receipts, admissions, `glm-4.7` Act starts, schema-valid proposals and matching `completed-effects` terminals;
- each operational artifact contains exactly one `propose_act` call and one bounded `emission.append`, with no diagnostic or hidden-reasoning payload;
- Journal order is `recorded 1 < admitted 2 < started 4` for E1 and `recorded 8 < admitted 9 < started 11` for E2;
- the production runtime was terminated with `SIGKILL`; the restarted runtime used PID `43916` after PID `45140`;
- both entry-scoped Desktop traces show `recording -> delivered -> admitted -> thinking -> settled` without reusing the other Act's projection;
- independent SQLite inspection and replay bind both receipts, proposals, terminals, CortexInput blobs/hashes, screenshots and RPC traces;
- manifest: `status=pass`, `evidenceLane=full`, `sourceTreeDirty=false`, `redaction=pass`;
- default full verification passed repeatedly against the named immutable bundle, with exactly 27 files and no SQLite sidecars.

Failed provider attempts remain preserved as negative evidence under separate run IDs. `real-pi-attempt-01` records the `openai-codex / gpt-5.4-mini` usage-limit failure; `real-pi-deepseek-20260712-1625` records insufficient provider balance; `real-pi-zai-glm47-20260712-1626` records the superseded cross-entry DOM observation defect. None was substituted for passing evidence.

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
npm run evidence:first-loop -- --real-pi --run-id real-pi-zai-glm47-20260712-1629
npm run verify:first-loop -- --bundle artifacts/evidence/first-causal-loop/real-pi-zai-glm47-20260712-1629
                               # 27 artifacts, evidenceLane=full, status=pass
```

Tamper proof: modifying a copied `deterministic/state-replay.json` caused offline verification to exit `1` with `Artifact byte length mismatch`.

Ten-run process repetition passed 10/10. The PLAN's literal `--runs 10` flag is not supported by pinned Vitest 4.1.5, so the equivalent was executed as ten separate `npm run test:foundation` invocations; the incompatibility is recorded in `docs/architecture/runtime-restart-evidence.md`.

## Review Notes

First POST/correctness passes found production Continuation scheduling, Journal tail/pagination, Cortex config integrity, diagnostic redaction, Desktop IPC origin, evidence provenance and import-graph gaps. Later reviews also found unbounded Desktop/runtime Journal projections, invisible post-ready runtime failures, ambiguous secret-scan paths and two destroyed-window/health ordering races.

Repeated POST, correctness and maintainability reviews report no remaining blocker, major or minor finding. The final reviewers independently inspected the full bundle, its screenshots, SQLite Journal, operational blobs and per-Act DOM traces. After removing reviewer-created SQLite sidecars, the named bundle passed the default verifier twice without recreating them. Task 11 and the full plan evidence gate are satisfied.
