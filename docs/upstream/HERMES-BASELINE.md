# Hermes Foundation — Task 0 Baseline

**Status:** in progress.

## Fixed inputs

- Nox migration base: `833dafc34bd7c37b99bf26110419c7edade1af76`
- Rollback tag: `nox-causal-loop-proven-v1`
- Hermes commit: `4281151ae859241351ba14d8c7682dc67ff4c126`
- Hermes tree: `735e875e12c18ebf3d6b2dd26928d72d155455d0`
- Hermes tracked files: `6250`
- Desktop version: `0.17.0`
- Node: `24.18.0`
- npm: `11.16.0`
- Python: resolved by pinned `uv.lock` and `pyproject.toml` (`>=3.11,<3.14`)

## Import result

The complete pinned Hermes tree is materialized at repository root. The colliding custom `apps/desktop` was removed before checkout, so files absent from Hermes cannot survive as a hidden second Desktop. Nox-only causal package sources, evidence and canonical documents remain present. The causal packages are intentionally outside the Hermes npm workspace after the registry rejected their historical Pi pin; see deviation `D-001`. Root `AGENTS.md` temporarily retains the stricter Nox authority and closed-path rules; Task 1 merges the upstream engineering guidance.

## Required baseline commands

Results are recorded only after running from a clean dependency install:

```text
uv sync --locked
npm ci
npm run test:desktop:platforms --workspace hermes
npm run test:ui --workspace hermes
npm run typecheck --workspace hermes
npm run build --workspace hermes
```

The retained Nox packages receive their own focused baseline after the combined workspace lock is generated. No identity, causal bridge or Nox branding change belongs to this checkpoint.

## Results

Pending dependency lock reconciliation and baseline execution.
