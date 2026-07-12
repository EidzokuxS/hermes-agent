import { z } from 'zod'

import { openContinuationSchema } from './continuation.js'
import {
  boundedIdSchema,
  canonicalHash,
  contentHashSchema,
  instantSchema,
  JOURNAL_SCHEMA_VERSION,
  jsonValueSchema,
  PROTOCOL_VERSION,
  STATE_SCHEMA_VERSION
} from './provenance.js'

export const identityReferenceSchema = z
  .object({
    conceptDocument: z.literal('NOX-CONVERGENCE.md'),
    identityId: z.literal('nox'),
    revision: contentHashSchema
  })
  .strict()

export const standingPolicySchema = z
  .object({
    adoptedAt: instantSchema,
    kind: z.literal('attention.every-delivered-event'),
    policyId: boundedIdSchema,
    provenance: z
      .object({
        source: z.literal('inherited'),
        sourceDocument: z.literal('NOX-CONVERGENCE.md')
      })
      .strict(),
    status: z.literal('active'),
    version: z.literal(1)
  })
  .strict()

export const cortexReferenceSchema = z
  .object({
    adapter: z.literal('pi'),
    configHash: contentHashSchema,
    cortexId: boundedIdSchema,
    modelId: boundedIdSchema,
    packageVersion: z.literal('0.80.6')
  })
  .strict()

export const temporalAnchorSchema = z
  .object({
    lastObservedAt: instantSchema,
    logicalTick: z.number().int().nonnegative()
  })
  .strict()

export const foundationStateSchema = z
  .object({
    cortex: cortexReferenceSchema,
    identity: identityReferenceSchema,
    openContinuations: z.array(openContinuationSchema).max(128),
    picture: z.record(z.string(), jsonValueSchema),
    schemaVersions: z
      .object({
        journal: z.literal(JOURNAL_SCHEMA_VERSION),
        protocol: z.literal(PROTOCOL_VERSION),
        state: z.literal(STATE_SCHEMA_VERSION)
      })
      .strict(),
    standingPolicies: z.array(standingPolicySchema).min(1).max(16),
    temporalAnchor: temporalAnchorSchema,
    workingField: z.record(z.string(), jsonValueSchema)
  })
  .strict()
  .superRefine((state, context) => {
    const continuationIds = state.openContinuations.map(({ continuationId }) => continuationId)
    if (new Set(continuationIds).size !== continuationIds.length) {
      context.addIssue({ code: 'custom', message: 'Open continuation IDs must be unique' })
    }
    const policyIds = state.standingPolicies.map(({ policyId }) => policyId)
    if (new Set(policyIds).size !== policyIds.length) {
      context.addIssue({ code: 'custom', message: 'Standing policy IDs must be unique' })
    }
  })

const snapshotFields = {
  state: foundationStateSchema,
  stateHash: contentHashSchema,
  stateVersion: z.number().int().nonnegative()
}

function validateStateHash(
  snapshot: { state: z.infer<typeof foundationStateSchema>; stateHash: string },
  context: z.core.$RefinementCtx
): void {
  if (canonicalHash(snapshot.state) !== snapshot.stateHash) {
    context.addIssue({ code: 'custom', input: snapshot, message: 'State hash does not match canonical State' })
  }
}

export const pendingStateSnapshotSchema = z.object(snapshotFields).strict().superRefine(validateStateHash)

export const stateSnapshotSchema = z
  .object({
    ...snapshotFields,
    throughSequence: z.number().int().nonnegative()
  })
  .strict()
  .superRefine(validateStateHash)

export type FoundationState = z.infer<typeof foundationStateSchema>
export type PendingStateSnapshot = z.infer<typeof pendingStateSnapshotSchema>
export type StateSnapshot = z.infer<typeof stateSnapshotSchema>
