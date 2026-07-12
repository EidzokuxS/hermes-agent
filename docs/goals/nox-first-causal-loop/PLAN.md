# Первая причинная петля Nox — Implementation Plan

**Intent:** Построить первый доказуемый вертикальный срез Nox, в котором собственный runtime принимает событие, проводит один ограниченный когнитивный акт через сменяемый Pi-кортекс, атомарно фиксирует последствия, переживает жёсткую остановку и продолжает ту же причинную линию.
**Current Behavior:** Workspace содержит канонический концепт и исследовательский план. Исполнимого runtime, устойчивого Journal, протокола, Pi-адаптера и Desktop-приложения пока нет. Pi и Hermes существуют только как внешние доноры со своими task/session/chat-семантиками.
**Expected Outcome:** Эйдзи запускает Nox Desktop, вводит сообщение как Event, получает durable delivery receipt, наблюдает завершение Act с emission либо явной тишиной, закрывает процессы и после запуска видит восстановленные State, время и Continuation. Следующий Event вызывает новый Act в той же причинной линии. Независимый audit CLI восстанавливает цепочку из Journal без runtime-проекции.
**Target-Perspective Output:** Эйдзи видит в Desktop статус доставки Event, состояние Act, версию State, открытый Continuation и различимые исходы `completed-with-emission`, `completed-silent`, `cancelled`, `failed`. После жёсткой остановки и повторного запуска он видит ту же линию и может открыть evidence bundle с причинной трассой.
**Truth Owner:** `NOX-CONVERGENCE.md` владеет смысловым контрактом. `packages/protocol` владеет исполнимыми схемами. Добавляемый SQLite Journal, записываемый исключительно `packages/runtime` через `packages/store-sqlite`, владеет причинной и аудиторской истиной. State snapshots, Desktop view store и Pi messages являются воспроизводимыми проекциями.
**Contract Boundary:** Desktop общается с отдельным runtime-процессом через Nox JSON-RPC 2.0 protocol. Runtime вызывает `CortexPort.runAct(...)` и принимает типизированный `ActProposalResult`. Только runtime валидирует Effect и передаёт единый `CommitCommand` в `StorePort.transact(...)`.
**Cutover:** Hermes Desktop переносится как лицензированный UI-донор на закреплённом commit, после чего его backend launch, REST/RPC vocabulary, SessionDB и session store заменяются прямым Nox transport/view contract. Pi подключается только пакетами AI и agent core; Nox создаёт свежий transient context для каждого Act.
**Displaced Path:** Из активного import graph исчезают Hermes Python agent/gateway, `prompt.submit`, transcript-as-state, Hermes session persistence, Pi coding-agent shell, Pi follow-up/steering queues как continuity и прямое применение model/tool output к устойчивому State.
**Value Density:** Один срез пересекает все фундаментальные границы ровно по одному разу: Event delivery, deterministic input, cortex proposal, Effect validation, atomic State commit, Continuation, restart recovery, Desktop projection и independent audit. Богатая память, широкие инструменты и характер следуют после доказательства этой основы.
**Evidence Gate:** Рубеж считается доказанным только после двух проходов через один production kernel/protocol/store/RPC contract: детерминированного `E1 -> A1 -> C1 -> forced OS kill -> E2 -> A2` и bounded real-Pi прохода, где оба Act возвращают ровно один schema-valid terminating `propose_act`, а между ними выполняется forced OS termination runtime-процесса. Оба прохода должны дать Desktop evidence, independent State replay и нулевые совпадения kill-criteria checks.
**Acceptance Evidence:** `EVIDENCE.md` ссылается на timestamped bundle: manifest, durable receipt/RPC trace, SQLite backup, canonical causal trace, independent State-replay report, input-hash report, forced-restart report с PID, real-Pi run metadata, before/after screenshots и kill-criteria report.
**Evidence Lane:** `npm run evidence:first-loop` создаёт `artifacts/evidence/first-causal-loop/<run-id>/`; `npm run verify:first-loop -- --bundle <path>` повторно проверяет bundle. `apps/audit` читает копию SQLite read-only и формирует trace независимо от runtime projection code.
**Kill Criteria:** Активная сборка имеет один State write path, один Nox transport и один durable Journal. Reachable production graphs содержат только Pi AI/agent-core packages. Desktop delivery возникает из durable receipt. Fake cortex и fake clock достижимы только из test-only entrypoint. Hermes backend/session symbols и compatibility routes дают ноль совпадений в объявленном executable-source scope.
**Architecture Slice:** Новый TypeScript/npm workspace: `apps/{runtime,audit,desktop}` и `packages/{protocol,runtime,store-sqlite,cortex-pi,interface-rpc,testkit}`. Отдельный Node runtime владеет очередью актов и одной SQLite writer connection; Electron main владеет transport connection; renderer владеет только view projection.
**Plan Review Gate:** Requires PRE review before execution. Execution также требует явного принятия плана Эйдзи.

## Outcome contract

### Non-goals

За пределами этого рубежа остаются развитая метапамять и поиск, полноценная политика внимания, широкая система инструментов, необратимые внешние действия, параллельные ветви, мультимодальность, характер и ратификация наследства, самостоятельная экономика compute, обучение специализированного кортекса и дизайн окончательного образа Nox.

Первый рубеж доказывает причинную конструкцию будущей Nox. Он не служит заявлением о полноте Nox или о наличии сознания.

### Risk if wrong

Ошибочный owner либо мягкий cutover создаст чат-агента с брендом Nox: transcript станет скрытым носителем идентичности, UI и Pi получат конкурирующее состояние, рестарт разорвёт линию, а тишина смешается с отказом. Ошибка в транзакционной границе оставит Journal и State в разных версиях. Ошибка в Pi boundary позволит модели либо tool loop обходить юрисдикцию runtime.

## Зафиксированные архитектурные решения

1. **Runtime принадлежит Nox.** Он является цифровым телом причинного процесса, а не внешним task orchestrator. Он применяет только типизированные standing policies и сохраняет их provenance.
2. **Первая standing attention policy.** На первом рубеже каждый доставленный Event Эйдзи и каждый сработавший Continuation допускается к одному Act. Это маркированное временно действующее наследство; обязательство отвечать отсутствует, а `completed-silent` является полноценным выбором.
3. **SQLite — первая реализация StorePort.** Один локальный экземпляр Nox имеет одного writer. Используется встроенный `node:sqlite` в закреплённом Node `24.18.0`, `WAL`, `synchronous=FULL`, foreign keys, defensive mode и busy timeout. Каждая причинная фиксация проходит одной `BEGIN IMMEDIATE` transaction.
4. **Journal первичен, snapshots производны.** `journal_records` добавляется монотонно; `state_snapshots` хранит версию State и точный `through_sequence`; `audit_blobs` хранит content-addressed полные входы и доступные операционные выходы модели; `schema_migrations` фиксирует схему.
5. **Runtime — отдельный процесс.** Electron main запускает его с тем же data directory и подключается по JSON-RPC 2.0/WebSocket на loopback. Dynamic port, socket и одноразовый launch token остаются исключительно в Electron main. Preload bridge открывает renderer только versioned Nox domain methods и notifications без transport coordinates и credentials.
6. **Один Act — один Pi transition.** `@earendil-works/pi-ai@0.80.6` и `@earendil-works/pi-agent-core@0.80.6` закреплены на Pi commit `8479bd84743e8889f728acb21a62794102db0529`. Каждый Act получает свежий `AgentContext` и единственный завершающий tool `propose_act`.
7. **Model output имеет статус предложения.** Plain text без tool call, повторный proposal, schema failure, truncation, provider error и abort становятся различимыми `ActProposalResult`; каждый такой исход имеет нулевое право записи State.
8. **Effect vocabulary первого рубежа ограничен.** `state.patch` действует только на `/picture` и `/workingField`; `emission.append` создаёт интерфейсный emission; `continuation.schedule` и `continuation.cancel` управляют локальными продолжениями. Runtime-only `continuation.fire` применяется принятой standing policy при выполнении due condition, меняет State и в той же transaction создаёт Event. Пустой список Effect с `settlement: silent` завершает Act тишиной. Identity, inheritance, schema refs и cortex refs меняются только отдельными будущими контрактами.
9. **Hermes является UI-донором.** Источник закреплён на Hermes Agent commit `4281151ae859241351ba14d8c7682dc67ff4c126`, Desktop `0.17.0`, MIT. Сохраняются generic UI/thread/theme primitives и Electron hardening patterns. Hermes domain modules, brand assets и backend ownership остаются за пределами import manifest.

## Architecture slice

### Files to create

```text
AGENTS.md
.node-version
.gitignore
package.json
package-lock.json
tsconfig.base.json
eslint.config.js
vitest.workspace.ts
THIRD_PARTY_NOTICES.md

docs/upstream/PINS.md
docs/upstream/hermes-desktop-slice.json
docs/architecture/causal-runtime.md

apps/runtime/src/create-process-host.ts
apps/runtime/src/main.ts
apps/audit/src/{raw-reader,state-replay,verify,main}.ts
apps/desktop/electron/main.ts
apps/desktop/electron/preload.ts
apps/desktop/electron/nox-runtime-process.ts
apps/desktop/src/main.tsx
apps/desktop/src/app/nox-shell.tsx
apps/desktop/src/app/nox-composer.tsx
apps/desktop/src/app/nox-timeline.tsx
apps/desktop/src/store/nox-view.ts
apps/desktop/src/transport/nox-client.ts
apps/desktop/src/components/nox/act-status.tsx
apps/desktop/src/components/nox/continuation-list.tsx
apps/desktop/src/components/nox/state-version.tsx

packages/protocol/src/{event,state,act,effect,continuation,journal,provenance,interface,index}.ts
packages/runtime/src/{ports,create-runtime,nox-runtime,act-runner,input-builder,reducer,continuation-scheduler,recovery,index}.ts
packages/store-sqlite/src/{sqlite-store,schema,migrations,audit-reader,index}.ts
packages/store-sqlite/migrations/001_foundation.sql
packages/cortex-pi/src/{pi-cortex,proposal-tool,model-config,index}.ts
packages/interface-rpc/src/{frames,server,client,index}.ts
packages/testkit/src/{scripted-cortex,deterministic-clock,runtime-child-main,runtime-harness,index}.ts

tests/integration/{first-causal-loop,restart-recovery,cancellation-fence}.test.ts
tests/live/real-pi-first-loop.ts
tests/e2e/desktop-first-loop.test.ts
scripts/{check-kill-criteria,build-evidence,verify-evidence}.mjs
```

Каждый workspace package и app также получает собственные `package.json`, `tsconfig.json` и focused tests рядом с owned source. Task 0 фиксирует полный список этих manifests до параллельного исполнения.

### Files to modify or demote

- `rpi/nox-foundation/plan/PLAN.md` получает статус research predecessor и ссылку на этот PLAN как единственный execution source.
- `tasks/todo.md` отражает PRE review, принятие Эйдзи и последующее исполнение.
- Донорские файлы, перечисленные в `docs/upstream/hermes-desktop-slice.json`, переносятся в соответствующие `apps/desktop` paths с provenance; Nox domain files выше становятся владельцами поведения.

### Files and layers to avoid

- `NOX-RETHINK.md` и всё содержимое `REFERENCE ONLY` остаются закрытыми для чтения, поиска и изменений.
- Канонический `NOX-CONVERGENCE.md` служит read-only концептуальным owner в рамках этой цели.
- Hermes Python agent, `tui_gateway`, SessionDB, memory, skills, tools, cron, profiles, installers, update system, model management, git/worktree features и Hermes brand assets не входят в donor manifest.
- Pi coding-agent package, task/session shell, follow-up queue, steering queue и Pi state persistence не входят в production graph.

### Source of truth and persistence contract

| Concern | Owner | Contract |
|---|---|---|
| Природа Nox | `NOX-CONVERGENCE.md` | Смысловые инварианты и конституционные границы |
| Wire/domain schemas | `packages/protocol` | Versioned runtime schemas и fixtures |
| Transition authority | `packages/runtime` | Единственный validator и committer Effect |
| Causal/audit truth | SQLite `journal_records` | Монотонный append, stable sequence, typed payload, provenance, causal links |
| State read acceleration | SQLite `state_snapshots` | Производный snapshot только для новой State version, с `throughSequence` и `stateHash` |
| Full Act artifacts | SQLite `audit_blobs` | Content hash, media type, bytes, provenance |
| Desktop state | `apps/desktop/src/store/nox-view.ts` | Rebuildable snapshot + journal-cursor projection |
| Pi context | fresh `AgentContext` | Ephemeral projection одного Act |

SQLite schema использует STRICT tables, parameterized statements и versioned migrations. `journal_records` и `state_snapshots` имеют database guards against update/delete в normal runtime connection. Independent audit открывает копию database read-only. Backup/copy для evidence выполняется SQLite backup API после checkpoint, а не файловым копированием живых WAL-файлов.

### Read path

1. Desktop main запускает runtime с конкретным data directory и устанавливает authenticated local transport.
2. Renderer вызывает `view.snapshot`; ответ содержит `stateVersion`, `journalCursor`, видимые Event/emission, текущий Act, elapsed-time anchor, открытые Continuation и принадлежащие этому authenticated interface unresolved `recorded` Event receipts. Эти receipts образуют recovery handshake, а не второй источник состояния.
3. Renderer подписывается с cursor и редуцирует durable interface events в `nox-view.ts`.
4. Для Act runtime читает triggering Event, точный State snapshot, выбранные Journal refs, clock value, builder version и cortex config.
5. `input-builder.ts` создаёт canonical serialized `CortexInput`, сохраняет blob/hash и только затем вызывает CortexPort.
6. Pi получает свежий transient context. Proposal возвращается runtime, проходит schema/policy validation и единый commit.
7. Emission становится видимым после commit; `completed-silent` приходит как отдельный terminal event.

### Write path

1. `event.append` с обязательным `clientEventId` одной transaction пишет полный Event в admission state `recorded` и возвращает `eventId`, `journalSequence`, `recordedAt`, `stateVersion`. Повтор того же `clientEventId` возвращает тот же receipt и не создаёт второй Event.
2. RPC server ставит успешный response frame в ordered connection, дожидается его flush и только затем вызывает idempotent `releaseEvent(eventId)`. Release добавляет единственный `EventAdmitted` и открывает standing policy право запустить Act. UI показывает `delivered` только по receipt.
3. Startup recovery оставляет внешний `recorded` Event в карантине. При authenticated `view.snapshot` server включает unresolved receipt в response, дожидается flush этого frame и затем вызывает тот же idempotent release. Retry исходного `event.append` с тем же `clientEventId` проходит тот же receipt-flush-release path. Continuation/bootstrap Events создаются сразу `admitted`, поскольку внешний receipt им не принадлежит.
4. После admission runtime фиксирует `ActStarted`, input-blob hash, builder version, cortex/model identity и bounds до provider call.
5. Runtime фиксирует operational outcome, затем validator создаёт accepted/rejected Effect decisions с provenance.
6. Один `StorePort.transact(CommitCommand)` всегда добавляет decisions и terminal outcome и применяет accepted Effect. `stateVersion` увеличивается и новый snapshot добавляется только при принятом State-changing Effect. `state.patch`, `continuation.schedule`, `continuation.cancel` и runtime-only `continuation.fire` меняют State; emission-only, silent, rejected, failed, cancelled и interrupted сохраняют прежнюю State version, если та же transaction не содержит другого принятого State-changing Effect.
7. `continuation.schedule` хранит due condition и single-fire identity. При due scheduler под принятой standing policy создаёт provenance-marked `continuation.fire`; одна transaction переводит Continuation в fired, увеличивает State version и добавляет Event с unique continuation source. Restart подхватывает Event без terminal Act.
8. `act.cancel` сначала добавляет `CancelRequested`, затем срабатывает AbortSignal. Late Pi output остаётся audit diagnostic и не получает CommitCommand.
9. Startup recovery переводит оставшийся `running` Act в `interrupted` Journal outcome без новой State version; повторный запуск требует нового причинного решения, а не скрытого retry.

### Public contract boundary

```ts
interface CortexPort {
  runAct(input: CortexInput, signal: AbortSignal): Promise<ActProposalResult>;
}

interface StorePort {
  loadSnapshot(): Promise<StateSnapshot>;
  readJournal(query: JournalQuery): AsyncIterable<JournalRecord>;
  transact(command: CommitCommand): Promise<CommitReceipt>;
}

interface ClockPort {
  now(): Instant;
}

interface InterfacePort {
  appendEvent(command: AppendEventCommand): Promise<EventReceipt>;
  releaseEvent(eventId: EventId): Promise<void>;
  getView(query: ViewQuery): Promise<ViewSnapshot>;
  subscribe(cursor: JournalCursor): AsyncIterable<InterfaceEvent>;
}
```

JSON-RPC methods: `event.append`, `act.cancel`, `continuation.cancel`, `view.snapshot`. Server notifications: `event.admitted`, `act.started`, `act.settled`, `state.committed`, `emission.delta`, `emission.complete`, `continuation.updated`, `runtime.error`. `event.admitted` является wire-проекцией durable `EventAdmitted` record. Protocol version negotiation accepts ровно foundation v1; несовпадение даёт typed incompatible-protocol failure.

### Migration and cutover

Это greenfield cutover, поэтому compatibility period отсутствует. Hermes donor import происходит через allowlisted manifest. В той же задаче domain-facing paths получают Nox names, а Hermes gateway/session files не попадают в target tree. После подключения runtime остаётся один transport. RPI predecessor демотируется до rationale; этот PLAN становится единственной очередью исполнения.

## Acceptance scenarios

### Deterministic foundation proof

```text
S0
 -> E1 from InterfacePort, durable receipt
 -> A1 with scripted cortex
 -> accepted state.patch + continuation.schedule C1 + explicit silence
 -> S1 / C1 committed atomically
 -> runtime process receives hard kill after commit
 -> deterministic clock advances beyond C1 dueAt
 -> fresh runtime process opens the same database
 -> C1 atomically creates E2
 -> A2 observes S1, E1 and elapsed time
 -> accepted emission + S2
 -> independent audit reconstructs E1 -> A1 -> S1/C1 -> restart -> E2 -> A2 -> S2
```

The scripted cortex asserts exact input contents and fails on transcript substitution, missing elapsed time or wrong State version.

### Real Pi boundary proof

1. Desktop submits E1 and records its receipt before Pi invocation.
2. Real model returns exactly one schema-valid terminating `propose_act` within configured time/token bounds; its proposal settles as emission or explicit silence after validation.
3. Runtime settles A1 without granting raw output write authority and records the durable sequence/state hash.
4. Harness forcibly terminates the runtime at OS level after A1 commit, records PID, termination command/result and pre-kill journal sequence, then starts a fresh PID over the same data directory. Graceful shutdown does not satisfy this step.
5. Fresh runtime restores the same State hash/version and journal cursor. Desktop submits E2; A2 input references restored State and elapsed time.
6. A2 also returns exactly one schema-valid terminating proposal and settles as emission or explicit silence. Provider error, abort, truncation, missing proposal and duplicate proposal remain negative evidence and fail the real-Pi gate.
7. Каждый evidence run выполняет ровно один provider attempt для A1 и A2. Повторный ручной запуск получает новый `run-id`; предыдущий bundle сохраняется, поэтому скрытые retries отсутствуют.

### Negative proofs

- malformed, missing and duplicate `propose_act` calls apply zero Effect;
- rejected state path remains visible to independent audit;
- cancellation followed by late model output advances State zero times;
- renderer reload and full Desktop restart rebuild the same projection;
- optimistic local user bubble never receives `delivered` status;
- kill-criteria scanner finds zero Hermes backend/session routes, Pi coding-agent imports, second stores or compatibility transports.

### Kill-criteria scan contract

Production entrypoints are `apps/runtime/src/main.ts`, `apps/desktop/electron/main.ts`, `apps/desktop/electron/preload.ts`, `apps/desktop/src/main.tsx` and `apps/audit/src/main.ts`. The dependency-graph check traverses every import reachable from those roots. The executable-source text check covers `apps/*/src/**`, `apps/desktop/electron/**` and `packages/*/src/**`.

Explicit text-scan exclusions are `packages/testkit/**`, `tests/**`, `**/*.test.ts`, `docs/**`, `artifacts/**`, donor provenance manifests and `scripts/check-kill-criteria.mjs` itself. They allow test fakes and rule names to exist while keeping them unreachable from production. An exclusion never removes a file already reachable from any production entrypoint: reachability takes precedence and fails the gate. `kill-criteria.json` must enumerate every entrypoint, scanned root, exclusion, rule, reachable dependency, match and count; an undeclared exclusion fails the gate.

### Execution release record

Task 0 begins only after an aligned PRE review and explicit acceptance by Эйдзи. Acceptance is recorded in `tasks/todo.md` with UTC timestamp, exact plan path and SHA-256 of the accepted PLAN. Any later semantic plan edit changes the hash and requires a new acceptance entry.

## Task board

### Task 0 — Bootstrap, dependency lock and provenance

**Files:** `.git/`, `AGENTS.md`, `.node-version`, `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.base.json`, `eslint.config.js`, `vitest.workspace.ts`, `THIRD_PARTY_NOTICES.md`, `docs/upstream/PINS.md`, `docs/upstream/hermes-desktop-slice.json`; every app/package `package.json` and `tsconfig.json` named in the architecture slice.

**Scope:** Initialize Git and an npm workspace. Pin Node `24.18.0`; Pi packages `0.80.6`; Hermes commit/Desktop version; Electron/React/Vite/test dependencies as exact lockfile entries. Record MIT provenance and an allowlisted Hermes donor manifest. Write root `AGENTS.md` under 200 lines with commands, ownership, forbidden paths, canonical concept and Hermes-derived style constraints.

**Output:** Reproducible empty workspace with complete package graph and dependency lock; parallel tasks can work without touching root manifests or lockfile.

**Verification:** `node --version`; `npm ci`; `npm run lint`; `npm run typecheck`; `npm run test`; `git status --short`.

**Acceptance evidence:** Command transcript proving exact Node/package pins; provenance manifest resolving both commits; clean baseline test report.

**Depends on:** Aligned PRE review and the dated/hash-bound acceptance record defined above.

**Parallelism:** Sequential foundation. Releases Tasks 1, 6 and 7. All later tasks treat root manifests and lockfile as read-only.

### Task 1 — Versioned causal protocol

**Files:** `packages/protocol/src/event.ts`, `state.ts`, `act.ts`, `effect.ts`, `continuation.ts`, `journal.ts`, `provenance.ts`, `interface.ts`, `index.ts`; `packages/protocol/test/*.test.ts`; `packages/protocol/test/fixtures/*.json`; `docs/architecture/causal-runtime.md`.

**Scope:** Define TypeScript discriminated unions plus runtime schemas for all six primitives, receipts, proposal outcomes, commit commands and interface events. Define canonical serialization/hash rules, provenance fields, causal links, state-path allowlist and protocol v1 fixtures. External Event ingress has stable `clientEventId`, authenticated interface owner and explicit `recorded -> admitted` lifecycle; idempotent retry and recovery snapshot return the original receipt. Foundation State includes identity reference, inherited standing policies, picture, working field, open continuations, temporal anchor, cortex ref and schema versions. Encode one version rule: every terminal outcome appends Journal records, while `stateVersion` and snapshot advance only for accepted State-changing Effect; Continuation mutations count because open Continuations are part of State.

**Output:** One importable protocol authority that rejects unversioned records, State mutation without Effect, unrestricted state paths, ambiguous Act terminal states and unbounded Continuation.

**Verification:** `npm run test --workspace @nox/protocol`; `npm run typecheck --workspace @nox/protocol`.

**Acceptance evidence:** Golden fixture report with valid round trips and rejected forbidden transitions; canonical hash fixture stable across two processes.

**Depends on:** Task 0.

**Parallelism:** Owns only `packages/protocol/**` and `docs/architecture/causal-runtime.md`; blocks runtime, store, Pi and RPC semantic implementation.

### Task 2 — SQLite Journal, snapshots and independent reader

**Files:** `packages/store-sqlite/migrations/001_foundation.sql`; `packages/store-sqlite/src/sqlite-store.ts`, `schema.ts`, `migrations.ts`, `audit-reader.ts`, `index.ts`; `packages/store-sqlite/test/*.test.ts`.

**Scope:** Implement versioned STRICT schema, one writer connection, prepared statements and `BEGIN IMMEDIATE` commit boundary. Add append-only guards, optimistic State-version check, unique `clientEventId` per authenticated interface owner, unique Event admission, unique Continuation-fire identity, content-addressed blobs, WAL checkpoint/backup and read-only audit access. Snapshot is append-only derived evidence, exists once per State version and carries `throughSequence` plus State hash. Terminal commits without State-changing Effect append Journal records while preserving the current snapshot/version.

**Output:** StorePort that can atomically commit Journal + State + Continuation, reopen after process exit, and produce a consistent evidence copy.

**Verification:** `npm run test --workspace @nox/store-sqlite`; `npm run typecheck --workspace @nox/store-sqlite`.

**Acceptance evidence:** Transaction fault-injection matrix proves all-or-nothing commits; reopen/replay produces the same State hash; update/delete guard tests pass; independent reader sees rejected Effect.

**Depends on:** Task 1.

**Parallelism:** Parallel-safe with Tasks 3 and 6 after Task 1; it remains parallel-safe with Task 4 once Task 3 has released that task. Owns only `packages/store-sqlite/**`.

### Task 3 — Deterministic State transition and input assembly

**Files:** `packages/runtime/src/ports.ts`, `input-builder.ts`, `reducer.ts`, `index.ts`; `packages/runtime/test/input-builder.test.ts`, `reducer.test.ts`; `packages/runtime/test/support/deterministic-clock.ts`.

**Scope:** Implement pure reduction of accepted Effect, allowed-path enforcement, conditional State version advancement and deterministic CortexInput assembly from explicit State/Event/Journal/clock/config inputs. Persisted input bundle includes builder version and canonical hash. Emission-only and non-success terminal outcomes preserve State version. Time enters as observed data and elapsed interval, never as synthetic urgency.

**Output:** Pure functions whose outputs remain stable across process boundaries and whose rejected decisions leave State unchanged.

**Verification:** `npm run test --workspace @nox/runtime -- input-builder reducer`; `npm run typecheck --workspace @nox/runtime`.

**Acceptance evidence:** Cross-process golden hash; property tests for deterministic ordering; fixtures proving transcript is absent as an identity source.

**Depends on:** Task 1.

**Parallelism:** Parallel-safe with Tasks 2 and 6; owns only the listed runtime source and test-support files. Completion releases Task 4.

### Task 4 — Pi CortexPort and proposal fence

**Files:** `packages/cortex-pi/src/pi-cortex.ts`, `proposal-tool.ts`, `model-config.ts`, `index.ts`; `packages/cortex-pi/test/*.test.ts`; `tests/live/real-pi-first-loop.ts` skeleton.

**Scope:** Wrap Pi AI/agent core with a fresh AgentContext per Act, one schema-bound `propose_act` tool with `terminate: true`, AbortSignal, time/token bounds and typed outcomes. Expose zero state-changing Pi tools. Save only available API input/output, tool proposal, usage, stop reason and diagnostics; hidden reasoning remains outside the artifact contract.

**Output:** Replaceable CortexPort whose only authority is returning an ActProposalResult.

**Verification:** `npm run test --workspace @nox/cortex-pi`; `npm run typecheck --workspace @nox/cortex-pi`.

**Acceptance evidence:** Fixtures for valid, missing, duplicate, malformed, truncated, provider-error and aborted outcomes; dependency graph report contains only pinned Pi AI/agent-core packages.

**Depends on:** Tasks 1 and 3 input contract.

**Parallelism:** Starts only after Task 3 completes, then runs parallel-safe with Tasks 2 and 6; owns only `packages/cortex-pi/**` and the live-test skeleton.

### Task 5 — Runtime kernel, Continuation and recovery

**Files:** `packages/runtime/src/create-runtime.ts`, `nox-runtime.ts`, `act-runner.ts`, `continuation-scheduler.ts`, `recovery.ts`, `index.ts`; `packages/runtime/test/create-runtime.test.ts`, `act-runner.test.ts`, `continuation-scheduler.test.ts`, `recovery.test.ts`. `index.ts` is an explicit sequential ownership handoff from Task 3.

**Scope:** Implement one neutral `createRuntime(...)` composition boundary that accepts StorePort, CortexPort and ClockPort without importing Pi or testkit. Provide idempotent `appendEvent(...)` in `recorded` state and `releaseEvent(...)` admission as separate kernel operations; Act scheduling begins only after release. Startup enumerates unresolved external `recorded` Events for authenticated receipt recovery and never auto-releases them. Persist ActStarted/input before model invocation; validate proposal; commit decisions/State/Continuation/outcome atomically. Implement cancellation fence, late-output suppression, provenance-marked runtime-only `continuation.fire`, single-fire Continuation transaction and startup settlement of interrupted Acts. Admission and firing use the marked foundation standing policy.

**Output:** Headless runtime kernel with one serialized commit authority and recoverable work discovery from Journal, ready for the transport-owned process host.

**Verification:** `npm run test --workspace @nox/runtime`; `npm run typecheck --workspace @nox/runtime`.

**Acceptance evidence:** Ordered Journal trace for emission, silence, failure, cancellation and continuation; version matrix proves only State-changing accepted Effect creates a new snapshot; race test proves late completion advances State zero times.

**Depends on:** Tasks 2, 3 and 4.

**Parallelism:** Integration task; sequential over dependencies and owns only runtime kernel/app files.

### Task 6 — Nox JSON-RPC transport

**Files:** `packages/interface-rpc/src/frames.ts`, `server.ts`, `client.ts`, `index.ts`; `packages/interface-rpc/test/*.test.ts`; `apps/runtime/src/create-process-host.ts`, `main.ts` and their process-level transport tests.

**Scope:** Implement JSON-RPC v1 methods/notifications, cursor replay, bounded subscription buffers, protocol-version rejection and loopback authentication. `event.append` awaits durable record, queues its successful response on the same ordered connection, awaits frame flush, and only then invokes idempotent `releaseEvent`; no `ActStarted` can be appended before that release. On reconnect, authenticated `view.snapshot` includes unresolved recorded receipts, flushes that response and releases exactly those Event IDs through the same path. `create-process-host.ts` composes the same neutral runtime kernel and RPC server for every entrypoint; production `main.ts` injects SQLite, Pi and system clock. Electron main is the sole Desktop socket/token owner; renderer accesses typed preload domain methods and notifications only. Reconnect always begins with this snapshot/receipt handshake and cursor catch-up.

**Output:** One transport contract carrying durable receipts and rebuildable projections, with no Hermes method aliases.

**Verification:** `npm run test --workspace @nox/interface-rpc`; `npm run typecheck --workspace @nox/interface-rpc`; transport integration test against runtime.

**Acceptance evidence:** Captured RPC trace proves successful receipt-frame flush before `EventAdmitted` and `ActStarted` on direct append, idempotent retry and reconnect snapshot recovery. Fault injection at record/queue/flush/release boundaries proves zero admission before a successful flush, one Event, one EventAdmitted and one Act. Cursor replay and typed incompatible-protocol failure also pass.

**Depends on:** Task 1 for schema; final wiring depends on Task 5.

**Parallelism:** Protocol implementation can run beside Tasks 2–4; runtime wiring waits for Task 5. Ownership excludes all Desktop files.

### Task 7 — Hermes-derived Desktop shell

**Files:** Owned writes: `apps/desktop/electron/hardening.ts`, `window-state.ts`, `main.ts`, `preload.ts`, `nox-runtime-process.ts`; `apps/desktop/src/main.tsx`, `styles.css`, `themes/**`, `components/ui/**`, `components/assistant-ui/thread/**`. Read-only inputs fixed by Task 0: `apps/desktop/package.json`, `tsconfig.json`, `tsconfig.electron.json`, `vite.config.ts`, `docs/upstream/hermes-desktop-slice.json`, `THIRD_PARTY_NOTICES.md`.

**Scope:** Materialize only the allowlisted files from the pinned Hermes commit, preserve copyright/provenance, prune donor imports to their dependency closure, write a minimal Nox Electron entrypoint and preserve Hermes formatting/design conventions. Brand-specific assets, Hermes backend bootstrap and domain stores stay outside the manifest.

**Output:** Buildable Desktop shell rendering a static Nox timeline/composer fixture while launching a placeholder child-process seam.

**Verification:** `npm run test --workspace @nox/desktop`; `npm run typecheck --workspace @nox/desktop`; `npm run build --workspace @nox/desktop`; component screenshot fixture.

**Acceptance evidence:** Provenance manifest matches copied files; baseline screenshot shows the intended Hermes-derived shell; import scan has zero Hermes backend/session dependencies.

**Depends on:** Task 0.

**Parallelism:** Parallel-safe with Tasks 1–4 because its write scope is confined to the listed `apps/desktop` source files. Task 0 remains the sole owner of manifests, lockfile and provenance documents.

### Task 8 — Desktop projection and direct Nox cutover

**Files:** `apps/desktop/src/app/nox-shell.tsx`, `nox-composer.tsx`, `nox-timeline.tsx`; `apps/desktop/src/store/nox-view.ts`; `apps/desktop/src/transport/nox-client.ts`; `apps/desktop/src/components/nox/act-status.tsx`, `continuation-list.tsx`, `state-version.tsx`; `apps/desktop/electron/main.ts`, `preload.ts`, `nox-runtime-process.ts`; focused tests beside each file.

**Scope:** Connect Electron main to the real runtime, expose narrow typed preload calls, append Event from composer, show delivery receipt, reduce snapshot/notifications, stream committed emission, distinguish every terminal Act outcome and expose Continuation cancel. Electron main preserves ordered receipt-before-admission notifications and converts unresolved receipts from reconnect snapshot into the same delivered projection before later Act notifications cross preload. Renderer reload and full app restart rebuild from snapshot/cursor. No local transcript persistence becomes causal state.

**Output:** User-visible first vertical with one direct Nox path.

**Verification:** `npm run test --workspace @nox/desktop`; `npm run build --workspace @nox/desktop`; `npm run test:desktop-integration`.

**Acceptance evidence:** UI integration trace and screenshots for delivered, running, emitted, silent, cancelled, failed and restored states; direct append and recovery snapshot both show delivered before running for the same Event ID.

**Depends on:** Tasks 5, 6 and 7.

**Parallelism:** Sequential integration task; owns Desktop Nox domain files only.

### Task 9 — Deterministic hard-restart proof

**Files:** `packages/testkit/src/scripted-cortex.ts`, `deterministic-clock.ts`, `runtime-child-main.ts`, `runtime-harness.ts`, `index.ts`; `tests/integration/first-causal-loop.test.ts`, `restart-recovery.test.ts`, `cancellation-fence.test.ts`; package-local tests required by the harness.

**Scope:** Build a test-only `runtime-child-main.ts` that imports Task 6's `create-process-host.ts` and injects only scripted CortexPort and deterministic ClockPort. It uses the same runtime kernel, SQLite StorePort, protocol and RPC server as production. Spawn that child against a temporary data directory, execute E1/A1/C1, forcibly terminate its OS process after the commit receipt, advance time, start a fresh PID, observe E2/A2, then run the raw audit reader. Add a receipt recovery fault matrix with forced crashes: before Event commit; after record before response queue; after queue before flush; after flush before release; after release before ActStarted; after ActStarted. For unresolved recorded cases, reconnect snapshot/retry must flush the original receipt before one admission. Add cancellation/late-output and malformed-proposal negative runs. Production entrypoints and manifests never import testkit.

**Output:** Repeatable process-level proof of causal continuity independent of network/model variability, with one shared host/kernel path and two dependency-injected entrypoints.

**Verification:** `npm run test:foundation`; repeat `npm run test:foundation -- --runs 10`.

**Acceptance evidence:** Ten identical canonical traces and State hashes; process IDs differ across the forced restart; termination result is recorded; `receipt-recovery.json` proves one Event, one admission, one Act and zero admission before receipt flush at every crash boundary; audit reader sees every accepted and rejected decision; production dependency graph excludes `packages/testkit` while both entrypoints resolve to the same `create-process-host` and runtime kernel build hashes.

**Depends on:** Tasks 5 and 6.

**Parallelism:** Can run alongside Task 8 once runtime/transport are stable; owns testkit and integration tests.

### Task 10 — Evidence tooling and kill-criteria enforcement

**Files:** `apps/audit/src/raw-reader.ts`, `state-replay.ts`, `verify.ts`, `main.ts`; `apps/audit/test/*.test.ts`; `scripts/check-kill-criteria.mjs`, `build-evidence.mjs`, `verify-evidence.mjs`; root script entries already reserved in Task 0. `docs/goals/nox-first-causal-loop/EVIDENCE.md` remains a read-only template until Task 11 captures real evidence.

**Scope:** Build read-only audit export, SQLite backup, canonical trace/hash verification and artifact manifest with checksums and source/runtime version capture. `state-replay.ts` starts at genesis, validates sequence/causal links, replays accepted State-changing Effect through an audit-owned implementation using protocol schemas/canonical serialization, recomputes every State version/hash and compares it with stored snapshots and Desktop-restored version. It imports neither runtime reducer nor Desktop projection and proves rejected Effect never enters replay. Enforce the declared production entrypoint graph and executable-source scope for displaced Hermes/Pi paths, duplicate State writers, fake dependencies in production and optimistic delivery code.

**Output:** `npm run evidence:first-loop` and offline `npm run verify:first-loop -- --bundle ...` with deterministic pass/fail exit codes.

**Verification:** Run both commands on a deterministic bundle; mutate one copied artifact and prove verification failure; run `npm run check:kill-criteria`.

**Acceptance evidence:** Valid bundle verifies; tampered Journal, snapshot, receipt trace, receipt-recovery matrix or screenshot checksum fails; independent genesis replay matches every stored State hash/version and Desktop-restored version; kill-criteria report lists all roots/exclusions/rules/dependencies and zero prohibited matches.

**Depends on:** Tasks 2, 5, 8 and 9.

**Parallelism:** Sequential evidence integration; owns audit app and evidence scripts. Task 11 alone writes factual results into EVIDENCE.md.

### Task 11 — Target-perspective acceptance with real Pi

**Files:** `tests/live/real-pi-first-loop.ts`, `tests/e2e/desktop-first-loop.test.ts`, `artifacts/evidence/first-causal-loop/<run-id>/**`, `docs/goals/nox-first-causal-loop/EVIDENCE.md`, `tasks/todo.md` review section.

**Scope:** First run the deterministic process proof through Desktop. Then run a configured real Pi model with bounded tokens/time and one provider attempt per Act. Submit E1 and require one schema-valid terminating proposal; after its commit, record receipt, sequence and State hash and forcibly terminate the runtime OS process. Record PID and termination result, launch a fresh PID over the same data directory, verify restored sequence/hash, submit E2 and require a second schema-valid terminating proposal. Export receipt/RPC trace, database backup, independent genesis replay, screenshots and metadata. Execute every negative/kill gate. A provider error or invalid proposal fails this run; a manual rerun uses a new run-id and preserves the failed bundle.

**Output:** Complete evidence bundle and filled EVIDENCE.md. Any missing target-perspective artifact leaves status `implemented but unproven`.

**Verification:** `npm run test`; `npm run lint`; `npm run typecheck`; `npm run build`; `npm run evidence:first-loop -- --real-pi`; `npm run verify:first-loop -- --bundle <run-dir>`; `npm run check:kill-criteria`.

**Acceptance evidence:** `before-restart.png`, `after-restart.png`, `silent-or-emitted.png`, `rpc-trace.json`, `receipt-recovery.json`, `causal-trace.json`, `state-replay.json`, `process-restart.json`, `input-hashes.json`, `real-pi-run.json`, `kill-criteria.json`, `production-graph.json`, `nox.sqlite`, `manifest.json` with passing offline verification. RPC verification proves each receipt frame flushed before its `EventAdmitted`/`ActStarted` observations and that `EventRecorded < EventAdmitted < ActStarted` by Journal sequence.

**Depends on:** Tasks 8–10 and configured model credentials.

**Parallelism:** Final sequential gate. Completion claim waits for PRE/POST plan review, correctness review and maintainability review.

## Dependency graph

```text
Task 0 -> Task 1, Task 7
Task 1 -> Task 2, Task 3, Task 6 protocol
Task 3 -> Task 4
Task 2 + Task 3 + Task 4 -> Task 5
Task 5 + Task 6 protocol -> Task 6 wiring
Task 6 wiring + Task 7 -> Task 8
Task 5 + Task 6 wiring -> Task 9
Task 2 + Task 5 + Task 8 + Task 9 -> Task 10
Task 8 + Task 9 + Task 10 -> Task 11
```

Parallel execution is allowed only for disjoint ownership shown above. Task 0 locks shared manifests before parallel work; the main agent performs integration and every completion claim.

## Evidence bundle contract

```text
artifacts/evidence/first-causal-loop/<run-id>/
  manifest.json
  versions.json
  commands.log
  deterministic/
    causal-trace.json
    replay-report.json
    receipt-recovery.json
    state-replay.json
    process-restart.json
    input-hashes.json
    nox.sqlite
  real-pi/
    causal-trace.json
    state-replay.json
    process-restart.json
    real-pi-run.json
    input-hashes.json
    nox.sqlite
  desktop/
    rpc-trace.json
    before-restart.png
    after-restart.png
    silent-or-emitted.png
  reviews/
    kill-criteria.json
    production-graph.json
    pre-plan-review.md
    post-plan-review.md
    correctness-review.md
    maintainability-review.md
```

`manifest.json` records SHA-256 for every artifact, exact commands, exit codes, source commit, dependency lock hash, model/provider identifier and redaction report. `rpc-trace.json` records both request IDs, `clientEventId`, durable receipt fields, response-frame flush markers, `EventRecorded`, `EventAdmitted` and `ActStarted` sequences plus client-side observation order; offline verification requires the flush marker before admission/Act observation and `EventRecorded < EventAdmitted < ActStarted` for E1 and E2. Secrets, hidden reasoning and unredacted provider credentials never enter the bundle.

## Source pins

- Canon: [`NOX-CONVERGENCE.md`](../../../NOX-CONVERGENCE.md)
- Foundation primitives: [`rpi/nox-foundation/research/PRIMITIVES.md`](../../../rpi/nox-foundation/research/PRIMITIVES.md)
- Pi: `earendil-works/pi@8479bd84743e8889f728acb21a62794102db0529`, packages `0.80.6`, MIT.
- Hermes Agent: `NousResearch/hermes-agent@4281151ae859241351ba14d8c7682dc67ff4c126`, Desktop `0.17.0`, MIT.
- Node runtime: `24.18.0`; built-in `node:sqlite` is used directly.
