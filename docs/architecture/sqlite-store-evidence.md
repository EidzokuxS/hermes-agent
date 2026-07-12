# SQLite Store acceptance evidence

Captured at `2026-07-12T08:56:54.699Z` for Task 2 of the accepted first-causal-loop plan.

## Runtime and schema

- Runtime: Node `24.18.0`, built-in `node:sqlite`, SQLite `3.53.1`.
- Migration: `001_foundation`, canonical checksum `sha256:592669cd03c678c8339147cda9860fd143c833fbd4710f2051a7cfd60acc58bc`.
- Connection proof: `journal_mode=wal`, `synchronous=2` (`FULL`), `foreign_keys=1`, `trusted_schema=0`; defensive mode and a 5-second busy timeout are enabled in the constructor.
- Tables are `STRICT`; all JSON columns have database-level `json_valid` checks.
- Journal records, State snapshots, audit blobs, migration identities, external receipts, admissions, continuation fires, and commit receipts have update/delete guards. `state_head` alone is mutable and has a monotonic `+1` trigger.

## Transaction fault matrix

The same State-changing `CommitCommand` was faulted independently at three boundaries:

| Injected stage | Journal after failure | State version after failure |
| --- | ---: | ---: |
| after Journal inserts | 0 records | 0 |
| before snapshot insert | 0 records | 0 |
| after snapshot/head update, before commit | 0 records | 0 |

The unfaulted command atomically wrote three Journal records, advanced State from version 0 to 1, wrote one append-only snapshot through sequence 3, reopened with the same canonical State hash, and passed independent State-history verification.

## Identity and audit constraints

- Retrying the same authenticated `(interfaceOwnerId, clientEventId)` returned the original receipt and did not append a second Event.
- Reusing that identity with different Event content was rejected.
- Retrying the same admission command returned its original commit receipt; a second admission identity was rejected by SQLite uniqueness.
- A second accepted `continuation.fire` for the same Continuation was rejected and rolled back without advancing State.
- A stale expected State version was rejected before writes.
- Direct update/delete attempts against Journal, snapshots, blobs, and migration history were rejected by SQLite triggers.
- A rejected Effect remained in the Journal without a new snapshot. After a WAL checkpoint and SQLite Backup API copy, the independent read-only auditor reported `integrity_check=ok` and found the rejected decision.

## Verification

- `npm run test --workspace @nox/store-sqlite`: 1 file, 10 tests passed.
- `npm run typecheck --workspace @nox/store-sqlite`: passed.
- `npm run build --workspace @nox/store-sqlite`: passed with declarations.
- Root test gate after integration: protocol and SQLite projects pass together.

The Store never imports the runtime reducer or Desktop projection. `SqliteAuditReader` parses only protocol records and opens the evidence database with `readOnly` and `query_only` enabled.
