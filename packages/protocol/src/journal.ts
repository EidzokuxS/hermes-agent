import { z } from 'zod'

import { actProposalResultSchema, actStartedSchema, actTerminalSchema } from './act.js'
import { effectDecisionSchema } from './effect.js'
import { eventSchema } from './event.js'
import {
  boundedIdSchema,
  canonicalHash,
  causalLinksSchema,
  contentHashSchema,
  instantSchema,
  JOURNAL_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  provenanceSchema
} from './provenance.js'
import { pendingStateSnapshotSchema } from './state.js'

const eventRecordedEntrySchema = z
  .object({
    event: eventSchema,
    kind: z.literal('event.recorded')
  })
  .strict()
  .superRefine(({ event }, context) => {
    if (event.kind === 'external' && event.admission !== 'recorded') {
      context.addIssue({ code: 'custom', message: 'External Event must first be recorded' })
    }
  })

const eventAdmittedEntrySchema = z
  .object({
    eventId: boundedIdSchema,
    kind: z.literal('event.admitted')
  })
  .strict()

const actStartedEntrySchema = z
  .object({
    act: actStartedSchema,
    kind: z.literal('act.started')
  })
  .strict()

const cortexInputEntrySchema = z
  .object({
    actId: boundedIdSchema,
    blobHash: contentHashSchema,
    builderVersion: z.literal(1),
    kind: z.literal('cortex.input-recorded')
  })
  .strict()

const proposalObservedEntrySchema = z
  .object({
    actId: boundedIdSchema,
    kind: z.literal('act.proposal-observed'),
    result: actProposalResultSchema,
    resultBlobHash: contentHashSchema
  })
  .strict()

const effectDecisionEntrySchema = z
  .object({
    decision: effectDecisionSchema,
    kind: z.literal('effect.decision')
  })
  .strict()

const actTerminalEntrySchema = z
  .object({
    kind: z.literal('act.terminal'),
    terminal: actTerminalSchema
  })
  .strict()

const stateAdvancedEntrySchema = z
  .object({
    kind: z.literal('state.advanced'),
    stateHash: contentHashSchema,
    stateVersion: z.number().int().positive()
  })
  .strict()

const cancelRequestedEntrySchema = z
  .object({
    actId: boundedIdSchema,
    kind: z.literal('act.cancel-requested'),
    reason: z.string().min(1).max(512)
  })
  .strict()

const lateOutputEntrySchema = z
  .object({
    actId: boundedIdSchema,
    kind: z.literal('act.late-output-diagnostic'),
    outputHash: contentHashSchema
  })
  .strict()

const operationalFailureEntrySchema = z
  .object({
    code: z.literal('continuation-loop'),
    kind: z.literal('runtime.operational-failure'),
    message: z.string().min(1).max(1024)
  })
  .strict()

export const journalEntrySchema = z.discriminatedUnion('kind', [
  actStartedEntrySchema,
  actTerminalEntrySchema,
  cancelRequestedEntrySchema,
  cortexInputEntrySchema,
  effectDecisionEntrySchema,
  eventAdmittedEntrySchema,
  eventRecordedEntrySchema,
  lateOutputEntrySchema,
  operationalFailureEntrySchema,
  proposalObservedEntrySchema,
  stateAdvancedEntrySchema
])

export const journalRecordInputSchema = z
  .object({
    causal: causalLinksSchema,
    entry: journalEntrySchema,
    journalSchemaVersion: z.literal(JOURNAL_SCHEMA_VERSION),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    provenance: provenanceSchema,
    recordedAt: instantSchema
  })
  .strict()

export const journalRecordSchema = journalRecordInputSchema
  .extend({
    recordHash: contentHashSchema,
    recordId: boundedIdSchema,
    sequence: z.number().int().positive()
  })
  .superRefine((record, context) => {
    const { recordHash: _recordHash, ...hashInput } = record
    if (canonicalHash(hashInput) !== record.recordHash) {
      context.addIssue({ code: 'custom', message: 'Journal record hash does not match canonical record' })
    }
  })

export const commitCommandSchema = z
  .object({
    commandId: boundedIdSchema,
    expectedStateVersion: z.number().int().nonnegative(),
    nextSnapshot: pendingStateSnapshotSchema.optional(),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    records: z.array(journalRecordInputSchema).min(1).max(128)
  })
  .strict()
  .superRefine((command, context) => {
    const acceptedStateChanges = command.records.filter(({ entry }) => {
      return entry.kind === 'effect.decision' && entry.decision.decision === 'accepted' && entry.decision.stateChanging
    })
    const stateAdvanced = command.records.filter(({ entry }) => entry.kind === 'state.advanced')
    const expectedResultVersion = command.expectedStateVersion + (acceptedStateChanges.length > 0 ? 1 : 0)

    if (acceptedStateChanges.length > 0 && command.nextSnapshot === undefined) {
      context.addIssue({ code: 'custom', message: 'Accepted State-changing Effect requires a snapshot' })
    }
    if (acceptedStateChanges.length === 0 && command.nextSnapshot !== undefined) {
      context.addIssue({ code: 'custom', message: 'State cannot advance without an accepted State-changing Effect' })
    }
    if (command.nextSnapshot !== undefined && command.nextSnapshot.stateVersion !== expectedResultVersion) {
      context.addIssue({ code: 'custom', message: 'Snapshot must advance State by exactly one version' })
    }
    if (command.nextSnapshot === undefined && stateAdvanced.length !== 0) {
      context.addIssue({ code: 'custom', message: 'state.advanced requires a snapshot' })
    }
    if (command.nextSnapshot !== undefined) {
      if (stateAdvanced.length !== 1) {
        context.addIssue({ code: 'custom', message: 'Snapshot commit requires exactly one state.advanced record' })
      } else {
        const advanced = stateAdvanced[0]?.entry
        if (
          advanced?.kind !== 'state.advanced' ||
          advanced.stateHash !== command.nextSnapshot.stateHash ||
          advanced.stateVersion !== command.nextSnapshot.stateVersion
        ) {
          context.addIssue({ code: 'custom', message: 'state.advanced must identify the committed snapshot' })
        }
      }
    }
    for (const { entry } of command.records) {
      if (entry.kind === 'act.terminal' && entry.terminal.stateVersion !== expectedResultVersion) {
        context.addIssue({ code: 'custom', message: 'Act terminal must name the resulting State version' })
      }
    }
  })

export const commitReceiptSchema = z
  .object({
    commandId: boundedIdSchema,
    firstSequence: z.number().int().positive(),
    lastSequence: z.number().int().positive(),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    recordIds: z.array(boundedIdSchema).min(1).max(128),
    snapshotAdvanced: z.boolean(),
    stateHash: contentHashSchema,
    stateVersion: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.firstSequence > receipt.lastSequence) {
      context.addIssue({ code: 'custom', message: 'Commit receipt sequence range is inverted' })
    }
    if (receipt.lastSequence - receipt.firstSequence + 1 !== receipt.recordIds.length) {
      context.addIssue({ code: 'custom', message: 'Commit receipt record count does not match sequence range' })
    }
  })

export type CommitCommand = z.infer<typeof commitCommandSchema>
export type CommitReceipt = z.infer<typeof commitReceiptSchema>
export type JournalEntry = z.infer<typeof journalEntrySchema>
export type JournalRecord = z.infer<typeof journalRecordSchema>
export type JournalRecordInput = z.infer<typeof journalRecordInputSchema>
