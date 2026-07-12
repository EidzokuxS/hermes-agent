# Task 7 — Hermes-derived Desktop shell evidence

Date: 2026-07-12

## Provenance boundary

- Source: `NousResearch/hermes-agent@4281151ae859241351ba14d8c7682dc67ff4c126`.
- All 21 copied allowlist entries in `docs/upstream/hermes-desktop-slice.json` were materialized and independently resolved to the pinned source blob SHA.
- `electron/hardening.ts` is a Nox-owned pattern port limited to the ten allowlisted path-hardening symbols. `encryptDesktopSecret` is absent.
- The Desktop source import scan contains zero Hermes agent, gateway, session-store, backend or brand dependencies.
- The MIT provenance remains recorded in `THIRD_PARTY_NOTICES.md`; no excluded donor root was copied.

The copied UI layer was adapted only where Nox's strict TypeScript settings and relative module boundary required it. The causal vocabulary, State model, runtime transport and Nox identity are not donor semantics.

## Execution correction

The accepted plan described `vite.config.ts`, `tsconfig.electron.json` and `preload.ts` as read-only inputs. Actual Electron validation proved two configuration assumptions false:

1. Vite's default absolute asset base cannot load under `file://`.
2. Electron's sandbox bundle cannot execute an ESM preload.

The smallest build correction was applied: `base: './'`, plus a `.cts` preload compiled to `.cjs`. Root manifests and the lockfile remain unchanged. `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false` remain enforced.

## Verification

Commands:

```text
npm run test --workspace @nox/desktop
npm run typecheck --workspace @nox/desktop
npm run build --workspace @nox/desktop
```

Result: 6 test files / 9 tests passed; renderer and Electron TypeScript builds passed.

Visual baseline: [task7-desktop-shell.png](../goals/nox-first-causal-loop/artifacts/task7-desktop-shell.png).

The inspected shell uses a flat causal timeline, restrained Hermes-derived controls, visible State identity and a request composer. It has no agent/session/task-manager surface.
