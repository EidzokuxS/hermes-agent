# Task 10 — evidence tooling and kill-criteria evidence

Date: 2026-07-12

## Independent audit path

`@nox/audit` opens SQLite in read-only/query-only mode after the store audit reader verifies the migration checksum. Its replay implementation imports protocol schemas and canonical hashing, but imports neither the runtime reducer nor the Desktop projection.

Starting at genesis, it independently:

- validates gapless Journal sequence and prior-only causal links;
- applies accepted `state.patch`, `continuation.schedule`, `continuation.cancel` and `continuation.fire` semantics;
- excludes rejected Effects and non-State emissions;
- recomputes the temporal anchor, every State version and canonical hash;
- compares every advancement with both the Journal marker and stored snapshot;
- compares the final replay version with the State version restored by Desktop.

Audit tests run the production runtime/store path, pass a valid v1 database, reject a tampered snapshot, and prove one rejected Effect is counted but not replayed into State.

## Evidence bundle

`npm run evidence:first-loop -- --run-id task10-smoke4` produced an ignored local bundle with 17 manifest-bound artifacts. It uses SQLite Backup API after reopening the abruptly terminated database, so the copy is independent of WAL sidecars. The bundle contains the canonical Journal trace, State replay, restart/PID proof, six-boundary receipt matrix, input hashes, database backup, RPC order, production graph, kill report and three screenshots.

The `after-restart.png` screenshot is not a fixture: Playwright launched the compiled Electron main process with the test-only runtime entry over a copy of the same evidence database. The inspected screen showed runtime present, Journal cursor 20, both E1/A1 and continuation E2/A2, and State `v3` with hash prefix `ae02f42d`. Independent replay produced the full hash `sha256:ae02f42d1597c655b4e8b2d400e093e8222df2b941ed3ad77d7b50b2dd245c34`.

Offline verification passed:

```text
npm run verify:first-loop -- --bundle artifacts/evidence/first-causal-loop/task10-smoke4
artifacts=17, status=pass
```

The verifier checks the exact file set, bytes and SHA-256 manifest, parses every Journal record, recomputes the canonical trace hash, reruns independent database replay, verifies PID/termination/input evidence, enforces the receipt matrix and RPC order, and compares lock/source metadata.

A copied bundle was then modified by appending bytes to `deterministic/state-replay.json`. Offline verification exited `1` with `Artifact byte length mismatch`, as required.

## Kill criteria

`npm run check:kill-criteria` passed eight executable rules over explicit production roots:

- no production testkit import;
- no Hermes agent/gateway/session domain import;
- no renderer WebSocket;
- no Desktop State writer;
- no optimistic delivered projection;
- one production SQLite writer, with the separate reader allowlisted read-only;
- Pi dependencies confined to the Cortex adapter;
- all required Desktop → runtime → RPC entrypoint edges present.

The report also records every scanned source SHA-256, roots and exclusions. Root manifests and `package-lock.json` remain unchanged.
