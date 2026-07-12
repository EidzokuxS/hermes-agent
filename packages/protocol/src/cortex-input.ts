import { z } from 'zod'

import { openContinuationSchema } from './continuation.js'
import { eventSchema } from './event.js'
import {
  boundedIdSchema,
  causalLinksSchema,
  contentHashSchema,
  instantSchema,
  jsonValueSchema,
  PROTOCOL_VERSION,
  provenanceSchema
} from './provenance.js'
import { cortexReferenceSchema, identityReferenceSchema, standingPolicySchema, temporalAnchorSchema } from './state.js'

export const CORTEX_INPUT_SCHEMA_VERSION = 1 as const
export const CORTEX_INPUT_BUILDER_VERSION = 1 as const

export const cortexJournalItemSchema = z
  .object({
    causal: causalLinksSchema,
    entryKind: z.string().min(1).max(128),
    payload: jsonValueSchema,
    provenance: provenanceSchema,
    recordId: boundedIdSchema,
    recordedAt: instantSchema,
    sequence: z.number().int().positive()
  })
  .strict()

export const cortexBoundsSchema = z
  .object({
    allowedEffectKinds: z.tuple([
      z.literal('continuation.cancel'),
      z.literal('continuation.schedule'),
      z.literal('emission.append'),
      z.literal('state.patch')
    ]),
    allowedStateRoots: z.tuple([z.literal('/picture'), z.literal('/workingField')]),
    maxEffects: z.number().int().min(1).max(16),
    maxJournalRecords: z.number().int().min(0).max(64),
    maxOutputTokens: z.number().int().min(1).max(65_536),
    timeoutMilliseconds: z.number().int().min(1).max(3_600_000)
  })
  .strict()

export const cortexInputSchema = z
  .object({
    actId: boundedIdSchema,
    bounds: cortexBoundsSchema,
    builderVersion: z.literal(CORTEX_INPUT_BUILDER_VERSION),
    cortex: cortexReferenceSchema,
    identity: identityReferenceSchema,
    inputSchemaVersion: z.literal(CORTEX_INPUT_SCHEMA_VERSION),
    journalContext: z.array(cortexJournalItemSchema).max(64),
    openContinuations: z.array(openContinuationSchema).max(128),
    picture: z.record(z.string(), jsonValueSchema),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    standingPolicies: z.array(standingPolicySchema).min(1).max(16),
    stateRef: z
      .object({
        stateHash: contentHashSchema,
        stateVersion: z.number().int().nonnegative(),
        throughSequence: z.number().int().nonnegative()
      })
      .strict(),
    temporal: z
      .object({
        clockRelation: z.enum(['forward', 'regressed', 'same']),
        elapsedMilliseconds: z.number().int().nonnegative(),
        observedAt: instantSchema,
        rawClockDeltaMilliseconds: z.number().int()
      })
      .strict(),
    temporalAnchor: temporalAnchorSchema,
    triggerEvent: eventSchema,
    workingField: z.record(z.string(), jsonValueSchema)
  })
  .strict()
  .superRefine((input, context) => {
    if (input.journalContext.length > input.bounds.maxJournalRecords) {
      context.addIssue({ code: 'custom', message: 'Journal context exceeds the declared Act bound' })
    }
    const sequences = input.journalContext.map(({ sequence }) => sequence)
    if (new Set(sequences).size !== sequences.length) {
      context.addIssue({ code: 'custom', message: 'Journal context sequences must be unique' })
    }
    if (sequences.some((sequence, index) => index > 0 && sequence <= (sequences[index - 1] ?? 0))) {
      context.addIssue({ code: 'custom', message: 'Journal context must be in ascending causal order' })
    }
  })

export type CortexBounds = z.infer<typeof cortexBoundsSchema>
export type CortexInput = z.infer<typeof cortexInputSchema>
export type CortexJournalItem = z.infer<typeof cortexJournalItemSchema>
