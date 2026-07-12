import {
  canonicalHash,
  canonicalize,
  canonicalStringify,
  CORTEX_INPUT_BUILDER_VERSION,
  CORTEX_INPUT_SCHEMA_VERSION,
  cortexBoundsSchema,
  cortexInputSchema,
  eventSchema,
  instantSchema,
  journalRecordSchema,
  PROTOCOL_VERSION,
  stateSnapshotSchema
} from '@nox/protocol'
import type { CortexBounds, CortexInput, Event, JournalRecord, StateSnapshot } from '@nox/protocol'

export interface BuildCortexInputOptions {
  actId: string
  bounds: CortexBounds
  journal: JournalRecord[]
  observedAt: string
  state: StateSnapshot
  triggerEvent: Event
}

export interface BuiltCortexInput {
  input: CortexInput
  inputHash: string
  serialized: string
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareJournal(left: JournalRecord, right: JournalRecord): number {
  return left.sequence - right.sequence || compareText(left.recordId, right.recordId)
}

export function buildCortexInput(options: BuildCortexInputOptions): BuiltCortexInput {
  const state = stateSnapshotSchema.parse(options.state)
  const triggerEvent = eventSchema.parse(options.triggerEvent)
  const observedAt = instantSchema.parse(options.observedAt)
  const bounds = cortexBoundsSchema.parse(options.bounds)
  const journal = options.journal.map(record => journalRecordSchema.parse(record)).sort(compareJournal)
  const sequenceSet = new Set(journal.map(({ sequence }) => sequence))
  if (sequenceSet.size !== journal.length) {
    throw new Error('CortexInput cannot contain duplicate Journal sequences')
  }

  const selectedJournal = bounds.maxJournalRecords === 0 ? [] : journal.slice(-bounds.maxJournalRecords)
  const observedMilliseconds = Date.parse(observedAt)
  const anchorMilliseconds = Date.parse(state.state.temporalAnchor.lastObservedAt)
  const rawClockDeltaMilliseconds = observedMilliseconds - anchorMilliseconds
  const clockRelation =
    rawClockDeltaMilliseconds > 0
      ? ('forward' as const)
      : rawClockDeltaMilliseconds < 0
        ? ('regressed' as const)
        : ('same' as const)

  const input = cortexInputSchema.parse({
    actId: options.actId,
    bounds,
    builderVersion: CORTEX_INPUT_BUILDER_VERSION,
    cortex: state.state.cortex,
    identity: state.state.identity,
    inputSchemaVersion: CORTEX_INPUT_SCHEMA_VERSION,
    journalContext: selectedJournal.map(record => ({
      causal: record.causal,
      entryKind: record.entry.kind,
      payload: canonicalize(record.entry),
      provenance: record.provenance,
      recordId: record.recordId,
      recordedAt: record.recordedAt,
      sequence: record.sequence
    })),
    openContinuations: [...state.state.openContinuations].sort(
      (left, right) =>
        compareText(left.seed.due.at, right.seed.due.at) || compareText(left.continuationId, right.continuationId)
    ),
    picture: state.state.picture,
    protocolVersion: PROTOCOL_VERSION,
    standingPolicies: [...state.state.standingPolicies].sort((left, right) =>
      compareText(left.policyId, right.policyId)
    ),
    stateRef: {
      stateHash: state.stateHash,
      stateVersion: state.stateVersion,
      throughSequence: state.throughSequence
    },
    temporal: {
      clockRelation,
      elapsedMilliseconds: Math.max(0, rawClockDeltaMilliseconds),
      observedAt,
      rawClockDeltaMilliseconds
    },
    temporalAnchor: state.state.temporalAnchor,
    triggerEvent,
    workingField: state.state.workingField
  })
  const serialized = canonicalStringify(input)
  return { input, inputHash: canonicalHash(input), serialized }
}
