# Pure runtime transition evidence

Captured at `2026-07-12T09:04:41.131Z` for Task 3 of the accepted first-causal-loop plan.

## Deterministic CortexInput

`buildCortexInput` accepts only explicit Act ID, validated State snapshot, trigger Event, selected Journal records, observed time, and bounded cortex configuration. It sorts Journal records by durable sequence, sorts set-like State projections, records clock regression without converting it into urgency, and returns canonical bytes plus SHA-256.

Two fresh processes produced the locked v1 input hash:

```text
sha256:0379e34b8c58548da7eb1176431bcb0cb1ec4bc2a23471738ceb4ac045c56a19
```

Reversing the input Journal array produced the same object, bytes, and hash. Reducing the Journal bound selected the same newest sequence deterministically.

The strict `CortexInput` schema rejects an added `transcript` field. Identity comes from the State-owned `identity` reference; current interaction arrives as a typed Event, and selected history arrives as provenance-bearing Journal context. The serialized fixture contains neither `transcript`, `urgent`, nor `overdue`.

## Pure reducer

The reducer parses every decision, sorts by fixed Effect ordinal, rejects duplicate IDs/ordinals, and mutates only `/picture`, `/workingField`, or open Continuations. Six permutations of the same three accepted Effect decisions produced one State hash.

Verified rules:

- multiple accepted State-changing Effects advance State exactly once;
- accepted emission-only and rejected Effects preserve State and produce no snapshot;
- schedule and cancel mutate the visible bounded Continuation set;
- object and array JSON Pointer operations are immutable with respect to the input snapshot;
- missing replace targets and prototype-polluting keys are rejected;
- State time advances only from the explicit observed instant and increments one logical tick.

## Verification

- `npm run test --workspace @nox/runtime -- input-builder reducer`: 2 files, 11 tests passed.
- `npm run typecheck --workspace @nox/runtime`: passed.
- `npm run build --workspace @nox/runtime`: passed with declarations.
- Protocol regression: 12 tests and typecheck passed after adding the shared strict CortexInput contract and unsafe-path rejection.

The shared CortexInput schema lives in `@nox/protocol` because both the neutral runtime and the separately packaged Pi adapter must depend on the same contract without adding a reverse dependency from Pi to runtime.
