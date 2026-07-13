# Removed Nox Causal Sources

- The former `cortex-pi`, `runtime`, `interface-rpc`, `protocol`, `store-sqlite`, and `testkit` packages were removed at the Hermes foundation cutover. Their last complete state is recoverable from checkpoint `8515ee78cc` and the pre-migration rollback tag.
- Do not recreate or connect them to the production Desktop unless an accepted plan assigns a bounded seam and deliberately updates the production-graph gate.
- Future Journal integration may observe Hermes outcomes and own Nox constitutional State; it must not duplicate Hermes sessions, messages, tool results, or model-loop authority.
- Preserve deterministic clocks, IDs, schema validation, append-only causal records, and independent auditability if a causal component is redesigned.
