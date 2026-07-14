# Nox continuity context

Status: active implementation contract.

## Outcome

Every cognitive act receives a small, current map of Nox's position in time and accessible history. The active cortex can tell that relevant material may exist outside its context window and can retrieve it through the existing Hermes session-search path.

This is the first continuing-state primitive after the Hermes migration. It is not an autonomous scheduler, a second memory backend, a transcript summary, or a claim that the current model already possesses the whole history.

## First success point

1. Session A completes at least one turn and remains in canonical Hermes `state.db`.
2. A new session B starts after a process restart.
3. Before B's first model call, the cortex receives a bounded continuity context containing current time, current session identity, archive availability and a recent-history index that includes A.
4. The user does not provide A's session ID or instruct Nox to inspect history.
5. Nox can use the existing `session_search` tool to retrieve A when its subject is relevant.
6. No auxiliary model call constructs the continuity context, no copied transcript becomes a second authority, and the injected block is absent from persisted user messages.

## State authority

- Hermes `state.db` remains the authority for sessions, messages, titles and search.
- The Nox Journal remains the authority for causal provenance and process epochs.
- The continuity context is a disposable projection rebuilt from those authorities for each act.
- The accepted Nox identity revision remains session-bound and is reported from the existing identity binding rather than copied into another config file.

## Context contract

The projection contains only information useful for orientation:

- exact observation time and timezone;
- current durable session ID;
- accepted identity revision;
- latest causal Journal cursor and process epoch when available;
- archive availability and total discoverable session count;
- a bounded, newest-first index of prior sessions with durable ID, title, last activity time and lifecycle status;
- the existing retrieval capability name when `session_search` is actually available.

The projection does not contain full transcripts, hidden reasoning, credentials, tool payloads or inferred personal facts. Session titles are carried as quoted data with provenance; they are not promoted into Nox's picture or treated as established claims.

## Integration

1. Add a public `nox.continuity_context` reader with narrow protocols for clock, session catalogue and causal cursor.
2. Build the projection at turn preparation time, after the durable session is known and before the provider request is assembled.
3. Add it to the current turn's ephemeral API-only context beside the existing memory-provider and plugin context. Do not mutate the canonical user message.
4. Enable it only in Nox product mode. Base Hermes behavior and configured external memory providers remain unchanged.
5. Keep ordering deterministic and output bounded by record count and character budget.
6. Record only projection metadata and hashes in diagnostics; do not copy the rendered context into the causal Journal.

## Failure behavior

- An unavailable session catalogue produces an explicit unavailable projection with bounded diagnostics; it does not invent an empty history.
- An unavailable causal Journal omits its cursor while leaving session continuity usable.
- A malformed row is skipped with a count in diagnostics; one bad historical session cannot block the current act.
- Context construction performs no network or model call and has a strict local latency budget.

## Validation

- Pure ordering, bounding, quoting and unavailable-source tests.
- SessionDB integration over multiple sessions, archived/ended rows and a compressed descendant.
- Turn-context test proving API-only injection and unchanged persisted user content.
- Product-mode fence proving base Hermes and `skip_memory` behavior remain unchanged.
- Restart test proving the same history index is rebuilt in a new process.
- Packaged Desktop proof of session A → restart → session B → unprompted discovery and `session_search` retrieval.
- Production-graph update declaring `nox.continuity_context` as an intentional public seam.

## Stop conditions

This slice is complete only when the packaged proof passes and the context can be reconstructed from durable authorities after restart. It does not proceed into autonomous wakeups, self-authored standing policies or mutable world-picture state; those depend on this continuity primitive and receive separate contracts.
