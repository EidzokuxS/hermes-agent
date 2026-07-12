# Nox Repository Guide

## Authority

- Treat `NOX-CONVERGENCE.md` as the read-only conceptual source of truth.
- Treat `docs/goals/nox-first-causal-loop/PLAN.md` as the execution contract for the active foundation goal.
- Treat `packages/protocol` as the executable schema authority.
- Treat the SQLite Journal as causal and audit truth; treat snapshots, UI stores, transcripts, and model messages as projections.
- Keep `NOX-RETHINK.md` and `REFERENCE ONLY/` closed to reading, searching, editing, and implementation imports.

## Ownership

- Let `packages/runtime` validate every proposal and own every State transition.
- Let `packages/store-sqlite` persist only commands accepted by runtime.
- Keep `packages/cortex-pi` proposal-only; expose zero state-changing Pi tools.
- Keep `packages/interface-rpc` as the sole transport vocabulary.
- Keep Electron main as the socket and launch-token owner; expose only typed Nox domain methods through preload.
- Keep `apps/desktop/src/store/nox-view.ts` rebuildable from snapshot plus Journal cursor.
- Keep `apps/audit` read-only and independent from the runtime reducer and Desktop projection.
- Keep `packages/testkit` unreachable from every production entrypoint.

## Donor boundaries

- Pin Pi to commit `8479bd84743e8889f728acb21a62794102db0529` and packages `0.80.6`.
- Pin Hermes Desktop to commit `4281151ae859241351ba14d8c7682dc67ff4c126` and version `0.17.0`.
- Copy only files allowlisted in `docs/upstream/hermes-desktop-slice.json`.
- Preserve donor provenance in `THIRD_PARTY_NOTICES.md` and the allowlist manifest.
- Exclude Hermes backend, gateway, sessions, tasks, model management, tools, updates, git/worktree features, installers, and brand assets.
- Exclude Pi coding-agent, session shell, persistence, follow-up queues, and steering queues.

## Runtime invariants

- Record an external Event durably before admission.
- Flush its receipt before `EventAdmitted` and `ActStarted`.
- Keep unresolved external Events quarantined until receipt recovery completes.
- Advance State version only through an accepted State-changing Effect.
- Record rejected Effects, cancellation, failures, interruption, and explicit silence in the Journal.
- Make Continuations visible, bounded, cancellable, single-fire, and provenance-marked.
- Inject clocks and cortex ports; keep deterministic fakes in testkit.
- Store operational model inputs and outputs without hidden reasoning or credentials.

## TypeScript style

- Use strict ESM TypeScript and narrow discriminated unions at every boundary.
- Validate external and model-originated data with runtime schemas before use.
- Prefer `interface` for public object contracts and `type` for unions and mapped forms.
- Use named exports and package public entrypoints; avoid cross-package deep imports.
- Keep imports, named imports, named exports, and JSX props naturally sorted.
- Use type-only imports where applicable and remove unused imports.
- Keep route roots and composition roots thin; colocate focused actions with their owner.
- Use injected IDs, time, and ports in deterministic logic.

## Desktop style

- Follow Hermes' design rule: one source per concern, tokens over literals, flat over boxed.
- Reuse one primitive per concern; keep variants and sizing inside primitives.
- Use CSS variables for color, stroke, shadow, and theme values.
- Use whitespace and one hairline for grouping; avoid nested cards and gratuitous dividers.
- Keep functional motion short and respect `prefers-reduced-motion`.
- Keep user-visible strings in the Nox-owned localization boundary once that boundary exists.

## Commands

- Use Node `24.18.0` from `.node-version`.
- Install with `npm ci` after `package-lock.json` exists.
- Run `npm run node:check`, `npm run lint`, `npm run typecheck`, and `npm run test` for the baseline gate.
- Run focused workspace scripts before root-wide validation.
- Run `npm run test:foundation` for deterministic continuity.
- Run `npm run check:kill-criteria` before any completion claim.
- Capture target-perspective proof with `npm run evidence:first-loop` and verify it with `npm run verify:first-loop`.

## Change discipline

- Preserve unrelated and pre-existing work.
- Keep root manifests and `package-lock.json` fixed after Task 0 unless the accepted plan is revised.
- Update `tasks/todo.md` after each task gate.
- Record deviations from the accepted plan before implementing them.
- Call the result `implemented but unproven` whenever required evidence is missing.
