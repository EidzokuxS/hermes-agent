# Task 9 — deterministic hard-restart evidence

Date: 2026-07-12

## Shared execution path

The test child starts with `node --import tsx packages/testkit/src/runtime-child-main.ts`. It dynamically imports the exact production `apps/runtime/src/create-process-host.ts`, then composes the production `createRuntime`, `NoxRuntime`, `SqliteStore`, protocol and `NoxRpcServer`. Its only substitutions are the planned `ClockPort`, `CortexPort`, deterministic ID source and a StorePort fault wrapper.

Production source hashes at this checkpoint:

- `create-process-host.ts`: `CE9FD6C7805C090F26C03B78966815FED417A711D377CACD51779CA2AC2E62F4`
- `nox-runtime.ts`: `2AD010341D39C1E9239D8F40BCC06D92CB5F961FE57BDD800536E540656E808F`

An import scan over production `apps/**` and `packages/**` outside `packages/testkit/**` found zero `@nox/testkit` or `packages/testkit` imports.

## Restart proof

The deterministic flow performs E1/A1 in process `p1`, commits a State patch and C1, and observes State version 1. The harness terminates that OS process with `SIGKILL`, starts phase `p2` over the same SQLite directory at a later deterministic time, fires C1 as E2, executes A2 and reaches State version 3 with no open Continuation. The two process IDs differ. Independent `SqliteAuditReader.verifyStateHistory()` observes four snapshots (genesis through v3), two CortexInput hashes and a gapless Journal.

The repeatability test runs the complete two-process flow twice per test execution and asserts identical canonical Journal trace hash, final State hash and CortexInput hashes. `test:foundation` was then run ten separate times; every run passed all 10 then-current process tests. This is stronger than merely repeating one in-process reducer assertion.

The PLAN's literal command `npm run test:foundation -- --runs 10` was also executed and rejected by pinned Vitest 4.1.5 with `Unknown option --runs`. Root manifests remained frozen. The supported equivalent was a PowerShell loop invoking `npm run test:foundation` ten times; all ten returned PASS.

## Crash and negative matrix

The process is forcibly ended at six boundaries. [task9-receipt-recovery.json](../goals/nox-first-causal-loop/artifacts/task9-receipt-recovery.json) records the observed counts. Every recovered database contains exactly one Event, one admission, one Act and one terminal. The four pre-release boundaries have zero admission before recovery; the sender-callback boundary permits the peer to observe already-buffered bytes but still permits no admission.

Additional process runs prove:

- cancellation commits one `act.cancel-requested`, fences late scripted output into one `act.late-output-diagnostic`, commits no Effect and produces one cancelled terminal;
- schema-invalid Cortex output produces one rejected terminal and no State advancement;
- an invalid State Effect remains visible through `SqliteAuditReader.readRejectedEffects()`, while an independently valid emission commits and State stays at version 0.

## Verification

```text
npm run build --workspace @nox/testkit
npm run test:foundation
# 3 files, 11 tests passed at the Task 9 gate
```

The supported ten-run loop reported `run 1 PASS` through `run 10 PASS`, each with all process tests passing.
