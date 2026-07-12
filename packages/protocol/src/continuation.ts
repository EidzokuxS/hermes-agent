import { z } from 'zod'

import { boundedIdSchema, instantSchema, jsonValueSchema, PROTOCOL_VERSION } from './provenance.js'

export const dueConditionSchema = z
  .object({
    at: instantSchema,
    kind: z.literal('at-time')
  })
  .strict()

export const continuationSeedSchema = z
  .object({
    context: jsonValueSchema.optional(),
    due: dueConditionSchema,
    instruction: z.string().min(1).max(4096),
    label: z.string().min(1).max(160),
    maxFireCount: z.literal(1),
    protocolVersion: z.literal(PROTOCOL_VERSION)
  })
  .strict()

const continuationBaseSchema = z
  .object({
    continuationId: boundedIdSchema,
    createdAt: instantSchema,
    fireCount: z.number().int().min(0).max(1),
    originActId: boundedIdSchema,
    seed: continuationSeedSchema
  })
  .strict()

export const openContinuationSchema = continuationBaseSchema.extend({
  fireCount: z.literal(0),
  status: z.literal('open')
})

export const firedContinuationSchema = continuationBaseSchema.extend({
  fireCount: z.literal(1),
  firedAt: instantSchema,
  firedEventId: boundedIdSchema,
  status: z.literal('fired')
})

export const cancelledContinuationSchema = continuationBaseSchema.extend({
  cancelledAt: instantSchema,
  cancelledByActId: boundedIdSchema,
  fireCount: z.literal(0),
  status: z.literal('cancelled')
})

export const continuationSchema = z.discriminatedUnion('status', [
  cancelledContinuationSchema,
  firedContinuationSchema,
  openContinuationSchema
])

export type Continuation = z.infer<typeof continuationSchema>
export type ContinuationSeed = z.infer<typeof continuationSeedSchema>
export type OpenContinuation = z.infer<typeof openContinuationSchema>
