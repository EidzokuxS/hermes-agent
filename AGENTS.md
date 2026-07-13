# Nox on Hermes Repository Guide

## Authority

- Treat `docs/goals/nox-hermes-foundation-migration/PLAN.md` and its accepted SHA-256 as the active execution contract.
- Treat `NOX-CONVERGENCE.md` as read-only conceptual truth.
- Do not read, search, edit, import, or derive implementation from `NOX-RETHINK.md` or `REFERENCE ONLY/**`.
- Do not integrate Nox until the user separately accepts the exact revision hash of `identity/NOX.md`.
- Treat the pinned full Hermes Agent tree as the product foundation, not as a donor slice.

## Production ownership

- Keep one production Desktop: `apps/desktop`.
- Keep one production model/tool loop: the Hermes Python backend reached through `hermes serve` / `hermes_cli.main serve`.
- Keep Hermes `state.db` authoritative for operational sessions, messages, model calls, tool calls, tool results, configuration, and loop state.
- Let the Nox Journal own only Nox causal/provenance records and constitutional State. Record Hermes outcomes as observed, never as authored by the Journal.
- Treat Desktop stores, transcripts, snapshots, and evidence as projections rather than competing truth stores.
- Keep Electron main as the local-backend process owner. Renderer and preload must use typed Hermes surfaces; they must not spawn a second runtime.
- Keep `apps/runtime`, `apps/audit`, and `packages/{cortex-pi,interface-rpc,protocol,runtime,store-sqlite,testkit}` outside production workspaces and entrypoint graphs until the accepted plan explicitly transfers a bounded responsibility.
- Keep `packages/testkit` unreachable from production entrypoints.

## Hermes invariants

- Preserve the Hermes agent, gateway, session, tool, memory, provider, updater, installer, and Desktop feature baseline unless a documented Nox invariant requires a bounded change.
- Preserve prompt-cache stability: keep the cacheable system prefix byte-stable within a conversation and put volatile context after stable prompt tiers.
- Keep canonical Nox identity in a stable, versioned prompt tier. Treat profile `SOUL.md`, memory, skills, and project context as additive layers.
- Keep model proposals separate from harness authorization, execution, persistence, and observation.
- Give every tool call a structured result, including denial, timeout, cancellation, and failure.
- Keep behavior and secrets separate: `config.yaml` owns behavior; `.env` owns credentials.
- Preserve strict message alternation and do not synthesize user messages inside the model/tool loop.

## TypeScript and Desktop style

- Follow Hermes conventions already present in the touched module before adding a new abstraction.
- Use nanostores for shared renderer state and keep atoms near their owning feature.
- Keep route roots and composition roots thin; colocate focused hooks and actions with their owner.
- Prefer `interface` for public object props, type-only imports where applicable, named exports, and `void` event handlers.
- Keep imports, exports, and JSX props naturally sorted.
- Use one primitive per concern, tokens over literals, and flat grouping over nested cards.
- Use CSS variables for theme values, short functional motion, and `prefers-reduced-motion` support.
- Keep user-visible strings in the existing Hermes localization boundary until the accepted Nox product layer deliberately changes it.

## Tests and evidence

- Prefer behavior-contract tests over source snapshots or broad change detectors.
- Use temporary `HERMES_HOME` values for tests; never write into the user's real profile.
- Run the production fence with `.venv\Scripts\python.exe -m pytest tests\nox\test_production_graph.py` on Windows.
- Run Desktop platform tests with `npm run test:desktop:platforms --workspace apps/desktop`.
- Run Desktop typecheck with `npm run typecheck --workspace apps/desktop`.
- Use `scripts/run_tests_parallel.py` for the full Python denominator; on Windows follow the native UTF-8 invocation recorded in `docs/upstream/HERMES-BASELINE.md`.
- Capture packaged target-perspective evidence for acceptance claims. Say `implemented but unproven` whenever required Nox identity, restart-correlation, parity, or displaced-path evidence is absent.
- Keep `artifacts/evidence/hermes-foundation/task1/production-graph-baseline.json` synchronized through `tests/nox/test_production_graph.py --write-baseline` when an accepted production-graph change occurs.

## Change discipline

- Preserve unrelated and pre-existing work.
- Keep the pinned donor provenance, root dependency manifests, and lockfiles unchanged unless the accepted plan requires a recorded deviation.
- Record deviations before implementing them and update `tasks/todo.md` after each task gate.
- Do not retain compatibility routes to the displaced custom Desktop/runtime without a verified contract.
- At cutover, delete or explicitly demote displaced production paths; source retention alone must never imply production reachability.
