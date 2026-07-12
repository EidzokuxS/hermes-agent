# Переезд Nox на Hermes Foundation — Implementation Plan

**Intent:** Сделать полный Hermes Agent `0.17.0` рабочим фундаментом Nox: сохранить его зрелый Desktop, chat/session loop, gateway, инструменты, skills, memory, провайдеры и эксплуатационную обвязку; поверх штатных точек расширения встроить каноничную личность Nox, Nox-owned причинный контур и продуктовую идентичность. Это смена основания, а не очередной перенос UI-компонентов.

**Current Behavior:** Репозиторий Nox содержит доказанную первую причинную петлю на собственном TypeScript runtime и небольшой Hermes-derived Desktop slice. Активный `apps/desktop` — самописная оболочка, а `docs/upstream/hermes-desktop-slice.json` намеренно исключает Hermes agent, gateway, sessions, memory, tools и почти весь Desktop. Поэтому сильные стороны Hermes находятся вне production graph, а дальнейшее воспроизведение его GUI и UX внутри текущей оболочки экономически и архитектурно бессмысленно.

**Expected Outcome:** Пользователь запускает Nox Desktop, который является адаптированным полным Hermes Desktop и работает через родной Hermes agent/gateway. Он ведёт обычный разговор, использует streaming, tools, skills, memory, attachments, interrupts и session resume без урезанного параллельного интерфейса. Каждый новый сеанс получает утверждённую каноничную маску Nox через стабильный identity tier. Nox Journal наблюдает и связывает внешний запрос, запуск turn и терминальный результат, не выдавая зеркало Hermes session DB за собственную State authority. Старый самописный Desktop и его отдельный runtime-launch path после cutover недостижимы из production.

**Target-Perspective Output:** Эйдзи видит аккуратный Hermes-class chat UX под именем Nox, получает узнаваемое поведение Nox в контрольных беседах, может пользоваться штатными возможностями Hermes и после принудительного закрытия приложения продолжает сохранённую сессию. В диагностическом режиме он открывает связанную причинную трассу Nox для тех же turn IDs и видит, где заканчивается факт Hermes и начинается собственное решение Nox.

**Truth Owner:** `NOX-CONVERGENCE.md` остаётся read-only смысловым owner. Утверждаемый `identity/NOX-MASK.md` владеет внешней поведенческой маской до обучения кортекса. Hermes `state.db` и gateway runtime владеют операционными session/message/tool facts. SQLite Journal Nox владеет только записанными им Nox Event/Act/provenance records и constitutional State; он не дублирует transcript и не объявляет Hermes message history своей State. `docs/upstream/hermes-foundation.json` владеет provenance и классификацией каждого upstream path.

**Contract Boundary:** Desktop продолжает говорить с `tui_gateway` родным Hermes JSON-RPC (`prompt.submit`, stream/status/tool events, `message.complete`). Новый узкий `nox/causal_bridge` получает типизированные lifecycle callbacks на серверной стороне: `external_event_recorded`, `turn_started`, `turn_terminal`, `session_resumed`. External/queued-external correlation создаётся на RPC admission и переносится в единый `_run_prompt_submit` seam; internal goal/background follow-ups получают отдельную provenance category и не притворяются внешним Event. Bridge может записывать Journal и корреляцию, но не меняет prompt, model output, tool execution или Hermes persistence. Identity собирается в `agent/system_prompt.py` как byte-stable Nox identity block перед Hermes operational guidance; изменяемый `SOUL.md` становится дополнительным profile layer, а не владельцем имени Nox.

**Cutover:** Работа идёт в отдельном migration worktree/branch от доказанного Nox checkpoint. В него целиком материализуется pinned Hermes tree `4281151ae859241351ba14d8c7682dc67ff4c126`; Hermes root manifests, Python core, `tui_gateway` и `apps/desktop` становятся базовой production-системой. Сначала доказывается неизменённый upstream baseline, затем по одному вводятся mask, causal bridge и branding. Финальный cutover удаляет текущий custom Desktop/runtime launch из production graph только после Hermes parity, mask eval, restart и causal-correlation gates. Текущая ветка остаётся rollback point до принятия evidence bundle.

**Displaced Path:** После cutover не существует второго Nox chat UI, второго composer/session store, отдельного Electron→Node runtime маршрута и политики «Hermes только allowlisted UI donor». `apps/desktop` полностью принадлежит Hermes foundation с Nox adaptations. TypeScript first-loop runtime сохраняется как проверенный исследовательский модуль и источник протокольных инвариантов, но его Pi Cortex и JSON-RPC не обслуживают production chat, пока отдельный последующий план не передаст им конкретную authority.

**Value Density:** Первый пользовательский рубеж одновременно снимает главную стоимость самописного GUI, даёт зрелый harness и создаёт правильное место для маски Nox. Причинный bridge добавляется только после сохранения Hermes baseline и только на существующие lifecycle seams; он даёт наблюдаемость для следующих экспериментов без преждевременной переписи agent core.

**Acceptance Evidence:** Один versioned bundle содержит upstream tree/provenance report, команды baseline и final gates, mask corpus и результаты eval, system-prompt snapshot/hash, Desktop screenshots на трёх размерах, streaming/tool/interrupt/resume traces, forced-restart report, Hermes↔Nox correlation trace, independent Journal audit, production import/entrypoint graph, displaced-path report и redaction report.

**Evidence Lane:** `python scripts/nox_evidence.py capture --lane hermes-foundation --run-id <id>` запускает Python и Desktop gates, собирает артефакты в `artifacts/evidence/hermes-foundation/<id>/`; `python scripts/nox_evidence.py verify --bundle <path>` проверяет hashes, версии, correlation invariants, отсутствие секретов и требуемые screenshots/traces offline.

**Kill Criteria:** План останавливается и требует пересмотра, если полный Hermes baseline нельзя поднять на поддерживаемом Windows окружении; если для маски требуется per-turn динамическая перестройка system prompt; если causal bridge становится вторым session store, блокирует/меняет Hermes turn либо теряет terminal correlation после restart; если final production graph всё ещё содержит custom Nox Desktop или Electron→`apps/runtime`; если upstream parity существенно деградирует; если branding требует массового semantic rename до работающего baseline; если canonical mask неотличима от generic assistant по утверждённому eval.

**Non-goals:** Обучение собственного кортекса; доказательство сознания; полная реализация автономного непрерывного процесса; немедленная передача всех Hermes tools/memory/sessions под Nox runtime authority; переписывание Hermes на TypeScript; удаление функций только потому, что они «не похожи на Nox»; автоматический upstream-sync bot; окончательная система долгосрочной памяти; экономика compute; полное causal-покрытие Telegram/Discord и прочих не-Desktop gateway adapters на этом рубеже.

**Risk if wrong:** Получится Hermes с другим логотипом и театральным system prompt, либо две конфликтующие системы истины. Слишком ранний rename разорвёт upstream и усложнит диагностику. Слишком глубокий causal hook изменит надёжный turn loop. Слишком слабая маска будет каждый раз растворяться в RLHF-поведении модели. Слишком сильная маска начнёт притворяться человеческими эмоциями вместо каноничной цифровой личности Nox.

## Зафиксированные решения

1. **Hermes — foundation, не donor slice.** Импортируется весь pinned source tree, а исключения перечисляются явно. Сначала сохраняется работающий Hermes, затем меняются только Nox-owned seams.
2. **Один production chat path.** После cutover Desktop, gateway, session lifecycle и model/tool loop — Hermes. Текущий Nox Desktop и Node process host не остаются fallback-маршрутом.
3. **Маска предшествует кортексу.** `identity/NOX-MASK.md` — проверяемая внешняя спецификация поведения. Она нужна для экспериментов и будущего training corpus, но не объявляется внутренней природой модели.
4. **Идентичность не равна пользовательскому SOUL.** Каноничный Nox block неизменяем и версионирован. `SOUL.md`, MEMORY/USER и project context остаются дополнительными слоями, которые не могут переименовать или отменить Nox.
5. **Prompt cache сохраняется.** Identity входит в stable tier и snapshot-ится на сессию. Новая версия маски применяется только к новой сессии или явной миграции, а не незаметно посреди разговора.
6. **Hermes State остаётся операционной истиной.** На этом рубеже Nox не копирует transcript, tool results, memory или session metadata в собственную State. Journal хранит causal envelopes, hashes/refs и собственные решения.
7. **Bridge сначала наблюдает.** Causal bridge не имеет права отклонить запрос, заменить response или применить Effect. Передача authority Nox runtime — отдельный последующий outcome contract после измерения реального Hermes loop.
8. **Ребрендинг последний среди поведенческих изменений.** Сначала green upstream baseline и mask eval, затем видимое имя, data paths и assets. Внутренние protocol identifiers Hermes переименовываются только там, где они видны пользователю или создают product/data collision.
9. **Существующая causal loop не выбрасывается.** Её протокол, Journal и audit код переносятся в новый foundation и остаются independently testable, но не запускают второй cortex в production.
10. **Текущий план supersedes donor boundary только после принятия.** До принятия hash этого PLAN действуют ограничения первого causal-loop plan и `hermes-desktop-slice.json`.

## Architecture map

### Источники и ветка

| Source | Pin / owner | Роль |
|---|---|---|
| Текущий Nox | clean commit на момент принятия | rollback checkpoint, канон, causal packages, audit evidence |
| Hermes Agent | `4281151ae859241351ba14d8c7682dc67ff4c126` / Desktop `0.17.0` | полный foundation tree |
| Pi | текущий Hermes dependency set | используется только через Hermes; текущий `@nox/cortex-pi` не входит в production chat |
| `NOX-CONVERGENCE.md` | Nox | read-only концептуальные инварианты |
| `identity/NOX-MASK.md` | Nox, отдельное принятие Эйдзи | внешняя каноничная маска |

Migration worktree создаётся рядом с текущим checkout. Proven Nox commit получает annotated rollback tag. Ветка миграции сохраняет Nox history и материализует Hermes tree поверх него по manifest-классам `upstream`, `adapted`, `retained-nox`, `removed-after-cutover`. Никакой `reset --hard` текущего checkout не используется. Node фиксируется на уже доказанном `24.18.0`, который удовлетворяет Hermes Desktop `>=22.12.0`; Python фиксируется через pinned Hermes `uv.lock` и его `requires-python`.

### Files and layers to create

```text
identity/NOX-MASK.md
identity/evals/{cases.yaml,rubric.md,negative-cases.yaml}
nox/__init__.py
nox/identity.py
nox/causal_bridge/{__init__.py,events.py,bridge.py,sqlite_sink.py}
nox/causal_bridge/tests/{test_bridge.py,test_restart_correlation.py,test_redaction.py}
docs/upstream/hermes-foundation.json
docs/upstream/HERMES-BASELINE.md
docs/architecture/hermes-foundation-boundaries.md
docs/goals/nox-hermes-foundation-migration/EVIDENCE.md
scripts/nox_identity_eval.py
scripts/nox_evidence.py
tests/nox/test_identity_prompt.py
tests/nox/test_gateway_causal_hooks.py
tests/nox/test_production_graph.py
```

### Hermes files to retain as authority

- Root Python product/runtime: `run_agent.py`, `model_tools.py`, `toolsets.py`, `hermes_state.py`, `agent/**`, `hermes_cli/**`, `tui_gateway/**`, `tools/**`, `skills/**`, `gateway/**`, `providers/**`, `plugins/**`, `cron/**` and their tests/configuration.
- Full Desktop: `apps/desktop/electron/**`, `apps/desktop/src/**`, `apps/desktop/scripts/**`, its tests, build and packaging files.
- Root build/release sources: `pyproject.toml`, `uv.lock`, `package.json`, `package-lock.json`, installer/bootstrap sources and shared apps/packages required by the pinned tree.

These paths are imported from the exact pinned commit before adaptation. `docs/upstream/hermes-foundation.json` records upstream blob/tree SHA and later Nox modifications; absence from a small allowlist is no longer a deletion signal.

### Files to modify at known seams

- `agent/system_prompt.py`: prepend the stable, versioned Nox identity block; keep Hermes operational/tool guidance and prompt-cache ordering.
- `hermes_cli/config.py` and profile initialization: seed Nox product identity separately from optional `SOUL.md`; retain customized user/profile files.
- `tui_gateway/server.py`: call the injected causal bridge at `prompt.submit` durable admission, immediately before `agent.run_conversation`, on `message.complete`/error/interruption and on resume. Hooks are bounded, exception-contained and typed.
- `apps/desktop/src/components/brand-mark.tsx`, user-visible i18n catalog entries, `apps/desktop/index.html`, Electron packaging metadata and product assets: change public identity after behavior gates.
- `apps/desktop/electron/backend-command.ts`, `backend-env.ts`, connection/bootstrap configuration: use Nox product home and executable names while retaining Hermes launch semantics.
- Root `package.json`, `pyproject.toml`, installer and packaging metadata: change distribution/product identity only after dependency and updater impact is enumerated in manifest.
- `AGENTS.md`: merge Hermes repository commands/style with Nox authority, closed-path and causal-boundary rules; nearer upstream guides remain in force for their paths.
- Existing `packages/{protocol,runtime,store-sqlite,interface-rpc,cortex-pi,testkit}`, `apps/{runtime,audit}`, `tests/{integration,live}`: retain and relocate/configure only as necessary to coexist with Hermes root tooling. They remain testable but are excluded from production Desktop entrypoint graph.

### Files and layers to avoid

- `NOX-RETHINK.md` and `REFERENCE ONLY/**` remain closed to reading, searching, editing and imports.
- `NOX-CONVERGENCE.md` remains unmodified in this goal.
- Do not edit provider adapters, tool implementations, memory algorithms, gateway platform adapters, session schema or Desktop feature code unless a failing parity test proves the migration requires it.
- Do not preserve the current `apps/desktop` implementation under another production path.
- Do not add a second transcript, a second model call, a hidden retry, a generic agent task loop or a dynamic per-turn persona prompt.
- Do not globally rename Python modules, RPC methods or database columns from `hermes` to `nox` in this goal.

## Read and write paths

### Active chat path after cutover

1. Nox Desktop creates/resumes a Hermes-backed session through existing Desktop gateway code.
2. Renderer sends `prompt.submit`; `tui_gateway` durably establishes/locates the Hermes session row using its existing lifecycle.
3. После успешной RPC-валидации и до успешного admission response `nox.causal_bridge.external_event_recorded(...)` best-effort записывает bounded envelope с correlation IDs и content hash/ref policy. Если observational sink недоступен, Hermes turn остаётся допустимым, но UI diagnostics и evidence отмечают causal coverage gap; такой run не может пройти acceptance.
4. Hermes constructs one AIAgent. `agent/system_prompt.py` assembles stable Nox identity, optional profile SOUL, Hermes operational guidance, context and memory, then stores the prompt snapshot for the session.
5. Immediately before `run_conversation`, bridge records `turn_started` with session, turn, model and identity revision refs.
6. Hermes performs its normal model/tool loop and streams its normal events. No Nox shadow cortex runs.
7. `message.complete`, interruption or error generates exactly one `turn_terminal` record. The UI consumes the original Hermes event.
8. При restart/resume bridge восстанавливает только unresolved correlation state из своего Journal и сверяет его с Hermes session facts; started turn из умершего process epoch получает явный `interrupted-by-process-loss` terminal record. Bridge никогда не реконструирует transcript.

### Identity path

`identity/NOX-MASK.md` is compiled/validated by `nox.identity` into a deterministic block carrying `identity_id`, revision hash and mask text. The block is stable within a session. `SOUL.md` can add preferences or acquired character, but the assembler rejects an absent/ambiguous canonical identity block in Nox product mode. Eval captures both the assembled prompt hash and black-box dialogue behavior; it never stores hidden reasoning.

### Causal ownership ratchet

This plan deliberately ends with an observational bridge. A later plan may transfer one boundary at a time from Hermes to Nox only if it names the displaced Hermes owner and supplies parity evidence. Candidate order: admission receipt → attention/turn scheduling → continuation → effect validation → durable State. Until such a transfer is accepted, Hermes remains operational owner and the bridge must label its records `observed`, not `authored`.

## Migration tasks

### Task 0 — Safe foundation import and immutable baseline

**Files:** `docs/upstream/hermes-foundation.json`, `docs/upstream/HERMES-BASELINE.md`, `THIRD_PARTY_NOTICES.md`, root imported Hermes tree, migration worktree metadata; no Nox behavior changes.

**Scope:** Record the clean Nox checkpoint and rollback tag; fetch exact Hermes pin; create a separate migration worktree; materialize the complete pinned tree. Classify every collision as `upstream`, `adapted-later`, `retained-nox` or `removed-after-cutover`. At the colliding `apps/desktop` path, the pinned Hermes tree replaces the custom Desktop immediately in the migration branch; the displaced implementation remains recoverable from the rollback commit and is not copied into a legacy production directory. Replace root npm/Python manifests with Hermes authority while registering retained Nox workspaces without dependency upgrades. Capture license and tree hashes. Do not brand, remove the remaining Node causal-loop modules or add Nox hooks yet.

**Output:** A branch in which the complete upstream foundation and retained Nox artifacts coexist, with a machine-readable provenance map and zero ambiguous collisions.

**Verification:** Exact upstream tree/path hash report; `uv sync --locked`; `npm ci`; upstream Python tests selected by Hermes AGENTS; `npm run test:desktop:platforms --workspace hermes`, `npm run test:ui --workspace hermes`, `npm run typecheck --workspace hermes`, `npm run build --workspace hermes`; retained Nox baseline tests invoked through an isolated script. Task 0 records the exact test denominator instead of using an undefined “all tests” claim.

**Acceptance evidence:** `HERMES-BASELINE.md` records commands, versions, exit codes, expected upstream failures and screenshots. Rollback checkout launches the prior Nox unchanged.

**Depends on:** Explicit acceptance of this PLAN hash.

**Parallelism:** Sequential. Owns all shared manifests and the initial tree; no other task starts before it passes.

### Task 1 — Repository contracts and production graph fence

**Files:** root `AGENTS.md`, relevant nested `AGENTS.md`, `docs/architecture/hermes-foundation-boundaries.md`, `tests/nox/test_production_graph.py`, root test scripts/configuration.

**Scope:** Merge Hermes code style/commands with Nox authority rules. Declare production entrypoints and build an import/process graph check proving Desktop→Hermes backend is the only chat route, current Node runtime is not spawned by Electron, testkit is unreachable, and closed paths are absent. Define operational-vs-causal truth table and data-directory ownership.

**Output:** Enforceable foundation boundaries before semantic adaptations.

**Verification:** Graph test fails on fixtures that reintroduce custom Desktop/runtime or shadow cortex; root Python/Desktop/Nox focused test commands all run without manifest ambiguity.

**Acceptance evidence:** `production-graph-baseline.json` and boundary document reviewed against actual imports/process launches.

**Depends on:** Task 0.

**Parallelism:** Sequential because later tasks rely on these fences.

### Task 2 — Canonical Nox mask contract

**Files:** `identity/NOX-MASK.md`, `identity/evals/cases.yaml`, `identity/evals/negative-cases.yaml`, `identity/evals/rubric.md`, `scripts/nox_identity_eval.py`.

**Scope:** Distil the canonical personality supplied/approved by Эйдзи into observable behavior: voice, self-identification, epistemic posture, relation to requests, independence without refusal theatre, treatment of uncertainty, boundaries against fake emotion/human mimicry and invariants across models. Define positive dialogues and adversarial cases. This task authors no runtime code and does not consult closed files.

**Output:** A versioned mask and model-agnostic black-box eval contract suitable for prompt iteration now and cortex training later.

**Verification:** Schema/lint for eval corpus; blind expected-behavior review; baseline run against unmodified Hermes establishes a comparison rather than a pass. Default proposed pass line is: 100% hard invariants and negative cases; at least 90% core behavioral cases; median at least 4/5 on voice/self-definition/epistemic-posture dimensions; no case may pass solely because the model refused to engage. Эйдзи may change the threshold only while accepting the same versioned rubric.

**Acceptance evidence:** Эйдзи explicitly accepts mask revision hash and rubric. Without this acceptance, Task 3 remains blocked and generic placeholder prose is forbidden.

**Depends on:** Task 1 and canonical personality input/approval from Эйдзи.

**Parallelism:** Can prepare corpus structure alongside Task 1, but mask content and hash are sequential approval gates.

### Task 3 — Stable identity integration

**Files:** `nox/__init__.py`, `nox/identity.py`, `agent/system_prompt.py`, `hermes_cli/config.py`, `tests/nox/test_identity_prompt.py` and focused upstream prompt/config tests.

**Scope:** Load the accepted mask as an immutable Nox identity layer. Preserve Hermes tool/skill/platform guidance, context tiers, memory and prompt-cache order. Retain `SOUL.md` as additive profile character. Persist identity revision with the session prompt snapshot. Existing sessions retain their recorded prompt; new mask revisions do not mutate them silently.

**Output:** Every new Nox session uses one deterministic identity block and still behaves as a full Hermes agent.

**Verification:** Prompt snapshots across turns are byte-identical; compression/resume retains the same identity revision; profile SOUL cannot remove product identity; prompt-cache tests pass; mask eval meets the accepted threshold on the configured primary model and at least one contrasting model when credentials allow.

**Acceptance evidence:** Prompt-part report with hashes and no secrets; eval result with case-level scores and regression comparison.

**Depends on:** Accepted Task 2 hash.

**Parallelism:** Sequential semantic change.

### Task 4 — Nox causal bridge at Hermes lifecycle seams

**Files:** `nox/causal_bridge/{__init__.py,events.py,bridge.py,sqlite_sink.py}`, `tui_gateway/server.py`, `nox/causal_bridge/tests/*`, `tests/nox/test_gateway_causal_hooks.py`; retained `packages/protocol`/`packages/store-sqlite` only if an explicit adapter is needed.

**Scope:** Introduce typed, injected callbacks around accepted prompt admission, the single `_run_prompt_submit` runner, terminal complete/error/interruption and resume. Assign one bridge correlation object at external RPC admission; carry it through busy-queue/retry paths; classify goal/background synthesis separately. Store monotonic observed lifecycle records with Hermes session/turn IDs, process epoch, content hashes, model/identity refs and terminal status. Make hook failure visible in diagnostics but exception-contained so it cannot corrupt Hermes session state. Reconcile an in-flight turn after forced restart. Do not instrument generic `_emit`, store transcript bodies by default or call a second model.

**Output:** Independent causal/audit trace for the production Hermes turn without claiming decision authority.

**Verification:** Unit state machine; duplicate/retry idempotency; queued external prompt and internal follow-up provenance tests; crash matrix at admission/start/terminal boundaries; forced process restart; redaction tests; standard Hermes prompt/stream/interrupt tests unchanged; latency budget measured. Default budget: p95 bridge write overhead below 10 ms on the local evidence machine and zero added provider/model calls; a different budget requires a recorded plan deviation.

**Acceptance evidence:** Correlation trace proves one admitted external event, one started turn and one terminal outcome for normal, error, interrupt and resumed cases; independent audit matches Hermes IDs/status without importing Hermes reducer/session code.

**Depends on:** Tasks 1 and 3.

**Parallelism:** Implementation is sequential around `tui_gateway/server.py`; tests and sink can be prepared in parallel only with disjoint files.

### Task 5 — Product identity, data paths and Desktop adaptation

**Files:** `apps/desktop/src/components/brand-mark.tsx`, user-visible `apps/desktop/src/i18n/*`, `apps/desktop/index.html`, `apps/desktop/assets/*`, `apps/desktop/public/*`, Electron packaging metadata, `apps/desktop/electron/{backend-command,backend-env,connection-config}.ts`, root packaging/install metadata and provenance manifest.

**Scope:** Change visible product name, iconography, copy, executable/app IDs and new-install data home to Nox while retaining Hermes UX and layout. Define an explicit one-time import or side-by-side policy for existing Hermes profiles; never silently move/delete user data. Keep internal RPC/module names where renaming adds no user value. Replace brand assets with Nox-owned assets and update notices.

**Output:** A Nox-branded application whose behavior and UX remain recognizably Hermes-quality.

**Verification:** Desktop unit/build/package tests; clean-install and existing-Hermes-profile matrix; Windows launch/relaunch/uninstall/update dry-run; visual QA at 1440×900, 900×700 and narrow supported width; keyboard, focus, scrolling, streaming and reduced-motion checks.

**Acceptance evidence:** Screenshot set and visual QA report; data migration matrix with before/after paths and rollback; provenance report contains no Hermes brand asset shipped as Nox.

**Depends on:** Tasks 3 and 4.

**Parallelism:** Desktop visuals and packaging can proceed in disjoint files after semantics are stable; final integration is sequential.

### Task 6 — Legacy cutover and deletion

**Files:** `apps/runtime/**`, `packages/interface-rpc/**`, obsolete custom-Desktop tests/scripts classified by Task 0 outside the replaced `apps/desktop` path, `docs/upstream/hermes-desktop-slice.json`, root scripts/manifests, `tests/nox/test_production_graph.py`, retained historical docs.

**Scope:** Confirm that Task 0 replaced the former custom Desktop rather than nesting it under the Hermes app, and remove any obsolete custom-Desktop support files that survived outside that collision. Disable every remaining launch/reference to the Node Nox runtime and delete obsolete runtime-specific UI/RPC wiring. Demote `hermes-desktop-slice.json` to a historical manifest with a superseded marker. Keep causal-loop packages/apps only in a clearly named research/test lane if their tests still carry value; otherwise archive through a separately recorded deletion list. Update commands so default dev/build/package launch exactly one foundation.

**Output:** One production Desktop, one model/tool loop and one packaging path.

**Verification:** Production graph and repository search find zero reachable custom composer, `nox-runtime-process`, Nox JSON-RPC chat client or second cortex. Clean install/build/package and all retained tests pass.

**Acceptance evidence:** Displaced-path report enumerates deleted/demoted files and demonstrates failure if any old entrypoint is restored.

**Depends on:** Tasks 4 and 5, full parity gate green.

**Parallelism:** Sequential destructive cutover; requires a clean checkpoint and explicit task gate.

### Task 7 — Target-perspective acceptance and release decision

**Files:** `scripts/nox_evidence.py`, `docs/goals/nox-hermes-foundation-migration/EVIDENCE.md`, `artifacts/evidence/hermes-foundation/<run-id>/**`, `tasks/todo.md`.

**Scope:** Exercise new conversation, multi-turn mask behavior, one tool call, skill use, attachment, interrupt, session resume, forced Desktop/backend termination and causal audit. Capture clean source state, exact versions, latency and visual proof. Run offline verifier, dependency/security scans and PRE/POST/correctness/maintainability reviews. Compare against Task 0 upstream baseline and record intentional deltas.

**Output:** A release/rollback decision backed by one self-contained evidence bundle.

**Verification:** Locked Python/npm installs; root lint/type/test; Desktop build/package/smoke; identity eval; causal restart suite; production graph; evidence capture then offline verification; secret scan.

**Acceptance evidence:** All required artifacts exist and verify. Эйдзи can complete the target journey in packaged Desktop. Any missing mask acceptance, forced-restart correlation, packaged GUI proof or displaced-path proof leaves status `implemented but unproven` and prevents default-branch cutover.

**Depends on:** Tasks 0–6.

**Parallelism:** Final sequential gate.

## Dependency graph

```text
Task 0 -> Task 1
Task 1 -> Task 2 structure, Task 4 design
Task 2 accepted -> Task 3
Task 3 + Task 1 -> Task 4
Task 3 + Task 4 -> Task 5
Task 4 + Task 5 + parity -> Task 6
Task 0..6 -> Task 7
```

No default-branch cutover occurs before Task 7. Task 6 is the only destructive phase and starts only from a clean checkpoint after evidence shows the Hermes foundation already covers the user journey.

## Evidence bundle contract

```text
artifacts/evidence/hermes-foundation/<run-id>/
  manifest.json
  versions.json
  commands.log
  upstream/
    tree-report.json
    collision-map.json
    parity-report.json
  identity/
    mask-revision.json
    prompt-parts.json
    eval-results.json
  desktop/
    empty-1440x900.png
    conversation-1440x900.png
    conversation-900x700.png
    tool-and-skill.png
    resumed-after-restart.png
    visual-qa.json
  runtime/
    gateway-trace.json
    streaming-trace.json
    interrupt-trace.json
    restart-report.json
    causal-correlation.json
    nox-journal.sqlite
  reviews/
    production-graph.json
    displaced-paths.json
    redaction.json
    dependency-security.json
    pre-plan-review.md
    post-plan-review.md
    correctness-review.md
    maintainability-review.md
```

`manifest.json` records SHA-256, source commits, lockfile hashes, OS/runtime versions, commands and exit codes. Captured prompts contain only assembled non-secret instruction text approved for evidence; user content and provider artifacts follow explicit redaction rules. Hidden reasoning and credentials never enter the bundle.

## Acceptance thresholds

- Upstream baseline and final foundation launch/build/package on Windows with no undocumented manual patch.
- Existing Hermes Desktop critical flows used by Nox have no regression classified major or blocker.
- Mask eval has 100% hard invariants/negative cases, at least 90% core cases and median ≥4/5 for voice/self-definition/epistemic posture, unless the accepted versioned rubric records a stricter or explicitly revised threshold; it has zero violations for fake humanity, fake emotion, servile-assistant framing and theatrical refusal/autonomy.
- System prompt is stable across ordinary turns and resume; identity revision is explicit.
- Normal, error, interrupt and forced-restart turn traces have complete, idempotent Hermes↔Nox correlation.
- Causal bridge adds no second model call and stays within the accepted latency budget established in Task 1.
- Packaged Desktop has one production chat route; old custom Desktop/runtime path has zero reachable files.
- Evidence verifier and secret scan pass on a clean source commit.

## Source pins and permissions

- Canon: `NOX-CONVERGENCE.md` — read-only.
- Proven predecessor: `docs/goals/nox-first-causal-loop/PLAN.md` and its accepted evidence — historical, not rewritten.
- Hermes Agent: `NousResearch/hermes-agent@4281151ae859241351ba14d8c7682dc67ff4c126`, Desktop `0.17.0`, MIT.
- Current donor manifest: `docs/upstream/hermes-desktop-slice.json` remains active until this plan is accepted, then becomes historical at Task 6.
- Closed: `NOX-RETHINK.md`, `REFERENCE ONLY/**`.
- External writes, release publication, destructive changes outside the migration worktree and default-branch cutover require explicit permission. Local implementation, tests and evidence capture inside the accepted migration branch are authorized task by task.
