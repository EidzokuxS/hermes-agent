# Hermes Foundation Boundaries

Status: Task 1 production contract for the accepted Hermes Foundation migration plan.

## Outcome

Nox has one executable product spine: Hermes Desktop connects to one Hermes Python model/tool loop. The earlier TypeScript Nox runtime remains retained source, outside the install graph and outside every production entrypoint. This is a deliberate demotion, not a fallback route.

```text
apps/desktop renderer
  -> Electron preload / main
  -> local or configured remote Hermes backend
  -> hermes serve
  -> hermes_cli.main
  -> Hermes session + model/tool loop
  -> Hermes state.db

bounded observation only:
Hermes lifecycle -> Nox causal bridge -> append-only Nox observation Journal
```

The causal bridge points away from Hermes operational truth. It observes and correlates lifecycle facts; it is not a second chat route, model loop, transcript, constitutional reducer, or authority over a Hermes tool result.

## Production entrypoints

| Concern | Authoritative entrypoint | Contract |
| --- | --- | --- |
| Packaged Electron main | `apps/desktop/electron/main.ts` | Owns the local backend child, launch token, lifecycle, and renderer windows. |
| Electron preload | `apps/desktop/electron/preload.ts` | Exposes the bounded Desktop API; does not own operational state or launch another runtime. |
| Renderer | `apps/desktop/src/main.tsx` | Projects Hermes state and invokes the existing Hermes API. |
| Desktop build | `apps/desktop/scripts/bundle-electron-main.mjs` | Bundles exactly Electron main and preload into the packaged application. |
| Python CLI | `hermes_cli.main:main` | Installed `hermes` command and owner of the `serve` route. |
| Headless backend | `hermes_cli/subcommands/dashboard.py` | Registers `serve` on the same backend server used by Hermes clients, without opening browser UI. |

The canonical local process arguments are `hermes serve --host 127.0.0.1 --port 0`. Source and managed-install paths may express the same process as `python -m hermes_cli.main serve ...`. Older installed Hermes versions may temporarily use `dashboard --no-open`; that is a compatibility spelling for the same Hermes backend, not a custom Nox runtime.

## Truth and ownership

| Fact | Durable authority | Allowed projections / observers | Forbidden duplicate authority |
| --- | --- | --- | --- |
| Sessions, messages, model configuration, model calls, tool calls and tool results | Hermes `${HERMES_HOME}/state.db` | Desktop stores, transcript UI, logs, export/evidence readers | Nox Journal, renderer-local persistence, old Node runtime |
| Active profile, Hermes behavior and credentials | Hermes profile `config.yaml` and `.env` under `HERMES_HOME` | Desktop settings and status views | Nox identity, Journal, hidden renderer config |
| Nox | Accepted `identity/NOX.md` revision in a stable session-bound prompt tier | Profile `SOUL.md`, memory and project context are additive | Renderer-authored identity text, ad-hoc per-turn injection, unaccepted drafts |
| Nox causal provenance | `${HERMES_HOME}/nox/journal.sqlite3` | Independent audit and evidence readers | Hermes transcript rewritten as if Journal-authored |
| Nox constitutional State | Future Nox Journal snapshots/reducer contract | Read-only audit and UI projections | Hermes operational session tables or a second cortex |
| Desktop view state | Renderer stores and Electron window/config files | Rebuildable UI state | Operational or causal source of truth |

“Observed” is a semantic boundary: when Hermes produces a response or tool outcome, the bridge can record that the outcome was observed with correlation and provenance. It cannot claim the Journal caused or authored that outcome unless a later accepted runtime contract actually gives it that role.

## Data-directory ownership

- `HERMES_HOME` is the production data root. On Windows the Desktop resolves it to the explicit environment/profile selection or `%LOCALAPPDATA%\hermes`; on macOS/Linux it defaults to `~/.hermes`.
- `${HERMES_HOME}/state.db` remains the operational database for this goal.
- `${HERMES_HOME}/config.yaml`, `${HERMES_HOME}/.env`, profiles, skills, memory, sessions, logs, and managed install files retain their Hermes meanings.
- Electron user-data owns window state and Desktop connection/update preferences only.
- The retained `apps/runtime` currently accepts a separate data directory and would create `nox.sqlite`; production Desktop does not launch it and production workspaces do not install it.
- `${HERMES_HOME}/nox/journal.sqlite3` is the append-only observational Journal. It stores lifecycle identifiers, hashes, provenance, model and accepted identity references; it stores no transcript body, prompt, response, reasoning, tool payload, credential or attachment path by default.
- Branding and production data-path renames remain deferred until identity and causal seams pass their gates.

## Mechanical fence

`tests/nox/test_production_graph.py` walks all internal TypeScript imports reachable from the three Desktop entrypoints. It verifies:

- the exact root workspace set excludes retained Nox apps and packages;
- reachable Desktop source contains no displaced runtime, shadow cortex, testkit, or closed-path reference;
- Electron launches the Hermes `serve` backend through the installed CLI or `hermes_cli.main`;
- Python registers `serve` on the Hermes headless backend;
- Python production imports exactly the public `nox.identity` and `nox.causal_bridge` seams; deep bridge imports and any other Nox runtime route fail the fence;
- checked-in evidence matches the current source graph.

Negative fixtures prove the fence rejects a custom Node runtime spawn, a shadow cortex import, a testkit import, an old runtime deep import, a closed-path import, an unapproved Nox Python module and deep causal-bridge imports. The deterministic acceptance artifact is `artifacts/evidence/hermes-foundation/task1/production-graph-baseline.json`.

## Validation commands

Run from repository root on Windows:

```powershell
& .\.venv\Scripts\python.exe -m pytest tests\nox\test_production_graph.py
npm run test:desktop:platforms --workspace apps/desktop
npm run typecheck --workspace apps/desktop
```

Refresh the graph evidence only after an accepted production-boundary change:

```powershell
& .\.venv\Scripts\python.exe tests\nox\test_production_graph.py --write-baseline
```

Tasks 2–4 add only the accepted identity seam and observational Journal described above. Product renaming, broader data-path changes and retained-source deletion remain gated by later tasks and their evidence.
