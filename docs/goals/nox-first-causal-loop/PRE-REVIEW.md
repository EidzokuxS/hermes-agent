# Первая причинная петля Nox — PRE Review

- **Mode:** PRE
- **Verdict:** aligned
- **Date:** 2026-07-12
- **Reviewed plan:** `docs/goals/nox-first-causal-loop/PLAN.md`
- **PLAN SHA-256:** `53704F5D8E740856356BDB36E6B123844099EE1EBE7A9C6B4379840CAB4814DB`
- **Blockers:** 0
- **Majors:** 0
- **Minors:** 0

## Resolved during review

- Electron main exclusively owns socket coordinates and launch credentials; preload exposes only typed Nox domain calls and notifications.
- Production and deterministic entrypoints share one injected runtime kernel, StorePort, protocol and RPC server; testkit stays outside every production graph.
- Both real-Pi Acts require one schema-valid terminating proposal and are separated by forced OS termination with PID/state evidence.
- Receipt, admission and Act ordering is explicit, idempotent and crash-safe. External recorded Events remain quarantined until direct or reconnect receipt-frame flush.
- State version advances only for accepted State-changing Effect; runtime-only `continuation.fire` carries standing-policy provenance.
- Independent audit replays State from genesis without importing runtime reducer or Desktop projection.
- Task dependencies, parallel ownership, production graph roots, kill-scan denominator and evidence bundle are explicit.
- Wire notification `event.admitted` maps directly to durable `EventAdmitted`.

## Next gate

Эйдзи принимает точный hash плана. После записи принятия с timestamp в `tasks/todo.md` Task 0 получает разрешение на исполнение.
