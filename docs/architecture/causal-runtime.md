# Nox causal runtime protocol v1

This document describes the executable boundary owned by `@nox/protocol`. It translates the first causal-loop plan into versioned records; it does not redefine the conceptual authority in `NOX-CONVERGENCE.md`.

## Authorities

| Concern | Authority |
| --- | --- |
| Meaning and constitutional constraints | `NOX-CONVERGENCE.md` |
| Runtime and wire shape | `packages/protocol` |
| State-transition decisions | `packages/runtime` |
| Durable causal and audit history | SQLite `journal_records` |
| Read acceleration | append-only SQLite State snapshots |

No transcript, prompt, UI store, Pi context, or snapshot is an alternative causal authority. A snapshot is trusted only together with its State hash and exact Journal cursor.

## Six primitives

1. **Event** is an occurrence delivered into Nox. External Events carry a stable `(interfaceOwnerId, clientEventId)` identity and move explicitly from `recorded` to `admitted`. Bootstrap and Continuation Events begin admitted because they have no external receipt boundary.
2. **State** is the durable current configuration of Nox: identity reference, inherited standing policy, picture, working field, open Continuations, temporal anchor, cortex reference, and schema versions.
3. **Act** is one bounded cognitive transition caused by one admitted Event. It starts against an exact State and CortexInput hash and ends in exactly one discriminated terminal state.
4. **Effect** is the only vocabulary through which an Act may propose consequences. Runtime validates every Effect and records an accepted or rejected decision before applying anything.
5. **Continuation** is a bounded, visible, cancellable, single-fire future causal seed. In protocol v1 its due condition is an explicit wall-clock instant and `maxFireCount` is exactly one.
6. **Journal record** is the immutable causal envelope for Events, admission, Acts, model artifacts, Effect decisions, cancellation, diagnostics, and State advancement.

All six primitives carry `protocolVersion: 1` directly or through their Journal envelope. Unversioned or unknown records are rejected at runtime boundaries.

## External Event admission

```text
event.append
  -> transaction: Event(admission=recorded) + Journal sequence
  -> return stable EventReceipt
  -> flush response frame
  -> idempotent releaseEvent
  -> transaction: EventAdmitted
  -> standing attention policy may start one Act
```

The receipt is the durability boundary. A retry with the same authenticated owner and `clientEventId`, or a recovery snapshot for that owner, returns the original receipt. A `recorded` external Event remains quarantined until a receipt-bearing frame has been flushed; startup cannot silently admit it.

## One Act

Runtime fixes the trigger Event, State version/hash, CortexInput blob hash, builder version, cortex/model identity, and bounds before provider invocation. Pi receives an ephemeral projection and may produce only an `ActProposalResult`.

Proposal outcomes are intentionally distinct:

- one valid `proposed` tool result;
- `plain-text` without the terminal tool;
- `duplicate-proposal`;
- `schema-invalid`;
- `truncated`;
- `provider-error`;
- `aborted`.

Only a valid proposal reaches Effect validation. No proposal result has direct State authority. Hidden reasoning and credentials are absent from the protocol; only operational input/output artifacts and hashes are eligible for audit storage.

An Act terminal is exactly one of `completed-effects`, `completed-silent`, `rejected`, `failed`, `cancelled`, or `interrupted`. Silence is a recorded settlement, not a missing response. Late provider output after cancellation is a diagnostic Journal artifact and cannot create a commit command.

## Effect vocabulary

| Effect | Model may propose | State-changing |
| --- | ---: | ---: |
| `state.patch` under `/picture` or `/workingField` | yes | yes |
| `emission.append` | yes | no |
| `continuation.schedule` | yes | yes |
| `continuation.cancel` | yes | yes |
| `continuation.fire` | no; runtime only | yes |

JSON Pointer paths outside the two mutable foundation roots are invalid. Root removal is invalid. Identity, inherited policy, schema refs, temporal machinery, and cortex identity are outside the model patch vocabulary.

## Commit and version rule

Every runtime commit supplies an expected current State version and one or more Journal record inputs. `CommitCommand` enforces these rules before StorePort sees it:

- every terminal outcome is represented by an `act.terminal` Journal entry;
- rejected Effects and non-success terminal outcomes still append Journal records;
- a new State snapshot is forbidden without at least one accepted State-changing Effect;
- an accepted State-changing Effect requires exactly one `state.advanced` record and one matching snapshot;
- a commit advances State by exactly one version, even when it contains several accepted State-changing Effects;
- emission-only, silent, rejected, failed, cancelled, interrupted, and diagnostic commits preserve State version unless the same atomic commit also contains an accepted State-changing Effect;
- an Act terminal names the resulting version of its commit.

The State hash is SHA-256 over canonical JSON. Canonical objects use ascending UTF-16 key order, arrays preserve order, and non-JSON values are rejected. Journal record hashes cover the full persisted record except the hash field itself.

## Continuation firing

Scheduling adds an open Continuation to State. Cancelling removes it through an accepted Effect. When the injected clock reaches its due instant, runtime creates an accepted runtime-only `continuation.fire` Effect. One transaction marks the Continuation fired, advances State, and records a provenance-linked admitted Event. Store uniqueness makes the fire single-shot across restarts.

## Interface projection

The public interface exposes only domain calls: `event.append`, `view.snapshot`, `journal.subscribe`, and `act.cancel`. It contains no socket address, process coordinate, launch token, provider credential, or generic tool call.

`view.snapshot` combines one validated State snapshot with its Journal cursor, visible Events and emissions, current Act, open Continuations, and unresolved receipt handshakes belonging to the authenticated interface owner. The Desktop projection is therefore disposable and rebuildable.

## Evolution

Protocol v1 is strict and closed by default. New variants require a schema-version decision, fixtures, canonical-hash proof, transition tests, and an explicit migration. Adding an optional field to an existing causal record without a version decision is not permitted.
