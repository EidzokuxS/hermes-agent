# Protocol v1 acceptance evidence

Captured at `2026-07-12T08:45:54.075Z` for Task 1 of the accepted first-causal-loop plan.

## Golden fixtures

Seven versioned fixtures cover the canonical value, external Event, Act start, Act proposal with Effects, foundation State, open Continuation, and Journal record input. The fixture suite parses every one through its runtime schema, canonicalizes it, parses the canonical representation again, and compares the result structurally.

`npm run test --workspace @nox/protocol` passed all 12 tests. The rejection matrix proves that protocol v1 rejects:

- an Event with no protocol version;
- a State path outside `/picture` and `/workingField`;
- a silent settlement containing Effects;
- an ambiguous Act terminal status;
- an oversized or multi-fire Continuation;
- an incorrect State-changing classification;
- a State snapshot advance without an accepted State-changing Effect.

The same suite accepts an atomic State advance backed by an accepted Effect and proves that an explicit silent terminal preserves the current State version.

## Canonical hash

The implementation matches the known SHA-256 value for canonical JSON string `"abc"`, is invariant to object insertion order, and uses deterministic UTF-16 key ordering rather than locale-sensitive comparison.

Two fresh `tsx` processes hashed `canonical-value.json` independently:

```text
process-1=sha256:efad3808f3a84cdb7ced26c79b499530addb2351c5537cab2af9e35a6fba803d
process-2=sha256:efad3808f3a84cdb7ced26c79b499530addb2351c5537cab2af9e35a6fba803d
```

## Verification

- `npm run test --workspace @nox/protocol`: 1 file, 12 tests passed.
- `npm run typecheck --workspace @nox/protocol`: passed.
- `npm run build --workspace @nox/protocol`: passed with declarations.
- root `npm run test`: discovered and passed the same protocol project.
- root `npm run typecheck`: passed all nine workspaces.
- root `npm run lint`: passed.

The executable contract and its ownership/version rules are documented in `causal-runtime.md`.
