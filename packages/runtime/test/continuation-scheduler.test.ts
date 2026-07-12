import { canonicalHash } from '@nox/protocol'
import type { ActProposal } from '@nox/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeHarness } from './support/runtime-harness.js'
import { createHarness, deliver } from './support/runtime-harness.js'

const harnesses: RuntimeHarness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.dispose()
  }
})

const proposed = (proposal: ActProposal) => ({
  kind: 'proposed' as const,
  proposal,
  proposalHash: canonicalHash(proposal)
})

describe('ContinuationScheduler', () => {
  it('fires a due Continuation once, advances State, and causes a new Act', async () => {
    const schedule: ActProposal = {
      effects: [
        {
          kind: 'continuation.schedule',
          protocolVersion: 1,
          seed: {
            due: { at: '2026-07-12T09:00:00.000Z', kind: 'at-time' },
            instruction: 'Return to the first contact.',
            label: 'first-contact-return',
            maxFireCount: 1,
            protocolVersion: 1
          }
        }
      ],
      protocolVersion: 1,
      settlement: 'effects'
    }
    const silent: ActProposal = { effects: [], protocolVersion: 1, settlement: 'silent' }
    const harness = await createHarness([proposed(schedule), proposed(silent)])
    harnesses.push(harness)

    await deliver(harness.runtime)
    await harness.runtime.waitForIdle()
    expect((await harness.store.loadSnapshot()).state.openContinuations).toHaveLength(1)
    expect((await harness.store.loadSnapshot()).stateVersion).toBe(1)

    harness.clock.advanceTo('2026-07-12T09:00:00.000Z')
    const fired = await harness.runtime.fireDueContinuations()
    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatchObject({ admission: 'admitted', kind: 'continuation' })
    await harness.runtime.waitForIdle()

    const snapshot = await harness.store.loadSnapshot()
    expect(snapshot.stateVersion).toBe(2)
    expect(snapshot.state.openContinuations).toEqual([])
    expect(harness.cortex.inputs).toHaveLength(2)
    expect(await harness.runtime.fireDueContinuations()).toEqual([])
    const records = await harness.runtime.journal()
    expect(
      records.filter(
        ({ entry }) => entry.kind === 'effect.decision' && entry.decision.effect.kind === 'continuation.fire'
      )
    ).toHaveLength(1)
  })
})
