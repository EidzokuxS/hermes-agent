# Nox Causal Bridge Design

Status: Task 4 integrated. The bridge observes the production Hermes lifecycle without becoming a second runtime or model loop.

## Outcome

The bridge records a causal account of what the production Hermes loop observed. It adds no model call, owns no Hermes message or tool fact, and exercises no decision authority over a turn.

```text
external RPC / internal Hermes continuation
  -> Hermes admission and single model/tool loop
  -> Hermes state.db                         operational truth
  -> bounded lifecycle callbacks
  -> Nox causal bridge
  -> append-only Nox observation journal    causal/provenance truth
```

Nox is the continuing personality of the whole system. The active model is the current cortex. The bridge records both the accepted Nox revision and the active cortex reference as distinct facts.

## Storage decision

The production bridge uses a small Python SQLite sink at `${HERMES_HOME}/nox/journal.sqlite3`, resolved from the active Hermes profile and injected in tests.

The retained TypeScript `packages/protocol` and `packages/store-sqlite` are not production dependencies for this bridge. Their current `event.admitted`, `act.started`, `effect.decision`, and `state.advanced` records describe an authoritative Nox runtime. Reusing those entries for observed Hermes work would claim that the retained runtime admitted or authored a turn. A Node adapter would also reintroduce a second production runtime. Both outcomes violate the migration boundary.

The Python journal is a forward production seam for Nox provenance. It does not import the retained reducer, advance constitutional State, or duplicate Hermes transcripts.

## Recorded facts

Each record contains:

- a strictly increasing SQLite sequence;
- a unique event ID and canonical record hash;
- one bridge correlation ID;
- a bridge turn ID for turn-scoped events;
- the Hermes UI session ID and durable Hermes session ID when available;
- the Hermes turn ID once the agent exposes `_current_turn_id`;
- a process epoch generated when the bridge opens;
- UTC observation time and process-monotonic nanoseconds;
- origin and lifecycle kind;
- SHA-256 hashes of submitted content and terminal visible output;
- provider, model/cortex reference, and accepted Nox revision hash at turn start;
- terminal status and bounded diagnostic metadata.

The journal stores no prompt, response, reasoning, tool payload, credential, attachment path, environment value, or transcript body by default. Independent audit resolves operational detail from Hermes `state.db` using the recorded Hermes identifiers and hashes.

## Positive event vocabulary

### Origins

- `external` — accepted `prompt.submit` RPC;
- `queued-external` — one turn caused by one or more external admissions received while busy;
- `goal-continuation` — a Hermes goal-manager continuation;
- `background-completion` — completion synthesis owned by a background process or delegation;
- `notification` — another Hermes-owned internal notification turn.

### Lifecycle records

- `external.admitted` — the gateway accepted an external request;
- `turn.queued` — an accepted request is waiting for the current turn boundary;
- `turn.steered` — an accepted request joined the currently active Hermes turn;
- `turn.started` — `_run_prompt_submit` committed to one Hermes run;
- `turn.bound` — the started bridge turn acquired the actual Hermes turn ID;
- `interrupt.requested` — Hermes accepted an interrupt request for the active turn;
- `turn.completed`, `turn.errored`, or `turn.interrupted` — exactly one terminal observation;
- `turn.abandoned` — restart reconciliation settled a prior-epoch start that had no observed terminal;
- `session.resumed` — Hermes resumed a durable session and linked any reconciled bridge turns.

Internal origins enter through `turn.started`; they do not fabricate an `external.admitted` record.

## Correlation object

`CausalCorrelation` is an immutable value passed explicitly through gateway lifecycle paths. It contains:

- `correlation_id`;
- `bridge_turn_id`;
- `origin`;
- zero or more `admission_ids`;
- optional `parent_bridge_turn_id`;
- `prompt_hash`;

Process epoch and observation times belong to each durable record rather than the
correlation passed through Hermes.

The session retains only the active correlation and queued correlation list. `_run_prompt_submit` receives the correlation as an argument; module globals never infer ownership from emitted UI events.

The RPC request ID participates in the external admission event ID. Replaying the same RPC request with the same session, request ID, and content produces the same canonical record. A conflicting replay is a diagnostic error. Two deliberate identical messages with different request IDs remain distinct admissions.

When busy-input handling merges text, every admission remains distinct and the queued turn carries all admission IDs. A successful steer links the admission to the active bridge turn instead of creating another turn.

## Hook order

### External prompt

1. `prompt.submit` validates the session and request shape.
2. The bridge appends `external.admitted` before the gateway returns an accepted status.
3. Busy handling appends `turn.queued` or `turn.steered`; an idle request carries its correlation into `_run_prompt_submit`.
4. `_run_prompt_submit` appends `turn.started` immediately before the single `agent.run_conversation` call.
5. After Hermes returns and updates its own operational session state, the bridge reads the actual Hermes turn ID and appends `turn.bound` plus exactly one terminal record.
6. The gateway emits the normal UI completion and preserves existing follow-up ordering.

An agent-build failure settles the admitted correlation as `turn.errored` with stage `agent-init`. A cancellation before model start settles it as `turn.interrupted` with stage `pre-start`.

### Internal continuation

Goal and background paths create a new correlation with their explicit origin and parent bridge turn. They call the same `_run_prompt_submit` seam and receive the same start, binding, and terminal treatment.

### Interrupt

`session.interrupt` appends `interrupt.requested` against the active correlation when Hermes accepts the request. The model loop result remains the authority for the terminal classification.

### Resume and forced restart

Opening the sink creates a new process epoch. Prior-epoch external admissions or
started turns with no terminal record remain queryable as unsettled. `session.resume`
supplies the durable Hermes session ID and any resolved compression parent to the
bridge, which appends `turn.abandoned` for each unsettled prior-epoch correlation and
then `session.resumed` linking those bridge turn IDs.

`turn.abandoned` means only that the bridge never observed a terminal before the process boundary. Independent audit compares the Hermes message tail to determine what operational data survived. The bridge never reconstructs a response body or rewrites Hermes status.

## Failure behavior and diagnostics

Every bridge call is exception-contained at the gateway boundary. A write failure leaves the Hermes request and transcript semantics unchanged.

The bridge maintains a bounded diagnostic snapshot containing health, failed-write count, last failure time, exception class, and affected lifecycle kind. The snapshot is exposed through session diagnostics and logged once per changed failure state. Recovery clears the active fault while preserving the cumulative count.

An admission write failure marks causal evidence degraded. It never redirects the request, retries a model call, or changes the response. Restart reconciliation and independent audit surface the resulting gap explicitly.

## SQLite contract

The sink uses WAL mode, `synchronous=FULL`, a short busy timeout, explicit transactions, and append-only triggers. Core tables are:

- `bridge_process_epochs` — process epoch and start observation;
- `bridge_records` — canonical append-only lifecycle records;
- `bridge_turn_heads` — a rebuildable index of the latest lifecycle state per bridge turn;
- `bridge_diagnostics` — append-only persisted health transitions that the sink itself was able to record.

`bridge_turn_heads` contains no independent truth; startup can rebuild it from `bridge_records`. Record insertion and head projection update share one transaction.

When Hermes exposes its turn ID only at completion, `turn.bound` and the terminal
record are committed in one transaction. This preserves both lifecycle facts while
paying for one durability flush at that boundary.

Idempotent replay returns the existing sequence when the event ID and semantic hash
match. The semantic hash excludes process epoch and observation clocks, so the same
RPC can be retried after restart while preserving the first durable observation.
The full canonical record hash still covers those observation facts. Event-ID reuse
with different semantic content raises a conflict and increments diagnostics.

The bridge keeps no process-lifetime cache of historical events or admissions.
SQLite resolves replay, and only active runtime/binding context remains in memory;
that context is removed after a successful terminal write.

## Production interfaces

```python
class CausalBridge:
    def admit_external(...) -> CausalCorrelation: ...
    def queue(correlation: CausalCorrelation, ...) -> None: ...
    def steer(correlation: CausalCorrelation, active: CausalCorrelation) -> None: ...
    def start(correlation: CausalCorrelation, runtime: RuntimeRefs) -> None: ...
    def bind_hermes_turn(correlation: CausalCorrelation, hermes_turn_id: str) -> None: ...
    def request_interrupt(correlation: CausalCorrelation) -> None: ...
    def terminal(correlation: CausalCorrelation, outcome: TerminalObservation) -> None: ...
    def reconcile_resume(...) -> ResumeObservation: ...

class FailOpenCausalBridge:
    @property
    def diagnostics() -> BridgeDiagnostics: ...
```

The gateway receives the fail-open facade around an injected low-level bridge. The
facade returns correlations even when admission evidence cannot be written, preserves
runtime references across a failed start, reports a bounded in-memory health snapshot,
and persists only changed failure/recovery states when SQLite remains writable. Tests
use an injected fault sink or temporary SQLite sink. Production composition resolves
one sink per active Hermes profile.

## Verification matrix

The implementation gate requires:

- normal, error, interrupt, pre-start cancel, queued, steered, goal-continuation, background-completion, and resumed traces;
- duplicate event replay and conflicting replay tests;
- multiple external admissions merged into one queued turn without lost provenance;
- exactly one terminal record per started bridge turn;
- prior-process unsettled turn reconciliation after a forced restart;
- content-hash and metadata redaction checks proving transcript bodies and credentials are absent;
- an independent SQLite reader that imports neither Hermes session code nor the retained Nox reducer;
- unchanged focused Hermes prompt, stream, queue, interrupt, goal, notification, and resume tests;
- zero additional provider/model calls;
- measured p95 synchronous write overhead below 10 ms on the evidence machine.

Production hooks remain closed until the accepted Nox revision exists and Task 3 supplies a stable identity reference for `turn.started`.

## Implementation evidence

The implementation includes typed events, the SQLite sink, lifecycle coordinator,
fail-open facade, independent auditor, and bounded gateway hooks. Production imports
only the public `nox.causal_bridge` package entrypoint; deep bridge imports are rejected
by the production graph fence.

Current validation:

- Ruff format/check: pass;
- `ty check nox/causal_bridge`: pass;
- causal bridge, SQLite sink, fail-open facade, and independent-auditor tests:
  36 pass;
- production gateway lifecycle tests: 10 pass;
- production graph fence: 10 pass;
- normal and pre-bound completion, error, interrupt, queued merge, steering,
  all three internal origins, agent-init error and pre-start interruption,
  per-session restart reconciliation before and after model start,
  same-process and cross-process semantic replay, conflicting replay, atomic batch
  rollback, one-terminal enforcement,
  concurrent sequence allocation, append-only storage, body redaction, read-only
  reconstruction, tamper detection, contained admission/start/terminal write failure,
  diagnostic deduplication, and recovery transition: pass;
- production gateway coverage includes normal completion, model error, agent-init
  error, actual interrupt, busy steer, queued merge, compression-rotated terminal,
  repeated resume, bridge construction failure, and a subprocess killed after
  `turn.started` then reconciled by a new process epoch;
- a compression-chain resume reconciles unsettled prior-process work under both the
  rotated parent and current tip, while appending one `session.resumed` record;
- focused Hermes gateway and busy-queue regressions: 326 pass;
- five fresh-database series of 200 measured normal turns after 25 warm-up turns
  per series through the production-intended fail-open facade, each committing
  `external.admitted`, `turn.started`, and an atomic `turn.bound` +
  `turn.completed` batch with `synchronous=FULL`: aggregate p50 6.825 ms,
  aggregate p95 9.631 ms; per-series p95 8.834–12.035 ms; one
  scheduling/storage outlier reached 150.881 ms. The aggregate p95 budget passes;
  short-series tail variance remains visible rather than being discarded;
- benchmark artifact: `artifacts/evidence/hermes-foundation/task4/bridge-latency.json`,
  SHA-256 `2bf25c3eed48b0cefd4d5fae267c4770da9d01863cfeadf9d7ebae7522732363`;
- the gateway retains its single existing `run_conversation` call; causal observation
  adds zero provider/model calls.

The accepted Task 3 package revision ships `nox.identity`, `nox.causal_bridge`, and the
single canonical `identity/NOX.md`. Hermes `state.db` remains operational truth;
`${HERMES_HOME}/nox/journal.sqlite3` is content-free causal/provenance evidence.
