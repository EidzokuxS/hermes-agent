# Task 8 — Desktop projection and direct Nox cutover evidence

Date: 2026-07-12

## Direct path

The production path is singular:

```text
renderer → sandboxed preload → Electron main → authenticated loopback Nox RPC → runtime process → SQLite Journal
```

- The renderer receives only `snapshot`, `appendEvent`, `cancelAct` and typed notification subscription methods. It never receives the loopback URL or launch token.
- The launch token is generated in Electron main and passed to the runtime through its private environment, not the process command line.
- A request is first projected as recording, then delivered from the durable receipt, then admitted/running only from later Journal notifications.
- Electron advances a single cursor with a bounded 200 ms subscription pump. Every returned change is still projected from committed Journal records through the Nox RPC notification schema.
- Renderer reload and full Desktop restart rebuild from `ViewSnapshot`; no local transcript is treated as causal State.

## Snapshot contract correction

Task 8 exposed a real recovery defect in the original Task 6 view: `currentAct` alone could not restore settled outcomes. `ViewSnapshot` now carries bounded `acts` and `actTerminals` arrays so a reload can reconstruct `Event → Act → terminal`, including silent, cancelled and failed settlements. The SQLite Journal remains the truth owner; the arrays are read projections only.

Continuation cancellation is exposed as a request to Nox rather than a direct interface mutation. Only Nox may propose the causal `continuation.cancel` Effect, preserving the autonomy boundary and the single State write path.

## Verification and observed states

Focused UI tests prove the direct ordering `recording → delivered → admitted → thinking → terminal`, including silent settlement. Store projection tests prove unresolved receipts and settled Acts rebuild from snapshot.

The following renderer states were captured and inspected:

- [delivered](../goals/nox-first-causal-loop/artifacts/task8-delivered.png)
- [running](../goals/nox-first-causal-loop/artifacts/task8-running.png)
- [emitted](../goals/nox-first-causal-loop/artifacts/task8-emitted.png)
- [silent](../goals/nox-first-causal-loop/artifacts/task8-silent.png)
- [cancelled](../goals/nox-first-causal-loop/artifacts/task8-cancelled.png)
- [failed](../goals/nox-first-causal-loop/artifacts/task8-failed.png)
- [restored projection](../goals/nox-first-causal-loop/artifacts/task8-restored.png)

A separate Playwright Electron smoke launched the actual compiled main process, its child runtime, sandboxed preload and file renderer against an isolated user-data directory: [actual Electron restart surface](../goals/nox-first-causal-loop/artifacts/task8-electron-restored.png). The observed runtime status was `runtime present`, State was `v0`, and Journal cursor was `0`.

Commands:

```text
npm run test --workspace @nox/desktop
npm run typecheck --workspace @nox/desktop
npm run build --workspace @nox/desktop
npm run test --workspace @nox/runtime-app
```

Result: Desktop 6 test files / 9 tests passed; runtime-app integration passed; all listed builds and typechecks passed.
