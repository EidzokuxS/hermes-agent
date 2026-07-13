# Переезд Nox на Hermes Foundation — PRE Review

- **Mode:** PRE
- **Verdict:** aligned
- **Date:** 2026-07-12
- **Reviewed plan:** `docs/goals/nox-hermes-foundation-migration/PLAN.md`
- **Accepted pre-execution PLAN SHA-256:** `F453963F6B002C9DA343E8A100FE429E66896AFC7BBAECC318955B4896B6D493`
- **Current terminology-only PLAN SHA-256:** `9B2B14C223B7C0ED7265524431EB5BB34A88A4BAFF2859B178E3141D7070B559`
- **Blockers:** 0
- **Majors:** 0
- **Minors:** 0

## Review basis

The plan was checked against the Krypton PRE contract for outcome clarity, source authority, ownership, contract boundary, cutover, displaced paths, actionable task packets, validation, target-perspective evidence and stop conditions. The architecture map was grounded against pinned Hermes Agent commit `4281151ae859241351ba14d8c7682dc67ff4c126`, including `agent/system_prompt.py`, `tui_gateway/server.py`, the root manifests and Desktop `0.17.0` scripts.

## Resolved during review

- Replaced the donor-slice model with an exact full-tree foundation import and a path-level collision/provenance manifest.
- Removed the contradiction between importing the Hermes `apps/desktop` collision at Task 0 and deleting legacy paths at Task 6: the custom Desktop remains in rollback history, not as a second production tree.
- Separated Hermes operational session truth from Nox causal/constitutional truth; the bridge labels Hermes outcomes `observed` and stores no shadow transcript.
- Fixed Nox to a stable identity tier rather than dynamic per-turn injection; profile `SOUL.md` is additive and cannot own Nox.
- Added objective default identity thresholds and a separate hash-bound acceptance gate before runtime integration.
- Grounded Desktop baseline commands in the pinned package scripts and fixed Node/Python version ownership.
- Distinguished external, queued-external and internal follow-up provenance around the single `_run_prompt_submit` runner instead of instrumenting generic event emission.
- Made observational bridge failure fail-open for Hermes but fail the Nox acceptance lane, and added process-epoch recovery for in-flight turns.
- Added one-production-path and zero-second-model-call gates, a measured bridge latency budget, packaged GUI proof and forced-restart correlation evidence.
- Explicitly scoped non-Desktop gateway causal coverage out of this migration goal rather than claiming unsupported system-wide coverage.

## Next gate

Эйдзи accepts the exact PLAN hash. Acceptance releases Task 0 only. Task 2 produces a second required acceptance gate for `identity/NOX.md` before Task 3 may begin.

