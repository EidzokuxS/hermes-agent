import { canonicalHash, journalRecordSchema, stateSnapshotSchema } from '@nox/protocol'
import type { EventReceipt, JournalRecord, JournalRecordInput, StateSnapshot } from '@nox/protocol'
import { describe, expect, it } from 'vitest'

import { NoxRpcClient, NoxRpcServer, parseRpcResponse, RpcSession } from '../src/index.js'
import type { OrderedConnection, RpcRuntimePort } from '../src/index.js'

const at = '2026-07-12T08:00:00.000Z'
const receipt: EventReceipt = {
  clientEventId: 'client-001',
  eventId: 'event-001',
  interfaceOwnerId: 'eiji-local',
  journalSequence: 1,
  protocolVersion: 1,
  recordedAt: at,
  stateVersion: 0
}

function snapshot(): StateSnapshot {
  const state = {
    cortex: {
      adapter: 'pi' as const,
      configHash: `sha256:${'b'.repeat(64)}`,
      cortexId: 'pi-primary',
      modelId: 'test-model',
      packageVersion: '0.80.6' as const
    },
    identity: {
      conceptDocument: 'NOX-CONVERGENCE.md' as const,
      identityId: 'nox' as const,
      revision: `sha256:${'a'.repeat(64)}`
    },
    openContinuations: [],
    picture: {},
    schemaVersions: { journal: 1 as const, protocol: 1 as const, state: 1 as const },
    standingPolicies: [
      {
        adoptedAt: at,
        kind: 'attention.every-delivered-event' as const,
        policyId: 'foundation-attention',
        provenance: {
          source: 'inherited' as const,
          sourceDocument: 'NOX-CONVERGENCE.md' as const
        },
        status: 'active' as const,
        version: 1 as const
      }
    ],
    temporalAnchor: { lastObservedAt: at, logicalTick: 0 },
    workingField: {}
  }
  return stateSnapshotSchema.parse({
    state,
    stateHash: canonicalHash(state),
    stateVersion: 0,
    throughSequence: 0
  })
}

function record(sequence: number, entry: JournalRecordInput['entry']): JournalRecord {
  const hashInput = {
    causal: { causeSequences: [], eventId: 'event-001' },
    entry,
    journalSchemaVersion: 1,
    protocolVersion: 1,
    provenance: { component: 'rpc-test', kind: 'runtime' },
    recordedAt: at,
    recordId: `record-${sequence}`,
    sequence
  }
  return journalRecordSchema.parse({ ...hashInput, recordHash: canonicalHash(hashInput) })
}

class FakeRuntime implements RpcRuntimePort {
  readonly order: string[] = []
  appendError?: Error
  journalRecords: JournalRecord[] = []
  releaseError?: Error
  unresolved: EventReceipt[] = []

  async appendEvent(): Promise<EventReceipt> {
    this.order.push('record')
    if (this.appendError !== undefined) {
      throw this.appendError
    }
    return receipt
  }

  async cancelAct(): Promise<boolean> {
    this.order.push('cancel')
    return true
  }

  async journal(afterSequence = 0): Promise<JournalRecord[]> {
    return this.journalRecords.filter(({ sequence }) => sequence > afterSequence)
  }

  async journalTail(limit = 4_096): Promise<JournalRecord[]> {
    return this.journalRecords.slice(-limit)
  }

  async releaseEvent(eventId: string): Promise<void> {
    this.order.push(`release:${eventId}`)
    if (this.releaseError !== undefined) {
      throw this.releaseError
    }
  }

  async snapshot(): Promise<StateSnapshot> {
    return snapshot()
  }

  async unresolvedReceipts(): Promise<EventReceipt[]> {
    return this.unresolved
  }
}

class TestConnection implements OrderedConnection {
  readonly frames: string[] = []
  readonly order: string[]
  sendError?: Error

  constructor(order: string[]) {
    this.order = order
  }

  close(): void {}

  async sendText(text: string): Promise<void> {
    this.order.push('flush')
    if (this.sendError !== undefined) {
      throw this.sendError
    }
    this.frames.push(text)
  }
}

function request(method: string, params: Record<string, unknown>, id = 'request-1'): string {
  return JSON.stringify({ id, jsonrpc: '2.0', method, params })
}

function appendRequest(protocolVersion = 1): string {
  return request('event.append', {
    clientEventId: 'client-001',
    content: { content: 'Привет, Nox.', format: 'text', kind: 'message' },
    protocolVersion
  })
}

describe('ordered RPC session', () => {
  it('flushes the durable receipt before release', async () => {
    const runtime = new FakeRuntime()
    const connection = new TestConnection(runtime.order)
    const session = new RpcSession({ connection, interfaceOwnerId: 'eiji-local', runtime })

    await session.handleText(appendRequest())
    expect(runtime.order).toEqual(['record', 'flush', 'release:event-001'])
    const frame = parseRpcResponse(connection.frames[0]!)
    expect(frame).toMatchObject({ id: 'request-1', result: { receipt } })
  })

  it('never releases when record or response flush fails', async () => {
    const recordFailure = new FakeRuntime()
    recordFailure.appendError = new Error('record failed')
    const recordConnection = new TestConnection(recordFailure.order)
    await new RpcSession({
      connection: recordConnection,
      interfaceOwnerId: 'eiji-local',
      runtime: recordFailure
    }).handleText(appendRequest())
    expect(recordFailure.order).toEqual(['record', 'flush'])

    const flushFailure = new FakeRuntime()
    const flushConnection = new TestConnection(flushFailure.order)
    flushConnection.sendError = new Error('flush failed')
    await expect(
      new RpcSession({
        connection: flushConnection,
        interfaceOwnerId: 'eiji-local',
        runtime: flushFailure
      }).handleText(appendRequest())
    ).rejects.toThrow('flush failed')
    expect(flushFailure.order).toEqual(['record', 'flush', 'flush'])
    expect(flushFailure.order.some(item => item.startsWith('release'))).toBe(false)
  })

  it('does not emit a second response when release fails after a successful flush', async () => {
    const runtime = new FakeRuntime()
    runtime.releaseError = new Error('release failed')
    const connection = new TestConnection(runtime.order)
    await expect(
      new RpcSession({ connection, interfaceOwnerId: 'eiji-local', runtime }).handleText(appendRequest())
    ).rejects.toThrow('release failed')
    expect(connection.frames).toHaveLength(1)
  })

  it('flushes reconnect snapshot receipts before releasing them', async () => {
    const runtime = new FakeRuntime()
    runtime.unresolved = [receipt]
    const connection = new TestConnection(runtime.order)
    const session = new RpcSession({ connection, interfaceOwnerId: 'eiji-local', runtime })
    await session.handleText(request('view.snapshot', { protocolVersion: 1 }))
    expect(runtime.order).toEqual(['flush', 'release:event-001'])
    expect(parseRpcResponse(connection.frames[0]!)).toMatchObject({
      result: { unresolvedReceipts: [receipt] }
    })
  })

  it('rejects incompatible protocol before runtime access', async () => {
    const runtime = new FakeRuntime()
    const connection = new TestConnection(runtime.order)
    await new RpcSession({ connection, interfaceOwnerId: 'eiji-local', runtime }).handleText(appendRequest(2))
    expect(runtime.order).toEqual(['flush'])
    expect(parseRpcResponse(connection.frames[0]!)).toMatchObject({
      error: { code: -32_001 }
    })
  })

  it('replays typed interface notifications from a Journal cursor', async () => {
    const runtime = new FakeRuntime()
    runtime.journalRecords = [
      record(1, { eventId: 'event-001', kind: 'event.admitted' }),
      record(2, { kind: 'state.advanced', stateHash: `sha256:${'f'.repeat(64)}`, stateVersion: 1 }),
      record(3, {
        decision: {
          actId: 'act-001',
          decidedAt: at,
          decision: 'accepted',
          effect: {
            kind: 'continuation.schedule',
            protocolVersion: 1,
            seed: {
              due: { at: '2026-07-12T09:00:00.000Z', kind: 'at-time' },
              instruction: 'Re-enter once.',
              label: 'C1',
              maxFireCount: 1,
              protocolVersion: 1
            }
          },
          effectId: 'effect-c1',
          ordinal: 0,
          provenance: { component: 'rpc-test', kind: 'runtime' },
          stateChanging: true
        },
        kind: 'effect.decision'
      })
    ]
    const connection = new TestConnection(runtime.order)
    await new RpcSession({ connection, interfaceOwnerId: 'eiji-local', runtime }).handleText(
      request('journal.subscribe', { afterSequence: 0, protocolVersion: 1 })
    )
    expect(connection.frames).toHaveLength(4)
    expect(parseRpcResponse(connection.frames[1]!)).toMatchObject({
      method: 'nox.event',
      params: { journalSequence: 1, kind: 'event.admitted' }
    })
    expect(parseRpcResponse(connection.frames[2]!)).toMatchObject({
      method: 'nox.event',
      params: { journalSequence: 2, kind: 'state.advanced' }
    })
    expect(parseRpcResponse(connection.frames[3]!)).toMatchObject({
      method: 'nox.event',
      params: {
        continuation: { originActId: 'act-001', seed: { label: 'C1' }, status: 'open' },
        journalSequence: 3,
        kind: 'continuation.changed'
      }
    })
  })
})

describe('loopback WebSocket authentication', () => {
  it('accepts only the launch token and carries a domain call', async () => {
    const runtime = new FakeRuntime()
    const server = new NoxRpcServer({
      interfaceOwnerId: 'eiji-local',
      launchToken: 'one-time-secret',
      runtime
    })
    const port = await server.ready()
    const client = new NoxRpcClient({
      launchToken: 'one-time-secret',
      url: `ws://127.0.0.1:${port}`
    })
    const result = await client.call({
      method: 'event.append',
      params: {
        clientEventId: 'client-001',
        content: { content: 'Привет, Nox.', format: 'text', kind: 'message' },
        protocolVersion: 1
      }
    })
    expect(result).toMatchObject({ receipt })
    await client.close()
    await server.close()
  })
})
