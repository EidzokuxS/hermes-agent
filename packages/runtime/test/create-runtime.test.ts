import { canonicalHash } from '@nox/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeHarness } from './support/runtime-harness.js'
import { createHarness } from './support/runtime-harness.js'

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
})
