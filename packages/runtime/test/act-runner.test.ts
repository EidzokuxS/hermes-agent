import { canonicalHash } from '@nox/protocol'
import type { ActProposalResult } from '@nox/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeHarness } from './support/runtime-harness.js'
import { createHarness, deliver, waitForJournal } from './support/runtime-harness.js'

const harnesses: RuntimeHarness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.dispose()
  }
})

async function harnessFor(result: ActProposalResult): Promise<RuntimeHarness> {
  const normalized = result.kind === 'proposed' ? { ...result, proposalHash: canonicalHash(result.proposal) } : result
  const harness = await createHarness([normalized])
  harnesses.push(harness)
  return harness
}

describe('ActRunner causal settlements', () => {
  it('records receipt before admission and completes an emission without advancing State', async () => {
    const harness = await harnessFor({
      kind: 'proposed',
      proposal: {
        effects: [
          {
            content: 'Я здесь.',
            format: 'text',
            kind: 'emission.append',
            protocolVersion: 1
          }
        ],
        protocolVersion: 1,
        settlement: 'effects'
      },
      proposalHash: 'sha256:75851dfe9ce506133a106014fc44c99e425ec3d91f0bb600fa626f65da1673f7'
    })
    const receipt = await harness.runtime.appendEvent({
      clientEventId: 'client-event-001',
      content: 'Привет, Nox.',
      format: 'text',
      interfaceOwnerId: 'eiji-local'
    })
    expect((await harness.runtime.journal()).map(({ entry }) => entry.kind)).toEqual(['event.recorded'])

    await harness.runtime.releaseEvent(receipt.eventId)
    await harness.runtime.waitForIdle()
    const records = await harness.runtime.journal()
    expect(records.map(({ entry }) => entry.kind)).toEqual([
      'event.recorded',
      'event.admitted',
      'cortex.input-recorded',
      'act.started',
      'act.proposal-observed',
      'effect.decision',
      'act.terminal'
    ])
    expect((await harness.store.loadSnapshot()).stateVersion).toBe(0)
    expect(harness.cortex.inputs).toHaveLength(1)
  })

  it('records explicit silence without advancing State', async () => {
    const harness = await harnessFor({
      kind: 'proposed',
      proposal: { effects: [], protocolVersion: 1, settlement: 'silent' },
      proposalHash: 'sha256:6f653d34e277a4ad3d41f8874a2fd7d6ad41cb2028f66081e6b748f99fca7b4d'
    })
    await deliver(harness.runtime)
    await harness.runtime.waitForIdle()
    const terminal = (await harness.runtime.journal()).find(({ entry }) => entry.kind === 'act.terminal')
    expect(terminal?.entry).toMatchObject({ terminal: { stateVersion: 0, status: 'completed-silent' } })
    expect((await harness.store.loadSnapshot()).stateVersion).toBe(0)
  })

  it('applies an accepted State Effect in the same terminal transaction', async () => {
    const harness = await harnessFor({
      kind: 'proposed',
      proposal: {
        effects: [
          {
            kind: 'state.patch',
            operation: 'add',
            path: '/workingField/focus',
            protocolVersion: 1,
            value: 'causal-loop'
          }
        ],
        protocolVersion: 1,
        settlement: 'effects'
      },
      proposalHash: 'sha256:f98b83bef7d3f760a0d246b3b5f0213345ee57122ab0f6b7d1246bcd766db223'
    })
    await deliver(harness.runtime)
    await harness.runtime.waitForIdle()
    const snapshot = await harness.store.loadSnapshot()
    expect(snapshot.stateVersion).toBe(1)
    expect(snapshot.state.workingField.focus).toBe('causal-loop')
    expect((await harness.runtime.journal()).some(({ entry }) => entry.kind === 'state.advanced')).toBe(true)
  })

  it('records provider failure as terminal failure without State mutation', async () => {
    const harness = await harnessFor({
      code: 'provider-down',
      kind: 'provider-error',
      message: 'offline',
      retryable: true
    })
    await deliver(harness.runtime)
    await harness.runtime.waitForIdle()
    const terminal = (await harness.runtime.journal()).find(({ entry }) => entry.kind === 'act.terminal')
    expect(terminal?.entry).toMatchObject({ terminal: { status: 'failed' } })
    expect((await harness.store.loadSnapshot()).stateVersion).toBe(0)
  })

  it('records a rejected Effect decision while preserving State version', async () => {
    const harness = await harnessFor({
      kind: 'proposed',
      proposal: {
        effects: [
          {
            kind: 'state.patch',
            operation: 'replace',
            path: '/workingField/missing',
            protocolVersion: 1,
            value: 'not-applied'
          }
        ],
        protocolVersion: 1,
        settlement: 'effects'
      },
      proposalHash: `sha256:${'0'.repeat(64)}`
    })
    await deliver(harness.runtime)
    await harness.runtime.waitForIdle()
    const decision = (await harness.runtime.journal()).find(({ entry }) => entry.kind === 'effect.decision')
    expect(decision?.entry).toMatchObject({ decision: { decision: 'rejected' } })
    expect((await harness.store.loadSnapshot()).stateVersion).toBe(0)
  })

  it('fences late Cortex completion after durable cancellation', async () => {
    let resolveResult: ((result: ActProposalResult) => void) | undefined
    const harness = await createHarness(
      () =>
        new Promise<ActProposalResult>(resolve => {
          resolveResult = resolve
        })
    )
    harnesses.push(harness)
    await deliver(harness.runtime)
    const started = await waitForJournal(harness.runtime, records =>
      records.some(({ entry }) => entry.kind === 'act.started')
    )
    const start = started.find(({ entry }) => entry.kind === 'act.started')
    const actId = start?.entry.kind === 'act.started' ? start.entry.act.actId : undefined
    expect(actId).toBeDefined()
    await expect(harness.runtime.cancelAct(actId!, 'operator cancellation')).resolves.toBe(true)
    resolveResult?.({
      kind: 'proposed',
      proposal: {
        effects: [
          {
            kind: 'state.patch',
            operation: 'add',
            path: '/workingField/late',
            protocolVersion: 1,
            value: true
          }
        ],
        protocolVersion: 1,
        settlement: 'effects'
      },
      proposalHash: canonicalHash({
        effects: [
          {
            kind: 'state.patch',
            operation: 'add',
            path: '/workingField/late',
            protocolVersion: 1,
            value: true
          }
        ],
        protocolVersion: 1,
        settlement: 'effects'
      })
    })
    await harness.runtime.waitForIdle()

    const records = await harness.runtime.journal()
    const kinds = records.map(({ entry }) => entry.kind)
    expect(kinds.indexOf('act.cancel-requested')).toBeLessThan(kinds.indexOf('act.late-output-diagnostic'))
    expect(records.some(({ entry }) => entry.kind === 'effect.decision')).toBe(false)
    const terminal = records.find(({ entry }) => entry.kind === 'act.terminal')
    expect(terminal?.entry).toMatchObject({ terminal: { status: 'cancelled' } })
    expect((await harness.store.loadSnapshot()).stateVersion).toBe(0)
  })
})
