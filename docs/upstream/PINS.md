# Upstream pins and provenance

Verified on 2026-07-12 from the upstream Git repositories, package manifests, licenses, and npm registry.

## Pi

- Repository: `https://github.com/earendil-works/pi`
- Commit: `8479bd84743e8889f728acb21a62794102db0529`
- License: MIT, copyright 2025 Mario Zechner.
- Runtime requirement: Node `>=22.19.0`.
- Production packages:
  - `@earendil-works/pi-ai@0.80.6`
  - `@earendil-works/pi-agent-core@0.80.6`
- Nox boundary: model invocation and one bounded agent-core transition only.
- Excluded packages and semantics: coding-agent shell, sessions, persistence, task loop, follow-up queue, steering queue, and Pi-owned continuity.

Primary sources:

- `https://github.com/earendil-works/pi/tree/8479bd84743e8889f728acb21a62794102db0529`
- `https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/ai/package.json`
- `https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/packages/agent/package.json`
- `https://github.com/earendil-works/pi/blob/8479bd84743e8889f728acb21a62794102db0529/LICENSE`

## Historical Hermes Desktop slice

- Repository: `https://github.com/NousResearch/hermes-agent`
- Commit: `4281151ae859241351ba14d8c7682dc67ff4c126`
- Desktop version: `0.17.0`.
- License: MIT, copyright 2025 Nous Research.
- Upstream runtime requirement: Node `^20.19.0 || >=22.12.0`.
- Electron pin retained for donor compatibility: `40.10.2`.
- Historical boundary: presentation primitives, safe formatting helpers, theme types/color helpers, window geometry, and selected generic hardening patterns.
- Historical source blobs and targets: `docs/upstream/hermes-desktop-slice.json`, superseded by the full-foundation manifest at Task 6.

This slice excluded the full Hermes thread and composer. The accepted migration later replaced that approach with the pinned full Hermes foundation described by `docs/upstream/hermes-foundation.json`.

Primary sources:

- `https://github.com/NousResearch/hermes-agent/tree/4281151ae859241351ba14d8c7682dc67ff4c126`
- `https://github.com/NousResearch/hermes-agent/blob/4281151ae859241351ba14d8c7682dc67ff4c126/apps/desktop/package.json`
- `https://github.com/NousResearch/hermes-agent/blob/4281151ae859241351ba14d8c7682dc67ff4c126/apps/desktop/DESIGN.md`
- `https://github.com/NousResearch/hermes-agent/blob/4281151ae859241351ba14d8c7682dc67ff4c126/LICENSE`

## Foundation toolchain

- Node: `24.18.0`.
- npm: `11.16.0`, bundled with the pinned Node Windows distribution used for the Task 0 lock.
- TypeScript: `6.0.3`, selected because the pinned TypeScript ESLint line supports TypeScript `<6.1.0`.
- ESLint: `9.39.4` with the Hermes Desktop plugin family and rule shape.
- Vitest: `4.1.5`; Desktop invokes Vitest directly through its workspace script. The displaced root Vitest project configuration was removed at Task 6.
- Vite: `8.1.4`; this stays within Hermes' declared `^8.0.10` range and removes the Windows path-disclosure advisories affecting `8.0.0` through `8.0.15`.
- React / React DOM: `19.2.7`.

Every direct dependency is exact in the workspace manifests. `package-lock.json` is the transitive dependency authority after Task 0.
