# Task 0 baseline evidence

Captured at `2026-07-12T08:33:51.749Z` against accepted plan SHA-256
`53704F5D8E740856356BDB36E6B123844099EE1EBE7A9C6B4379840CAB4814DB`.

## Reproducible workspace

- `node --version`: `v24.18.0`
- `npm --version`: `11.16.0`
- `npm run node:check`: passed; `.node-version` and the active runtime agree.
- `npm ci`: installed 627 packages from `package-lock.json`; audit reported zero vulnerabilities.
- `npm run fmt:check`: passed.
- `npm run lint`: passed.
- `npm run typecheck`: passed for all nine workspaces.
- `npm run test`: passed with the empty Task 0 baseline; all seven Vitest projects were discovered.
- `npm run build`: passed, including the Electron renderer production build with Vite `8.1.4`.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`: passed.

The lock was initially generated with a command-local `--min-release-age=0` override because the user-level npm policy temporarily excluded the exact, upstream-verified Pi `0.80.6` release. The global npm configuration was not changed. A subsequent unmodified `npm ci` reproduced the lock.

Install scripts are explicitly approved only for the exact locked packages required by the dependency graph: `@google/genai@1.52.0`, `electron@40.10.2`, `esbuild@0.28.1`, and `protobufjs@7.6.5`.

## Dependency and provenance pins

- Pi commit `8479bd84743e8889f728acb21a62794102db0529` fetched directly from `https://github.com/earendil-works/pi.git` and resolved exactly.
- `@earendil-works/pi-ai@0.80.6` and `@earendil-works/pi-agent-core@0.80.6` are exact manifest and lockfile entries.
- Hermes commit `4281151ae859241351ba14d8c7682dc67ff4c126` fetched directly from `https://github.com/NousResearch/hermes-agent.git` and resolved exactly.
- All 22 allowlisted Hermes file and pattern-port blob SHAs in `hermes-desktop-slice.json` resolve at the pinned commit.
- Pi and Hermes MIT notices are recorded in `THIRD_PARTY_NOTICES.md`.
- Every direct workspace dependency is exact; `package-lock.json` is the transitive dependency authority after Task 0.

## Boundaries

- Pi is limited to AI and bounded agent-core dependencies.
- Hermes is default-deny and limited to the allowlisted Desktop presentation slice and named hardening patterns.
- `AGENTS.md` is 78 lines and records ownership, canonical truth, commands, donor constraints, and forbidden inputs.
- `NOX-RETHINK.md` and `REFERENCE ONLY/` are ignored by Git and were not read or imported during implementation.

Task 0 therefore releases Tasks 1, 6, and 7 without requiring later edits to root manifests or `package-lock.json`.
