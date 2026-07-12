import { canonicalHash, PROTOCOL_VERSION } from '@nox/protocol'
import type { JournalRecordInput } from '@nox/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeHarness } from './support/runtime-harness.js'
import { createHarness, deliver } from './support/runtime-harness.js'

const harnesses: RuntimeHarness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.dispose()
  }
})

describe('createRuntime', () => {
  it('keeps retry identity stable even when observed time advances', async () => {
    const proposal = { effects: [], protocolVersion: 1, settlement: 'silent' } as const
    const harness = await createHarness([{ kind: 'proposed', proposal, proposalHash: canonicalHash(proposal) }])
    harnesses.push(harness)
    const first = await harness.runtime.appendEvent({
      clientEventId: 'stable-client-id',
      content: 'same payload',
      format: 'text',
      interfaceOwnerId: 'eiji-local'
    })
    harness.clock.advanceTo('2026-07-12T08:05:00.000Z')
    const retry = await harness.runtime.appendEvent({
      clientEventId: 'stable-client-id',
      content: 'same payload',
      format: 'text',
      interfaceOwnerId: 'eiji-local'
    })
    expect(retry).toEqual(first)
    expect(await harness.runtime.journal()).toHaveLength(1)
  })

  it('paginates complete recovery reads and gives Cortex the latest 64 Journal records', async () => {
    const proposal = { effects: [], protocolVersion: 1, settlement: 'silent' } as const
    const harness = await createHarness([{ kind: 'proposed', proposal, proposalHash: canonicalHash(proposal) }])
    harnesses.push(harness)
    for (let batch = 0; batch < 100; batch += 1) {
      const records: JournalRecordInput[] = Array.from({ length: 100 }, (_, offset) => {
        const ordinal = batch * 100 + offset + 1
        return {
          causal: { causeSequences: [], eventId: 'bulk-event' },
          entry: { actId: `bulk-act-${ordinal}`, kind: 'act.cancel-requested', reason: `bulk-${ordinal}` },
          journalSchemaVersion: 1,
          protocolVersion: PROTOCOL_VERSION,
          provenance: { component: 'pagination-test', kind: 'runtime' },
          recordedAt: '2026-07-12T08:00:00.000Z'
        }
      })
      await harness.store.transact({
        commandId: `bulk-page-${batch}`,
        expectedStateVersion: 0,
        protocolVersion: PROTOCOL_VERSION,
        records
      })
    }

    await deliver(harness.runtime, 'after-ten-thousand')
    await harness.runtime.waitForIdle()

    const all = await harness.runtime.journal()
    expect(all.length).toBeGreaterThan(10_000)
    expect(all[0]?.sequence).toBe(1)
    expect(all.at(-1)?.sequence).toBe(all.length)
    expect(harness.cortex.inputs).toHaveLength(1)
    expect(harness.cortex.inputs[0]?.journalContext).toHaveLength(64)
    expect(harness.cortex.inputs[0]?.journalContext[0]?.sequence).toBe(9_939)
    expect(harness.cortex.inputs[0]?.journalContext.at(-1)?.entryKind).toBe('event.admitted')
  })
})
