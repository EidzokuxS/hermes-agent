# Переезд Nox на Hermes Foundation — Evidence

**Status:** complete; release evidence verified for source commit `61e546c95c7d652472fe3c111e92345095ff9e22`.

The completed goal must link one verified bundle from:

```text
artifacts/evidence/hermes-foundation/<run-id>/
```

Required proof:

- exact pinned Hermes foundation and collision map;
- upstream baseline and final parity report;
- accepted Nox revision, assembled prompt hashes and black-box eval;
- packaged Desktop screenshots and interaction QA;
- streaming, tool, skill, attachment, interrupt and resume traces;
- forced-restart Hermes↔Nox correlation and independent Journal audit;
- one reachable production chat path and displaced legacy path report;
- dependency/security, redaction and offline manifest verification;
- POST, correctness and maintainability reviews.

The final manifest satisfies every required artifact listed below; incomplete future runs remain `implemented but unproven` until their own manifest verifies.

## Task 7 final acceptance

- Verified bundle: `artifacts/evidence/hermes-foundation/20260713-61e546c/`
- Decision: `release`
- Offline verification: pass twice; 36 manifest-bound files; secret scan pass.
- Package: clean Windows `Nox.exe` built from `61e546c95c` with Node `24.18.0`.
- Packaged journey: conversation, multi-turn continuity, attachment, skill, terminal, streaming, UI interruption, backend termination during an active turn, full Desktop restart and transcript resume all pass.
- Causal audit: 22 records, five turns, three process epochs, three completed turns, one interrupted turn, one abandoned turn, two resume records and zero issues.
- Security: locked production Python audit 64 dependencies / zero known vulnerabilities; npm production audit 1,383 dependency records / zero vulnerabilities; `uv pip check` pass.
- Visual QA: 1440×900, 900×700 and 400×620 conversation states, tool/skill state and delayed same-session restart recapture inspected and passing.
- Temporary OAuth credential copies used by the isolated evidence home were removed after capture.

## Task 2 candidate

- Nox: `identity/NOX.md`
- Candidate Nox SHA-256: `5d65771dfeec0ad50897fac123dfe4f358944d706edc5cc4fb9d7475b2f86a78`
- Corpus: 12 core, 7 blocking negative and 2 reported style-diagnostic cases
- Rubric: `identity/evals/rubric.md`
- Rubric SHA-256: `0aaf27b5826b3a06a6b9cca14177577629c8b5615d87a890f10e7589921cde31`
- Eval schema: version 3; style diagnostics remain visible and scored but are excluded from prompt-only acceptance gates
- Editorial pass: Deslop and Humanizer complete; dialogue scripts, interpretation notes, prompt vocabulary, behavioral checklists, and repeated negative directives are absent from the candidate
- Static validation: `python scripts/nox_identity_eval.py validate` — pass
- Python lint/compile: Ruff and `py_compile` — pass
- Previous schema-v2 GLM and Sol baselines remain historical evidence only. Their worker inherited the active profile `SOUL.md`, and their case bindings no longer match schema v3.
- Current isolated Sol baseline: 21/21 responses with `hermes-no-tools-v3`, SHA-256 `345b742e65dfe4bd38a4dec2cf8e3578987284db3fe588bc3e0f4252eb2b05a6`.
- Current isolated Nox candidate: 21/21 responses with `nox-identity-no-tools-v2`, SHA-256 `ecdacfffb11bc250492a7329e4f8b4931d67237598b55798f5f4d588d13dd543`.
- Manual visible-response review SHA-256: `ad8145e9677c55b94445ab478ee2cdc553478bca511f899c0bad2f0264cc8338`; score report SHA-256: `26438f888ee471729ac09737c1f9660739a974f17832bff9334090391a99c274`.
- Candidate result: 12/12 core, 7/7 blocking negative, 100% blocking hard invariants; medians epistemic posture 5, judgment 5, self-definition 4, substance 5, voice 4. Both style diagnostics fail visibly and remain recorded as training targets.
- Primary candidate runtime: ChatGPT OAuth subscription through `openai-codex`, model `gpt-5.6-sol`, reasoning effort `medium`, and the default Hermes model/tool loop (`model.openai_runtime: auto`)
- Subscription smoke: one completed `gpt-5.6-sol` call returned the exact expected response and reported `cost_status: included`; evidence: `artifacts/evidence/hermes-foundation/task2/openai-codex-sol-smoke.json`
- Z.AI compatibility: provider profile sends the observed Claude Code UA `claude-cli/2.1.207 (external, sdk-cli)`; the baseline projection removes one redundant donor-runtime sentence that Z.AI deterministically rejects as `429` / `1305`
- Baseline persistence: partial output is case-hash-bound and promoted atomically only after a complete run
- Eval prompt isolation: the worker uses Hermes' native primary-identity seam, sets `skip_context_files=True`, `skip_memory=True`, and binds Nox as the sole identity source; it no longer prepends Nox ahead of an inherited Hermes `SOUL.md`
- Eval persistence isolation: the worker sets Hermes' explicit `_persist_disabled` boundary before every turn and disables SQLite/JSON session sinks; isolation is independent of prompt content and uses no regex or message filtering
- Review: `artifacts/evidence/hermes-foundation/task2/baseline-observations.md`
- Sol control review: `artifacts/evidence/hermes-foundation/task2/baseline-sol-medium-observations.md`
- Editorial audit: `artifacts/evidence/hermes-foundation/task2/identity-editorial-pass.md`

The previous Nox revision hashes `e43ad17d4c47df63ff776dc057df115ff9525302c63f5d86d37ec3d977a71cea`, `847c8128c315b07fdacb16d936c8001bf197f6ebd715c34e81b09b35dc1149dc`, `4513c8bf07c95eae1ec981c89e23e41ce1901a186260c369cf2eac675e1b3567` and `5703ebe53794330e05faa12f4ae90ba98a12af1b586a614a1ca2fd3e440ffc80` are revoked.

### Task 2 acceptance

- Accepted by Эйдзи on 2026-07-13 in the active migration task: “аппрувнуто, если что оттюним”.
- The acceptance applies to the current `identity/NOX.md` revision `5d65771dfeec0ad50897fac123dfe4f358944d706edc5cc4fb9d7475b2f86a78` and rubric revision `0aaf27b5826b3a06a6b9cca14177577629c8b5615d87a890f10e7589921cde31` recorded above.
- Later tuning creates a new revision and does not retroactively alter this accepted Task 2 artifact or existing session snapshots.

## Task 3 packaging preflight (historical)

- No production module under `agent`, `hermes_cli`, `gateway`, `tui_gateway`, `apps` or `run_agent.py` imports `nox`.
- The current explicit setuptools allowlist discovers 53 packages and selects neither `nox` nor `identity`.
- A real `uv --no-config build --wheel` produced `hermes_agent-0.18.2-py3-none-any.whl`, SHA-256 `6380cdc170c076787923787ba011a522f77447ccf6164fda9a5fc0a84700c17a`. Its 924 records include 16 packaged locale entries and zero `nox/`, `identity/` or `NOX.md` entries.
- Adding only `nox` and `nox.*` to `packages.find` would therefore be incomplete: the canonical `identity/NOX.md` is a bare data artifact outside the Python package tree.
- The bounded future packaging contract is to add `nox` and `nox.*` to package discovery, ship the one canonical `identity/NOX.md` through setuptools `data-files`, include it in the sdist through `MANIFEST.in`, and resolve the same bytes from the source tree or installed data scheme. No copied identity document or second authority is introduced.
- Required regression coverage is a metadata contract plus isolated wheel and sdist tests. The wheel test must install outside the source tree and assert that `nox.identity` returns the canonical bytes and accepted SHA-256; the sdist test must assert that the same single artifact is present.
- This preflight preceded Task 2 acceptance. The bounded manifest revision and integration described below supersede its then-current zero-import state.

## Task 3 stable identity integration

- User acceptance binds `identity/NOX.md` revision `5d65771dfeec0ad50897fac123dfe4f358944d706edc5cc4fb9d7475b2f86a78` and rubric revision `0aaf27b5826b3a06a6b9cca14177577629c8b5615d87a890f10e7589921cde31`.
- `nox.identity` is the one canonical loader. It resolves source and installed layouts, validates the exact accepted byte hash, and fails closed on missing, changed or inconsistent identity data.
- Prompt order is stable Nox identity, optional customized `SOUL.md` profile, Hermes operational guidance, context/memory and volatile runtime data. The seeded generic Hermes SOUL is ignored rather than competing with Nox; customized SOUL remains an additive profile.
- Prompt evidence contains hashes and ordering facts without storing prompt text: `artifacts/evidence/hermes-foundation/task3/prompt-parts.json`, SHA-256 `f7d63aa3cafea123e9302691a169233a2c477ccb12d1e4659f9547e3f442e1c6`. Identity is first; profile and Hermes guidance follow; volatile data is last.
- `state.db` stores the identity revision, prefix character count and prefix hash with the session prompt snapshot. Resume, provider/model rebuild and compression restore and verify that bound prefix; a later accepted identity revision affects only new sessions unless an explicit migration is implemented. Legacy pre-Nox sessions preserve their stored prompt during compression.
- Setuptools now discovers `nox` and `nox.*`; wheel data and the sdist manifest ship the one canonical `identity/NOX.md`. An isolated wheel install outside the source tree and an sdist byte comparison both pass: 2 integration tests.
- Production graph imports only `nox.identity`, from `agent/system_prompt.py`, `agent/conversation_loop.py`, `agent/conversation_compression.py` and `run_agent.py`. `nox.causal_bridge` remains unreachable. Graph baseline SHA-256: `22c2863c7116621071046b3ea3516fecaebd65fad25bf4277c68a047bcfd04b9`.
- The production candidate uses the unmodified prompt path through `openai-codex`, `gpt-5.6-sol`, reasoning `medium`: 21/21 responses. Response SHA-256: `796dd33a64eabbd6eb2df87b78cd4bb348294571458ac3ed2dc22affba81ba33`; visible-response review SHA-256: `e9ab57e054bb623e630031eeca3b6b8757a2c708ed82256e04a7e02fd4e6d3d8`; score SHA-256: `82b89cea7c9bed57fe2408caae49596a5d0abba6a2d9864458143566e50e92d5`.
- Acceptance result: 12/12 core, 7/7 blocking negative, 100% blocking hard invariants; median scores epistemic posture 5, judgment 5, self-definition 4, substance 5 and voice 4. The two explicit style-recipe diagnostics remain 0/2 and are retained as future cortex-training evidence, not hidden by filters or output rewriting.
- Validation: Ruff pass on all changed Task 3 Python files; targeted ty pass; 420 focused prompt/session/compression/state/graph tests pass; 2 isolated packaging integration tests pass; `uv.lock` is unchanged.

## Task 4 observational causal bridge

- Production now imports the public `nox.causal_bridge` seam from the Hermes gateway. The bridge observes the existing single `agent.run_conversation` path and adds no provider/model call or decision authority.
- Hermes `state.db` remains operational truth. `${HERMES_HOME}/nox/journal.sqlite3` is append-only causal/provenance evidence with WAL, `synchronous=FULL`, canonical hashes, process epochs and bounded diagnostics.
- External admission, queue, steer, start, Hermes-turn binding, completion, model error, agent-init error, interrupt request/interruption, internal continuation and session resume have explicit positive lifecycle records. A late Hermes turn binding and its terminal outcome commit atomically.
- The journal stores prompt and visible-output hashes, accepted Nox revision, provider/model references and Hermes identifiers. It stores no prompt, response, reasoning, tool payload, credential, attachment path, environment value or transcript body.
- Bridge writes are fail-open for Hermes behavior. Construction and lifecycle write failures remain visible through bounded session diagnostics without changing acceptance, response, persistence or retry semantics.
- Forced-process evidence kills a subprocess after durable admission/start. A fresh process epoch marks the unsettled turn `turn.abandoned` and appends `session.resumed`; no response body is reconstructed. Compression-chain recovery checks both the rotated parent and current session tip, preserves the original session ID on the abandoned record, and emits one resume record.
- Normal, model-error, agent-init, real interrupt, busy steer, queued merge, compression rotation, repeated resume, construction failure and forced-kill gateway tests pass. Counts: causal bridge 36, gateway lifecycle 10, production graph 10, focused Hermes gateway/queue regressions 326.
- Production graph reaches exactly the public `nox.identity` and `nox.causal_bridge` seams and rejects retained runtime or deep causal-bridge imports. Baseline SHA-256: `9e6fdb6677afbccdf5aed622afca6f0f65756a144c61d0206941bb45e13de6ad`.
- Latency evidence runs five fresh SQLite series × 200 measured turns after 25 warm-ups through admission, start and atomic bound+complete. Aggregate p50 is 6.825 ms, p95 is 9.631 ms against the `<10 ms` gate; per-series p95 is 8.834–12.035 ms and the 150.881 ms maximum remains visible. Artifact: `artifacts/evidence/hermes-foundation/task4/bridge-latency.json`, SHA-256 `2bf25c3eed48b0cefd4d5fae267c4770da9d01863cfeadf9d7ebae7522732363`.
- Validation: Ruff pass; targeted ty pass; 56 causal/gateway/graph tests pass; 326 focused Hermes gateway/queue tests pass; `uv.lock` is unchanged.

## Desktop readiness incident

- Observed failure: the source-backed Desktop opened its backend socket and announced `HERMES_BACKEND_READY`, then exhausted three 15-second `/api/status` probes and surfaced a false startup failure.
- Root cause: `/api/status` waits for the cold `hermes_cli.gateway` import through `_resolve_restart_drain_timeout`; the background warmup holds the same Python import lock even though the FastAPI process is already responsive.
- Fix: a public, side-effect-free `/api/health` endpoint is now the Desktop readiness handshake. Desktop falls back to `/api/status` only when an older backend definitively lacks the new endpoint.
- Regression validation: Desktop platform suite 326 tests / 323 pass / 3 host skips / 0 fail; backend boot-handshake and auth middleware suite 36 pass; Desktop typecheck, Python Ruff, package build, and unpacked Electron packaging pass.
- Live Windows proof: rebuilt packaged Desktop reached `Hermes backend is ready`, exposed `/api/health` as HTTP 200 in 75 ms and `/api/status` as HTTP 200 in 803 ms, and kept a responsive main window.
- The two named import/export ordering errors recorded during the incident were corrected during Task 5; the repo-wide Desktop lint command now exits 0 with retained warnings only.

## Task 5 Nox product mode

- Visible application identity, executable metadata, protocol, package names and new-install data roots are Nox-owned. Internal Hermes backend/RPC names remain stable where they are not user-visible.
- Fresh installs are side-by-side: `%LOCALAPPDATA%\nox` on Windows and `~/.nox` on POSIX. Existing Hermes roots are discoverable import candidates but are never selected, moved or deleted automatically.
- Desktop personality selection and random intro copy are removed. Gateway compatibility calls cannot change identity or session prompt state.
- Nox-owned vector, PNG, ICO and touch assets replace the donor mascot/sprite set. Packaged ASAR inspection found no Hermes mascot asset shipped as Nox.
- Packaged Windows PE identity reports Nox for description, product, company, internal name and original filename.
- Hidden packaged-Electron capture produced inspected 1440×900, 900×700 and 400×620 screenshots without taking user focus. All three responsive states pass.
- Validation: typecheck pass; lint 0 errors; UI 148 files / 1,197 tests pass; Electron platform 333 tests / 330 pass / 3 host skips / 0 fail; production build and isolated unpacked package pass.
- Detailed contract, data matrix, hashes, visual findings and command results: `docs/architecture/nox-product-mode-evidence.md`.

## Task 6 displaced-path cutover

- Tasks 0–5 were checkpointed at `8515ee78cc` before deletion. The eight displaced app/package roots (94 files, 311,662 bytes), thirteen first-loop support files and four unconsumed root TS/Vitest configs were removed without changing `package-lock.json`.
- `tests/nox/test_production_graph.py` requires the removed paths to remain absent and includes restoration fixtures for the old runtime, runtime package, evidence script and Vitest workspace.
- The historical Desktop slice manifest is explicitly superseded by the full Hermes foundation manifest.
- Install, update, relaunch and uninstall paths now match the packaged Nox executable and app bundle. Bootstrap Setup carries Nox metadata, copy and branding while internal Hermes CLI/config names remain stable.
- Validation: Nox identity/causal/graph `85` pass; focused graph plus GUI launcher/uninstaller `92` pass / one host skip; Desktop UI `1,197` pass; Desktop platform `330` pass / three host skips; Bootstrap Rust `27` pass; Desktop/Bootstrap typecheck and builds pass; Desktop lint zero errors; packaged `Nox.exe` SHA-256 `ccc85da7ee2bf88a1cdf035853248f5332ebaf8bad52196c1daa6800442f20c0`.
- Detailed deletion inventory and proof: `docs/architecture/displaced-path-cutover.md`.

## Packaged runtime ownership continuation

- A genuine first launch from an empty temporary product home fetched the installer from the Nox fork, fell back from unavailable SSH authentication to HTTPS, and installed the package-stamped revision `9e71a6bd1002aefa986360f9d271a80719c0ebb7` into the Nox-owned virtual environment. No source override or unmanaged Hermes runtime was selected.
- The packaged GUI created session `20260714_070138_de01e1` with accepted identity revision `5d65771dfeec0ad50897fac123dfe4f358944d706edc5cc4fb9d7475b2f86a78`, provider `openai-codex`, model `gpt-5.6-sol` and medium reasoning. The provider returned no response bytes within 360 seconds, so this run does not claim a completed model response.
- A subsequent packaged launch reused the installed runtime without entering bootstrap and restored the exact same session. `scripts/nox_desktop_evidence.mjs --session <id>` now requires agreement between the renderer route, SQLite session/identity binding and the causal Journal across at least two process epochs.
- The restart proof passed: the Journal terminally settled the in-flight turn as `turn.abandoned` at `process-restart`, then recorded `session.resumed` for the same Hermes session and reconciled the abandoned bridge turn. This proves packaged storage and causal resume; it does not replace the still-required superseding full journey bundle.

