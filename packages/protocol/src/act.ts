import { z } from 'zod'

import { proposedEffectSchema } from './effect.js'
import { boundedIdSchema, canonicalHash, contentHashSchema, instantSchema, PROTOCOL_VERSION } from './provenance.js'

export const cortexInputReferenceSchema = z
  .object({
    blobHash: contentHashSchema,
    builderVersion: z.literal(1),
    stateHash: contentHashSchema,
    stateVersion: z.number().int().nonnegative(),
    triggerEventId: boundedIdSchema
  })
  .strict()

export const actStartedSchema = z
  .object({
    actId: boundedIdSchema,
    cortexId: boundedIdSchema,
    input: cortexInputReferenceSchema,
    kind: z.literal('started'),
    modelId: boundedIdSchema,
    protocolVersion: z.literal(PROTOCOL_VERSION),
    startedAt: instantSchema
  })
  .strict()

export const actProposalSchema = z
  .object({
    effects: z.array(proposedEffectSchema).max(16),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    settlement: z.enum(['effects', 'silent'])
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.settlement === 'silent' && proposal.effects.length !== 0) {
      context.addIssue({ code: 'custom', message: 'Silent settlement must contain zero Effects' })
    }
    if (proposal.settlement === 'effects' && proposal.effects.length === 0) {
      context.addIssue({ code: 'custom', message: 'Effects settlement must contain at least one Effect' })
    }
  })

const proposedResultSchema = z
  .object({
    kind: z.literal('proposed'),
    proposal: actProposalSchema,
    proposalHash: contentHashSchema
  })
  .strict()
  .superRefine((result, context) => {
    if (canonicalHash(result.proposal) !== result.proposalHash) {
      context.addIssue({ code: 'custom', message: 'Proposal hash does not match canonical proposal' })
    }
  })

const plainTextResultSchema = z
  .object({
    kind: z.literal('plain-text'),
    text: z.string().max(32_768)
  })
  .strict()

const duplicateProposalResultSchema = z
  .object({
    firstProposalHash: contentHashSchema,
    kind: z.literal('duplicate-proposal'),
    proposalCount: z.number().int().min(2).max(16)
  })
  .strict()

const schemaInvalidResultSchema = z
  .object({
    issues: z.array(z.string().min(1).max(512)).min(1).max(32),
    kind: z.literal('schema-invalid'),
    rawOutputHash: contentHashSchema.optional()
  })
  .strict()

const truncatedResultSchema = z
  .object({
    kind: z.literal('truncated'),
    partialOutputHash: contentHashSchema.optional()
  })
  .strict()

const providerErrorResultSchema = z
  .object({
    code: z.string().min(1).max(128),
    kind: z.literal('provider-error'),
    message: z.string().min(1).max(2048),
    retryable: z.boolean()
  })
  .strict()

const abortedResultSchema = z
  .object({
    kind: z.literal('aborted'),
    reason: z.string().min(1).max(512)
  })
  .strict()

export const actProposalResultSchema = z.discriminatedUnion('kind', [
  abortedResultSchema,
  duplicateProposalResultSchema,
  plainTextResultSchema,
  proposedResultSchema,
  providerErrorResultSchema,
  schemaInvalidResultSchema,
  truncatedResultSchema
])

const terminalBase = {
  actId: boundedIdSchema,
  completedAt: instantSchema,
  protocolVersion: z.literal(PROTOCOL_VERSION),
  stateVersion: z.number().int().nonnegative()
}

const completedEffectsSchema = z
  .object({
    ...terminalBase,
    effectDecisionIds: z.array(boundedIdSchema).min(1).max(16),
    status: z.literal('completed-effects')
  })
  .strict()

const completedSilentSchema = z
  .object({
    ...terminalBase,
    status: z.literal('completed-silent')
  })
  .strict()

const rejectedActSchema = z
  .object({
    ...terminalBase,
    code: z.enum(['duplicate-proposal', 'plain-text', 'schema-invalid', 'truncated']),
    message: z.string().min(1).max(1024),
    status: z.literal('rejected')
  })
  .strict()

const failedActSchema = z
  .object({
    ...terminalBase,
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2048),
    retryable: z.boolean(),
    status: z.literal('failed')
  })
  .strict()

const cancelledActSchema = z
  .object({
    ...terminalBase,
    reason: z.string().min(1).max(512),
    status: z.literal('cancelled')
  })
  .strict()

const interruptedActSchema = z
  .object({
    ...terminalBase,
    reason: z.string().min(1).max(512),
    status: z.literal('interrupted')
  })
  .strict()

export const actTerminalSchema = z.discriminatedUnion('status', [
  cancelledActSchema,
  completedEffectsSchema,
  completedSilentSchema,
  failedActSchema,
  interruptedActSchema,
  rejectedActSchema
])

export const actSchema = z.union([actStartedSchema, actTerminalSchema])

export type Act = z.infer<typeof actSchema>
export type ActProposal = z.infer<typeof actProposalSchema>
export type ActProposalResult = z.infer<typeof actProposalResultSchema>
export type ActStarted = z.infer<typeof actStartedSchema>
export type ActTerminal = z.infer<typeof actTerminalSchema>
