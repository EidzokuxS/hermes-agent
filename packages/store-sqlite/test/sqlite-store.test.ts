import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { canonicalHash, PROTOCOL_VERSION, stateSnapshotSchema } from '@nox/protocol'
import type {
  CommitCommand,
  ExternalEvent,
  FoundationState,
  JournalRecord,
  JournalRecordInput,
  StateSnapshot
} from '@nox/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import { SqliteAuditReader, SqliteStore } from '../src/index.js'
import type { FaultStage } from '../src/index.js'

const roots: string[] = []
const stores: SqliteStore[] = []
const at = '2026-07-12T08:00:00.000Z'
const runtimeProvenance = { component: 'store-test', kind: 'runtime' } as const

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close()
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

function openStore(path: string, options: ConstructorParameters<typeof SqliteStore>[1] = {}): SqliteStore {
  const store = new SqliteStore(path, options)
  stores.push(store)
  return store
}

function createPath(name = 'nox.sqlite'): string {
  const root = mkdtempSync(join(tmpdir(), 'nox-store-'))
  roots.push(root)
  return join(root, name)
}

function initialState(overrides: Partial<FoundationState> = {}): FoundationState {
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
        adoptedAt: at,
        kind: 'attention.every-delivered-event',
        policyId: 'foundation-attention',
        provenance: { source: 'inherited', sourceDocument: 'NOX-CONVERGENCE.md' },
        status: 'active',
        version: 1
      }
    ],
    temporalAnchor: { lastObservedAt: at, logicalTick: 0 },
    workingField: {},
    ...overrides
  }
}

function initialSnapshot(state = initialState()): StateSnapshot {
  return stateSnapshotSchema.parse({
    state,
    stateHash: canonicalHash(state),
    stateVersion: 0,
    throughSequence: 0
  })
}

function externalEvent(content = 'Привет, Nox.'): ExternalEvent {
  return {
    admission: 'recorded',
    clientEventId: 'client-event-001',
    content: { content, format: 'text', kind: 'message' },
    eventId: 'event-001',
    interfaceOwnerId: 'eiji-local',
    kind: 'external',
    occurredAt: at,
    protocolVersion: PROTOCOL_VERSION,
    provenance: {
      clientEventId: 'client-event-001',
      interfaceOwnerId: 'eiji-local',
      kind: 'external-interface'
    }
  }
}

function journal(entry: JournalRecordInput['entry'], eventId = 'event-001'): JournalRecordInput {
  return {
    causal: { causeSequences: [], eventId },
    entry,
    journalSchemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    provenance: runtimeProvenance,
    recordedAt: at
  }
}

function stateChangeCommand(state: FoundationState, commandId = 'command-state-change'): CommitCommand {
  const nextState: FoundationState = {
    ...state,
    temporalAnchor: { lastObservedAt: at, logicalTick: state.temporalAnchor.logicalTick + 1 },
    workingField: { ...state.workingField, focus: 'first-loop' }
  }
  const stateHash = canonicalHash(nextState)
  const decision = {
    actId: 'act-001',
    decidedAt: at,
    decision: 'accepted',
    effect: {
      kind: 'state.patch',
      operation: 'add',
      path: '/workingField/focus',
      protocolVersion: 1,
      value: 'first-loop'
    },
    effectId: 'effect-001',
    ordinal: 0,
    provenance: runtimeProvenance,
    stateChanging: true
  } as const
  return {
    commandId,
    expectedStateVersion: 0,
    nextSnapshot: { state: nextState, stateHash, stateVersion: 1 },
    protocolVersion: PROTOCOL_VERSION,
    records: [
      journal({ decision, kind: 'effect.decision' }),
      journal({ kind: 'state.advanced', stateHash, stateVersion: 1 }),
      journal({
        kind: 'act.terminal',
        terminal: {
          actId: 'act-001',
          completedAt: at,
          effectDecisionIds: ['effect-001'],
          protocolVersion: 1,
          stateVersion: 1,
          status: 'completed-effects'
        }
      })
    ]
  }
}

async function collectJournal(store: SqliteStore): Promise<JournalRecord[]> {
  const records: JournalRecord[] = []
  for await (const record of store.readJournal()) {
    records.push(record)
  }
  return records
}

describe('SQLite foundation', () => {
  it('applies the strict migration and required durability configuration', async () => {
    const store = openStore(createPath(), { now: () => at })
    await store.initialize(initialSnapshot())

    expect(store.configuration()).toEqual({
      foreignKeys: 1,
      journalMode: 'wal',
      synchronous: 2,
      trustedSchema: 0
    })
    expect((await store.loadSnapshot()).stateVersion).toBe(0)
    store.close()
  })

  it('reopens with the same canonical State hash', async () => {
    const path = createPath()
    const first = openStore(path, { now: () => at })
    const initialized = await first.initialize(initialSnapshot())
    first.close()

    const reopened = openStore(path, { now: () => at })
    expect(await reopened.loadSnapshot()).toEqual(initialized)
    reopened.close()
  })

  it('returns the original external Event receipt and releases admission idempotently', async () => {
    let nextId = 0
    const store = openStore(createPath(), {
      idFactory: () => `record-event-${(nextId += 1)}`,
      now: () => at
    })
    await store.initialize(initialSnapshot())
    const event = externalEvent()

    const first = await store.recordExternalEvent(event)
    const retry = await store.recordExternalEvent(event)
    expect(retry).toEqual(first)
    expect(await store.getUnresolvedReceipts('eiji-local')).toEqual([first])
    await expect(store.recordExternalEvent(externalEvent('different content'))).rejects.toThrow(
      'clientEventId was reused'
    )

    const admission: CommitCommand = {
      commandId: 'admit:event-001',
      expectedStateVersion: 0,
      protocolVersion: 1,
      records: [journal({ eventId: event.eventId, kind: 'event.admitted' })]
    }
    const admitted = await store.transact(admission)
    expect(await store.transact(admission)).toEqual(admitted)
    expect(await store.getUnresolvedReceipts('eiji-local')).toEqual([])

    await expect(store.transact({ ...admission, commandId: 'admit:event-001-again' })).rejects.toThrow()
    expect(await collectJournal(store)).toHaveLength(2)
    store.close()
  })

  it('returns an explicit newest-first Journal tail without freezing at the oldest records', async () => {
    let nextId = 0
    const path = createPath()
    const store = openStore(path, {
      idFactory: () => `record-tail-${(nextId += 1)}`,
      now: () => at
    })
    await store.initialize(initialSnapshot())
    await store.transact({
      commandId: 'journal-tail-boundary',
      expectedStateVersion: 0,
      protocolVersion: 1,
      records: Array.from({ length: 70 }, (_, index) =>
        journal({ actId: `act-${index + 1}`, kind: 'act.cancel-requested', reason: `reason-${index + 1}` })
      )
    })

    const tail: JournalRecord[] = []
    for await (const record of store.readJournal({ limit: 64, order: 'descending' })) {
      tail.push(record)
    }
    expect(tail.map(({ sequence }) => sequence)).toEqual(Array.from({ length: 64 }, (_, index) => 70 - index))
    store.close()
    const audit = new SqliteAuditReader(path)
    expect(audit.readAllJournal({ pageSize: 17 }).map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: 70 }, (_, index) => index + 1)
    )
    audit.close()
  })

  it('commits Journal and State atomically, then reopens at the exact cursor', async () => {
    const path = createPath()
    let nextId = 0
    const store = openStore(path, {
      idFactory: () => `record-${(nextId += 1)}`,
      now: () => at
    })
    const state = initialState()
    await store.initialize(initialSnapshot(state))

    const receipt = await store.transact(stateChangeCommand(state))
    expect(receipt).toMatchObject({
      firstSequence: 1,
      lastSequence: 3,
      snapshotAdvanced: true,
      stateVersion: 1
    })
    const snapshot = await store.loadSnapshot()
    expect(snapshot.throughSequence).toBe(3)
    expect(snapshot.stateHash).toBe(receipt.stateHash)
    await expect(store.transact(stateChangeCommand(state, 'command-stale-state-change'))).rejects.toThrow(
      'Stale State version'
    )
    store.close()

    const reopened = openStore(path, { now: () => at })
    expect((await reopened.loadSnapshot()).stateHash).toBe(receipt.stateHash)
    expect(await collectJournal(reopened)).toHaveLength(3)
    reopened.close()

    const audit = new SqliteAuditReader(path)
    expect(audit.verifyStateHistory()).toEqual({
      journalRecords: 3,
      snapshots: 2,
      stateHash: receipt.stateHash,
      stateVersion: 1,
      throughSequence: 3
    })
    audit.close()
  })

  it.each<FaultStage>(['after-journal', 'before-snapshot', 'before-commit'])(
    'rolls back the complete causal commit on fault at %s',
    async faultStage => {
      let nextId = 0
      const store = openStore(createPath(), {
        faultInjector: stage => {
          if (stage === faultStage) {
            throw new Error(`fault:${stage}`)
          }
        },
        idFactory: () => `record-${faultStage}-${(nextId += 1)}`,
        now: () => at
      })
      const state = initialState()
      await store.initialize(initialSnapshot(state))

      await expect(store.transact(stateChangeCommand(state))).rejects.toThrow(`fault:${faultStage}`)
      expect((await store.loadSnapshot()).stateVersion).toBe(0)
      expect(await collectJournal(store)).toEqual([])
      store.close()
    }
  )

  it('enforces a single durable fire identity for each Continuation', async () => {
    const path = createPath()
    let nextId = 0
    const continuation = {
      continuationId: 'continuation-001',
      createdAt: at,
      fireCount: 0,
      originActId: 'act-scheduled',
      seed: {
        due: { at, kind: 'at-time' },
        instruction: 'Return to the open question.',
        label: 'open-question',
        maxFireCount: 1,
        protocolVersion: 1
      },
      status: 'open'
    } as const
    const state = initialState({ openContinuations: [continuation] })
    const store = openStore(path, {
      idFactory: () => `record-fire-${(nextId += 1)}`,
      now: () => at
    })
    await store.initialize(initialSnapshot(state))

    const fireCommand = (expectedStateVersion: number, stateVersion: number): CommitCommand => {
      const nextState: FoundationState = {
        ...state,
        openContinuations: [],
        temporalAnchor: { lastObservedAt: at, logicalTick: stateVersion }
      }
      const stateHash = canonicalHash(nextState)
      const firedEventId = 'event-continuation-001'
      return {
        commandId: `command-fire-${stateVersion}`,
        expectedStateVersion,
        nextSnapshot: { state: nextState, stateHash, stateVersion },
        protocolVersion: 1,
        records: [
          journal(
            {
              event: {
                admission: 'admitted',
                content: {
                  instruction: continuation.seed.instruction,
                  kind: 'continuation-fired',
                  label: continuation.seed.label
                },
                continuationId: continuation.continuationId,
                eventId: firedEventId,
                kind: 'continuation',
                occurredAt: at,
                protocolVersion: 1,
                provenance: {
                  continuationId: continuation.continuationId,
                  kind: 'continuation',
                  scheduledByActId: continuation.originActId
                }
              },
              kind: 'event.recorded'
            },
            firedEventId
          ),
          journal(
            {
              decision: {
                actId: 'runtime-continuation-fire',
                decidedAt: at,
                decision: 'accepted',
                effect: {
                  continuationId: continuation.continuationId,
                  firedAt: at,
                  kind: 'continuation.fire',
                  protocolVersion: 1
                },
                effectId: `effect-fire-${stateVersion}`,
                ordinal: 0,
                provenance: runtimeProvenance,
                stateChanging: true
              },
              kind: 'effect.decision'
            },
            firedEventId
          ),
          journal({ kind: 'state.advanced', stateHash, stateVersion }, firedEventId)
        ]
      }
    }

    await store.transact(fireCommand(0, 1))
    await expect(store.transact(fireCommand(1, 2))).rejects.toThrow('UNIQUE constraint failed')
    expect((await store.loadSnapshot()).stateVersion).toBe(1)
    expect(await collectJournal(store)).toHaveLength(3)
    store.close()
  })

  it('preserves a rejected Effect for an independent read-only auditor', async () => {
    const path = createPath()
    let nextId = 0
    const store = openStore(path, {
      idFactory: () => `record-${(nextId += 1)}`,
      now: () => at
    })
    await store.initialize(initialSnapshot())
    const rejectedDecision = {
      actId: 'act-rejected',
      code: 'policy-denied',
      decidedAt: at,
      decision: 'rejected',
      effect: {
        kind: 'state.patch',
        operation: 'replace',
        path: '/picture/name',
        protocolVersion: 1,
        value: 'someone-else'
      },
      effectId: 'effect-rejected',
      message: 'The inherited identity boundary is not model-writable',
      ordinal: 0,
      provenance: runtimeProvenance,
      stateChanging: false
    } as const
    await store.transact({
      commandId: 'command-rejected',
      expectedStateVersion: 0,
      protocolVersion: 1,
      records: [
        journal({ decision: rejectedDecision, kind: 'effect.decision' }),
        journal({
          kind: 'act.terminal',
          terminal: {
            actId: 'act-rejected',
            code: 'schema-invalid',
            completedAt: at,
            message: 'Effect rejected',
            protocolVersion: 1,
            stateVersion: 0,
            status: 'rejected'
          }
        })
      ]
    })
    const evidencePath = createPath('evidence.sqlite')
    await store.createEvidenceCopy(evidencePath)
    store.close()

    const audit = new SqliteAuditReader(evidencePath)
    expect(audit.integrityCheck()).toBe('ok')
    expect(audit.loadSnapshot().stateVersion).toBe(0)
    const rejected = audit.readRejectedEffects()
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.entry.kind).toBe('effect.decision')
    audit.close()
  })

  it('enforces append-only Journal, snapshot, and audit blob tables in SQLite itself', async () => {
    const path = createPath()
    const store = openStore(path, { idFactory: () => 'record-guard', now: () => at })
    await store.initialize(initialSnapshot())
    await store.recordExternalEvent(externalEvent())
    await store.putAuditBlob({
      bytes: Uint8Array.from([1, 2, 3]),
      createdAt: at,
      mediaType: 'application/octet-stream',
      provenance: runtimeProvenance
    })
    store.close()

    const audit = new SqliteAuditReader(path)
    expect(audit.readAuditBlobs()).toMatchObject([{ bytes: Uint8Array.from([1, 2, 3]) }])
    audit.close()

    const database = new DatabaseSync(path)
    expect(() => database.exec("UPDATE journal_records SET recorded_at = 'changed' WHERE sequence = 1")).toThrow(
      'append-only'
    )
    expect(() => database.exec('DELETE FROM journal_records WHERE sequence = 1')).toThrow('append-only')
    expect(() => database.exec('UPDATE state_snapshots SET through_sequence = 9')).toThrow('append-only')
    expect(() => database.exec('DELETE FROM audit_blobs')).toThrow('append-only')
    expect(() => database.exec("UPDATE schema_migrations SET name = 'changed' WHERE version = 1")).toThrow(
      'append-only'
    )
    database.close()
  })

  it('keeps multiple provenance links for identical content-addressed bytes', async () => {
    const path = createPath()
    const store = openStore(path, { now: () => at })
    await store.initialize(initialSnapshot())
    const bytes = Uint8Array.from([9, 8, 7])
    const first = await store.putAuditBlob({
      bytes,
      createdAt: at,
      mediaType: 'application/octet-stream',
      provenance: runtimeProvenance
    })
    const second = await store.putAuditBlob({
      bytes,
      createdAt: at,
      mediaType: 'application/octet-stream',
      provenance: {
        actId: 'act-001',
        cortexId: 'pi-primary',
        kind: 'cortex',
        modelId: 'test-model'
      }
    })
    expect(second.contentHash).toBe(first.contentHash)
    store.close()

    const audit = new SqliteAuditReader(path)
    expect(audit.getAuditBlobProvenances(first.contentHash)).toHaveLength(2)
    audit.close()
  })
})
