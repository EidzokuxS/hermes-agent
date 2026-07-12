import { NoxRpcClient } from '@nox/interface-rpc'
import { canonicalHash } from '@nox/protocol'
import { describe, expect, it } from 'vitest'

import { createHarness } from '../../../packages/runtime/test/support/runtime-harness.js'
import { createProcessHost } from '../src/create-process-host.js'

describe('runtime process host transport', () => {
  it('carries direct and reconnect receipt handshakes through the same runtime', async () => {
    const proposal = { effects: [], protocolVersion: 1, settlement: 'silent' } as const
    const harness = await createHarness([
      { kind: 'proposed', proposal, proposalHash: canonicalHash(proposal) },
      { kind: 'proposed', proposal, proposalHash: canonicalHash(proposal) }
    ])
    const host = await createProcessHost({
      interfaceOwnerId: 'eiji-local',
      launchToken: 'test-launch-token',
      runtime: harness.runtime
    })
    const client = new NoxRpcClient({
      launchToken: 'test-launch-token',
      url: `ws://127.0.0.1:${host.port}`
    })
    try {
      const direct = await client.call({
        method: 'event.append',
        params: {
          clientEventId: 'direct-event',
          content: { content: 'direct', format: 'text', kind: 'message' },
          protocolVersion: 1
        }
      })
      expect(direct).toMatchObject({ receipt: { clientEventId: 'direct-event' } })
      await harness.runtime.waitForIdle()

      const unresolved = await harness.runtime.appendEvent({
        clientEventId: 'reconnect-event',
        content: 'recover after reconnect',
        format: 'text',
        interfaceOwnerId: 'eiji-local'
      })
      const view = await client.call({ method: 'view.snapshot', params: { protocolVersion: 1 } })
      expect(view).toMatchObject({ unresolvedReceipts: [unresolved] })
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await harness.runtime.journal()).filter(({ entry }) => entry.kind === 'act.started').length === 2) {
          break
        }
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      await harness.runtime.waitForIdle()
      const records = await harness.runtime.journal()
      expect(records.filter(({ entry }) => entry.kind === 'event.recorded')).toHaveLength(2)
      expect(records.filter(({ entry }) => entry.kind === 'event.admitted')).toHaveLength(2)
      expect(records.filter(({ entry }) => entry.kind === 'act.started')).toHaveLength(2)
      expect(records.filter(({ entry }) => entry.kind === 'act.terminal')).toHaveLength(2)
    } finally {
      await client.close()
      await host.close()
      harness.dispose()
    }
  })
})
