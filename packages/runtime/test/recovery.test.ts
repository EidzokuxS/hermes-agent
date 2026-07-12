import { canonicalHash, PROTOCOL_VERSION } from '@nox/protocol'
import type { JournalRecordInput } from '@nox/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeHarness } from './support/runtime-harness.js'
import { createHarness, runtimeAt } from './support/runtime-harness.js'

const harnesses: RuntimeHarness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.dispose()
  }
})

function record(entry: JournalRecordInput['entry'], eventId: string, actId?: string): JournalRecordInput {
  return {
    causal: { ...(actId === undefined ? {} : { actId }), causeSequences: [], eventId },
    entry,
    journalSchemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    provenance: { component: 'recovery-test', kind: 'runtime' },
    recordedAt: runtimeAt
  }
}

describe('startup recovery', () => {
  it('settles a running Act as interrupted and does not retry it', async () => {
    const harness = await createHarness([
      {
        kind: 'plain-text',
        text: 'must not be called during interrupted recovery'
      }
    ])
    harnesses.push(harness)
    const receipt = await harness.runtime.appendEvent({
      clientEventId: 'event-interrupted',
      content: 'before crash',
      format: 'text',
      interfaceOwnerId: 'eiji-local'
    })
    const snapshot = await harness.store.loadSnapshot()
    await harness.store.transact({
      commandId: 'seed-interrupted-act',
      expectedStateVersion: snapshot.stateVersion,
      protocolVersion: 1,
      records: [
        record({ eventId: receipt.eventId, kind: 'event.admitted' }, receipt.eventId),
        record(
          {
            act: {
              actId: 'act-before-crash',
              cortexId: snapshot.state.cortex.cortexId,
              input: {
                blobHash: `sha256:${'d'.repeat(64)}`,
                builderVersion: 1,
                stateHash: snapshot.stateHash,
                stateVersion: snapshot.stateVersion,
                triggerEventId: receipt.eventId
              },
              kind: 'started',
              modelId: snapshot.state.cortex.modelId,
              protocolVersion: 1,
              startedAt: runtimeAt
            },
            kind: 'act.started'
          },
          receipt.eventId,
          'act-before-crash'
        )
      ]
    })

    await harness.runtime.recover()
    await harness.runtime.waitForIdle()
    const terminal = (await harness.runtime.journal()).find(
      ({ entry }) => entry.kind === 'act.terminal' && entry.terminal.actId === 'act-before-crash'
    )
    expect(terminal?.entry).toMatchObject({ terminal: { status: 'interrupted' } })
    expect(harness.cortex.inputs).toHaveLength(0)
    expect((await harness.store.loadSnapshot()).stateVersion).toBe(0)
  })

  it('keeps recorded external Events quarantined but resumes admitted work with no Act', async () => {
    const proposal = { effects: [], protocolVersion: 1, settlement: 'silent' } as const
    const harness = await createHarness([{ kind: 'proposed', proposal, proposalHash: canonicalHash(proposal) }])
    harnesses.push(harness)
    const quarantined = await harness.runtime.appendEvent({
      clientEventId: 'quarantined',
      content: 'receipt not flushed yet',
      format: 'text',
      interfaceOwnerId: 'eiji-local'
    })
    await harness.runtime.recover()
    await harness.runtime.waitForIdle()
    expect(harness.cortex.inputs).toHaveLength(0)
    expect(await harness.runtime.unresolvedReceipts('eiji-local')).toEqual([quarantined])

    const snapshot = await harness.store.loadSnapshot()
    await harness.store.transact({
      commandId: `manual-admit:${quarantined.eventId}`,
      expectedStateVersion: snapshot.stateVersion,
      protocolVersion: 1,
      records: [record({ eventId: quarantined.eventId, kind: 'event.admitted' }, quarantined.eventId)]
    })
    await harness.runtime.recover()
    await harness.runtime.waitForIdle()
    expect(harness.cortex.inputs).toHaveLength(1)
  })
})
