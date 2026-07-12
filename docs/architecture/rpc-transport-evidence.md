# Nox RPC transport acceptance evidence

Captured at `2026-07-12T09:39:06.454Z` for Task 6 of the accepted first-causal-loop plan.

## Ordered receipt boundary

The direct append test observed this side-effect order:

```text
record -> successful response flush -> release
```

A record failure produced an error response and zero release. A response send/flush failure attempted no release. A release failure after a successful response produced no second JSON-RPC response. Runtime integration separately proves that `EventAdmitted` and `ActStarted` occur only inside/after release.

Reconnect uses the same rule: `view.snapshot` includes authenticated-owner unresolved receipts, flushes the complete snapshot response, then releases exactly those Event IDs. The process-host integration created one direct Event and one quarantined reconnect Event; the final SQLite Journal contained exactly two Events, two admissions, two Act starts, and two terminals.

## Transport and vocabulary

- JSON-RPC `2.0` carries only `event.append`, `view.snapshot`, `journal.subscribe`, and `act.cancel` from the versioned Nox domain schema.
- Protocol mismatch returns typed error `-32001` before runtime access.
- Cursor subscription replays typed `nox.event` notifications in Journal sequence order.
- Each connection has a bounded pending-frame count; overflow closes it rather than growing an unbounded projection queue.
- WebSocket binds to `127.0.0.1` on a dynamic port and verifies a bearer launch token with timing-safe comparison.
- `NoxRpcClient` is intended for Electron main/runtime ownership; transport URL and token are not part of protocol or renderer methods.
- No Hermes method alias or gateway/session vocabulary exists.

## Production process composition

`apps/runtime` now has one neutral `createProcessHost` used by production `main.ts`. Production injects SQLite Store, bounded Pi Cortex, system clock, canonical foundation State, and RPC server. It reopens existing State without reinitializing identity, verifies persisted model identity, runs recovery before listening, writes Pi operational artifacts through the same Store, and prints only dynamic port plus protocol version for its parent process.

## Verification

- `npm run test --workspace @nox/interface-rpc`: 1 file, 7 tests passed.
- `npm run typecheck --workspace @nox/interface-rpc`: passed.
- `npm run test --workspace @nox/runtime-app`: 1 process-host integration test passed.
- `npm run typecheck --workspace @nox/runtime-app`: passed.
