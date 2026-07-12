import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalHash, stateSnapshotSchema } from '@nox/protocol'
import type { ActProposalResult, CortexInput, FoundationState, JournalRecord, StateSnapshot } from '@nox/protocol'

import { SqliteStore } from '../../../store-sqlite/src/index.js'
import { createRuntime } from '../../src/index.js'
import type { ClockPort, CortexPort, NoxRuntime } from '../../src/index.js'

export const runtimeAt = '2026-07-12T08:00:00.000Z'

export class MutableClock implements ClockPort {
  #current = runtimeAt

  advanceTo(value: string): void {
    this.#current = value
  }

  now(): string {
    return this.#current
  }
}

export class ScriptedCortex implements CortexPort {
  readonly inputs: CortexInput[] = []
  readonly #handler: (input: CortexInput, signal: AbortSignal, call: number) => Promise<ActProposalResult>

  constructor(
    handler:
      | ActProposalResult[]
      | ((input: CortexInput, signal: AbortSignal, call: number) => Promise<ActProposalResult>)
  ) {
    this.#handler = Array.isArray(handler)
      ? async (_input, _signal, call) => {
          const result = handler[call]
          if (result === undefined) {
            throw new Error(`No scripted Cortex result for call ${call}`)
          }
          return result
        }
      : handler
  }

  async runAct(input: CortexInput, signal: AbortSignal): Promise<ActProposalResult> {
    const call = this.inputs.length
    this.inputs.push(input)
    return this.#handler(input, signal, call)
  }
}

export interface RuntimeHarness {
  clock: MutableClock
  cortex: ScriptedCortex
  dispose: () => void
  path: string
  runtime: NoxRuntime
  store: SqliteStore
}

export function foundationState(): FoundationState {
  return {
    cortex: {
      adapter: 'pi',
      configHash: `sha256:${'b'.repeat(64)}`,
      cortexId: 'pi-primary',
      modelId: 'test-model',
      packageVersion: '0.80.6'
    },
    identity: {
      conceptDocument: 'NOX-CONVERGENCE.md',
      identityId: 'nox',
      revision: `sha256:${'a'.repeat(64)}`
    },
    openContinuations: [],
    picture: {},
    schemaVersions: { journal: 1, protocol: 1, state: 1 },
    standingPolicies: [
      {
        adoptedAt: runtimeAt,
        kind: 'attention.every-delivered-event',
        policyId: 'foundation-attention',
        provenance: { source: 'inherited', sourceDocument: 'NOX-CONVERGENCE.md' },
        status: 'active',
        version: 1
      }
    ],
    temporalAnchor: { lastObservedAt: runtimeAt, logicalTick: 0 },
    workingField: {}
  }
}

export function foundationSnapshot(state = foundationState()): StateSnapshot {
  return stateSnapshotSchema.parse({
    state,
    stateHash: canonicalHash(state),
    stateVersion: 0,
    throughSequence: 0
  })
}

export async function createHarness(
  script: ActProposalResult[] | ((input: CortexInput, signal: AbortSignal, call: number) => Promise<ActProposalResult>),
  state = foundationState()
): Promise<RuntimeHarness> {
  const root = mkdtempSync(join(tmpdir(), 'nox-runtime-'))
  const path = join(root, 'nox.sqlite')
  const clock = new MutableClock()
  const cortex = new ScriptedCortex(script)
  const store = new SqliteStore(path, { now: () => clock.now() })
  await store.initialize(foundationSnapshot(state))
  let id = 0
  const runtime = createRuntime({
    clock,
    cortex,
    idFactory: () => `runtime-id-${(id += 1)}`,
    store
  })
  return {
    clock,
    cortex,
    dispose: () => {
      store.close()
      rmSync(root, { force: true, recursive: true })
    },
    path,
    runtime,
    store
  }
}

export async function deliver(runtime: NoxRuntime, clientEventId = 'client-event-001') {
  const receipt = await runtime.appendEvent({
    clientEventId,
    content: 'Привет, Nox.',
    format: 'text',
    interfaceOwnerId: 'eiji-local'
  })
  await runtime.releaseEvent(receipt.eventId)
  return receipt
}

export async function waitForJournal(
  runtime: NoxRuntime,
  predicate: (records: JournalRecord[]) => boolean
): Promise<JournalRecord[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const records = await runtime.journal()
    if (predicate(records)) {
      return records
    }
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for Journal condition')
}
