# Hermes Foundation Migration — Recorded Deviations

## D-001 — Retained TypeScript causal loop is source-only during the Hermes baseline

- **Recorded:** 2026-07-12
- **Plan location:** Task 0, combined workspace registration and retained Nox baseline.
- **Evidence:** `npm install --package-lock-only --ignore-scripts` rejected `@earendil-works/pi-agent-core@0.80.6` with `ETARGET` under the registry publication cutoff, before producing a valid combined lock.
- **Decision:** Keep the pinned Hermes `package-lock.json` authoritative, do not add `packages/*`, and replace upstream's broad `apps/*` glob with its exact three pinned app workspaces (`apps/bootstrap-installer`, `apps/desktop`, `apps/shared`) so retained `apps/audit` and `apps/runtime` stay outside the install graph. The existing Nox causal packages remain tracked source and remain recoverable/tested at rollback commit `833dafc34bd7c37b99bf26110419c7edade1af76`; they are not part of the foundation production install or model loop.
- **Why this preserves intent:** The goal requires one production Desktop and one model/tool loop. Forcing the old Pi dependency into the Hermes lock would make the displaced runtime more coupled to production, not less.
- **Follow-up:** Task 1's production graph must prove the retained sources are unreachable. Task 6 decides whether they move to an explicit research archive or are removed. Any future executable reuse requires its own lock and accepted authority transfer.
- **Rollback:** Re-add an isolated workspace only if its exact dependencies can install without changing Hermes production resolution and a later accepted plan needs it.

## D-002 — Desktop platform tests use the installed `tsx` loader on Node 24.18

- **Recorded:** 2026-07-12
- **Plan location:** Task 0 baseline verification.
- **Evidence:** The pinned `test:desktop:platforms` command invoked `node --test` directly. Under the plan-pinned Node `24.18.0`, extensionless imports such as `./backend-env` from `.test.ts` fail with `ERR_MODULE_NOT_FOUND` before test logic runs. The same test passes under `node --import tsx --test` using Hermes Desktop's already-pinned `tsx` dev dependency.
- **Decision:** Add `--import tsx` to this test script only. Runtime, production bundling and source module specifiers are unchanged.
- **Why this preserves intent:** It restores the intended TypeScript test denominator on the required Node version instead of weakening or skipping tests.
- **Rollback:** Remove the loader flag if a future pinned Node/npm/test runner natively resolves the same TypeScript graph and the full suite proves parity.

## D-003 — Platform-source tests are made host-aware without runtime changes

- **Recorded:** 2026-07-12
- **Plan location:** Task 0 baseline verification.
- **Evidence:** After restoring TypeScript loading, four pinned tests failed on Windows. Three Linux relaunch tests constructed POSIX paths with the host `node:path` implementation and passed a Windows temp path directly to Git Bash; they cannot exercise their stated Linux contract on Windows. The remaining source-grep test required the literal signature `resetHermesConnection()` while pinned runtime code validly declares `resetHermesConnection({ soft = false } = {})` and still uses the required teardown helper.
- **Decision:** Skip only the three POSIX-only assertions on Windows and loosen the source-grep needle to the function name plus opening parenthesis. No production file or behavior changes.
- **Why this preserves intent:** Windows now executes the 318 applicable platform assertions instead of reporting false failures; Linux remains responsible for the three relaunch assertions.
- **Rollback:** Remove these guards if the test is refactored to inject path/process primitives and can truthfully run cross-platform.

## D-004 — Three stale Desktop expectations follow the pinned runtime contracts

- **Recorded:** 2026-07-12
- **Plan location:** Task 0 baseline verification.
- **Evidence:** Four Vitest assertions failed while their production paths matched newer pinned behavior: onboarding now requests `/api/model/options?include_unconfigured=1`, browser titles deliberately retain a non-root pathname, and truncation counts use `toLocaleString()` rather than a hard-coded US separator.
- **Decision:** Make the onboarding mock accept the endpoint query, expect the visible `/docs` target, and derive the separator with the same host locale. Production files are unchanged.
- **Why this preserves intent:** The assertions again test the actual API and UX contract rather than stale literals; no failure is hidden or skipped.
- **Rollback:** Update these expectations together with any future intentional API/title/localization contract change.

## D-005 — Nox fork owns bootstrap and update provenance

- **Recorded:** 2026-07-12
- **Plan location:** Task 0, packaged Desktop baseline and donor provenance.
- **Evidence:** The first packaged build embedded the local migration SHA but attempted to fetch its installer from `NousResearch/hermes-agent`, where that Nox commit cannot exist. The existing project fork `EidzokuxS/hermes-agent` was 2214 commits behind upstream and could be synchronized by fast-forward with no divergent commits.
- **Decision:** Keep `NousResearch/hermes-agent@4281151…` as the immutable donor source, synchronize the fork's `main` to upstream by fast-forward, and make `EidzokuxS/hermes-agent` the canonical `origin`, install-script source and update remote for Nox-owned commits. Migration work remains on `migration/hermes-foundation`; upstream `main` is not mixed into the pinned migration branch.
- **Why this preserves intent:** Full Hermes provenance remains auditable while packaged Nox commits can retrieve the exact installer script committed with their own build.
- **Rollback:** Point bootstrap and update constants back to a different Nox-owned repository only after that repository contains every packaged build commit and its matching installer scripts.
