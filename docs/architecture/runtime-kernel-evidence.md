# Runtime kernel acceptance evidence

Captured at `2026-07-12T09:28:36.831Z` for Task 5 of the accepted first-causal-loop plan.

## Causal admission and Act boundary

`appendEvent` and `releaseEvent` are separate kernel operations. The real SQLite trace for an emission Act is:

```text
event.recorded
event.admitted
cortex.input-recorded
act.started
act.proposal-observed
effect.decision
act.terminal
```

Before `releaseEvent`, the Journal contained only `event.recorded`; Cortex had zero calls. Runtime persists canonical CortexInput bytes and hash, then commits `cortex.input-recorded` and `act.started` before invoking Cortex. External retry identity remains stable across a changed observed clock because Event ID and receipt identity derive from authenticated owner plus `clientEventId`; the original receipt and timestamp return unchanged.

## Terminal and version matrix

| Act path | Terminal / decision | State advance |
| --- | --- | ---: |
| emission only | `completed-effects`, accepted emission | 0 |
| explicit silence | `completed-silent` | 0 |
| valid State patch | `completed-effects`, accepted patch | +1 |
| invalid replace target | `completed-effects`, rejected Effect retained | 0 |
| provider failure | `failed` | 0 |
| cancellation with late proposal | `cancelled` + late diagnostic | 0 |

Proposal result bytes are content-addressed before terminal commit and referenced by `act.proposal-observed`. Decisions, optional State snapshot, `state.advanced`, and terminal outcome share one `CommitCommand`. Multiple identical artifacts retain multiple append-only provenance links rather than duplicating bytes.

## Cancellation and recovery

The cancellation test durably appended `act.cancel-requested` before aborting Cortex. A scripted Cortex deliberately ignored abort and returned a State patch. Runtime recorded the operational proposal and `act.late-output-diagnostic`, appended no Effect decision, left State at version 0, and settled the Act `cancelled`.

Startup recovery proved both sides of the receipt boundary:

- a `running` Act was settled `interrupted` without retry or State advance;
- an external Event left only `recorded` stayed quarantined and appeared in unresolved receipts;
- after durable admission of the same Event, recovery scheduled exactly one Act.

## Continuation

A model proposal scheduled one bounded Continuation and advanced State to version 1. After the injected clock reached its explicit due instant, runtime-only `continuation.fire` atomically removed it, advanced State to version 2, and created one provenance-marked admitted Continuation Event. That Event caused one fresh Act. A second scheduler pass returned no Event and the Journal contained exactly one fire decision.

## Verification

- `npm run test --workspace @nox/runtime`: 6 files, 21 tests passed.
- `npm run typecheck --workspace @nox/runtime`: passed.
- `npm run build --workspace @nox/runtime`: passed with declarations.
- `npm run test --workspace @nox/store-sqlite`: 11 tests passed after multi-provenance blob normalization and stable retry identity.

Production runtime source imports only `@nox/protocol`; the composition boundary accepts structural StorePort, CortexPort, ClockPort, and an injected ID factory. It imports neither Pi nor SQLite nor Desktop code.
