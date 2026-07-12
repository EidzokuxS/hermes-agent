import { canonicalHash, journalRecordSchema, PROTOCOL_VERSION, stateSnapshotSchema } from '@nox/protocol'
import type {
  EffectDecision,
  ExternalEvent,
  FoundationState,
  JournalRecord,
  JournalRecordInput,
  StateSnapshot
} from '@nox/protocol'

import type { BuildCortexInputOptions } from '../../src/index.js'

export const fixtureAt = '2026-07-12T08:00:00.000Z'
export const fixtureObservedAt = '2026-07-12T08:01:00.000Z'
export const runtimeProvenance = { component: 'runtime-fixture', kind: 'runtime' } as const

export function createFoundationState(): FoundationState {
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
    picture: { knownRelation: 'Eiji' },
    schemaVersions: { journal: 1, protocol: 1, state: 1 },
    standingPolicies: [
      {
        adoptedAt: fixtureAt,
        kind: 'attention.every-delivered-event',
        policyId: 'foundation-attention',
        provenance: { source: 'inherited', sourceDocument: 'NOX-CONVERGENCE.md' },
        status: 'active',
        version: 1
      }
    ],
    temporalAnchor: { lastObservedAt: fixtureAt, logicalTick: 0 },
    workingField: { focus: 'first contact' }
  }
}

export function createSnapshot(state = createFoundationState(), stateVersion = 0): StateSnapshot {
  return stateSnapshotSchema.parse({
    state,
    stateHash: canonicalHash(state),
    stateVersion,
    throughSequence: stateVersion === 0 ? 0 : stateVersion * 10
  })
}

export function createExternalEvent(admission: 'admitted' | 'recorded' = 'admitted'): ExternalEvent {
  return {
    admission,
    clientEventId: 'client-event-001',
    content: { content: 'Привет, Nox.', format: 'text', kind: 'message' },
    eventId: 'event-001',
    interfaceOwnerId: 'eiji-local',
    kind: 'external',
    occurredAt: fixtureAt,
    protocolVersion: PROTOCOL_VERSION,
    provenance: {
      clientEventId: 'client-event-001',
      interfaceOwnerId: 'eiji-local',
      kind: 'external-interface'
    }
  }
}

export function createJournalRecord(sequence: number, entry: JournalRecordInput['entry']): JournalRecord {
  const hashInput = {
    causal: { causeSequences: [], eventId: 'event-001' },
    entry,
    journalSchemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    provenance: runtimeProvenance,
    recordedAt: fixtureAt,
    recordId: `record-${sequence}`,
    sequence
  }
  return journalRecordSchema.parse({ ...hashInput, recordHash: canonicalHash(hashInput) })
}

export function createInputOptions(): BuildCortexInputOptions {
  const recorded = createJournalRecord(1, {
    event: createExternalEvent('recorded'),
    kind: 'event.recorded'
  })
  const admitted = createJournalRecord(2, { eventId: 'event-001', kind: 'event.admitted' })
  return {
    actId: 'act-001',
    bounds: {
      allowedEffectKinds: ['continuation.cancel', 'continuation.schedule', 'emission.append', 'state.patch'],
      allowedStateRoots: ['/picture', '/workingField'],
      maxEffects: 8,
      maxJournalRecords: 16,
      maxOutputTokens: 2048,
      timeoutMilliseconds: 30_000
    },
    journal: [admitted, recorded],
    observedAt: fixtureObservedAt,
    state: createSnapshot(),
    triggerEvent: createExternalEvent('admitted')
  }
}

export function acceptedDecision(
  effect: EffectDecision['effect'],
  ordinal: number,
  effectId = `effect-${ordinal}`
): EffectDecision {
  return {
    actId: 'act-001',
    decidedAt: fixtureObservedAt,
    decision: 'accepted',
    effect,
    effectId,
    ordinal,
    provenance: runtimeProvenance,
    stateChanging: effect.kind !== 'emission.append'
  }
}
