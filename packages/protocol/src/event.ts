import { z } from 'zod'

import { boundedIdSchema, instantSchema, jsonValueSchema, PROTOCOL_VERSION, provenanceSchema } from './provenance.js'

export const externalEventContentSchema = z
  .object({
    content: z.string().min(1).max(65_536),
    format: z.enum(['markdown', 'text']),
    kind: z.literal('message')
  })
  .strict()

export const continuationEventContentSchema = z
  .object({
    context: jsonValueSchema.optional(),
    instruction: z.string().min(1).max(4096),
    kind: z.literal('continuation-fired'),
    label: z.string().min(1).max(160)
  })
  .strict()

export const bootstrapEventContentSchema = z
  .object({
    kind: z.literal('bootstrap'),
    reason: z.string().min(1).max(512)
  })
  .strict()

const eventBaseSchema = z
  .object({
    eventId: boundedIdSchema,
    occurredAt: instantSchema,
    protocolVersion: z.literal(PROTOCOL_VERSION),
    provenance: provenanceSchema
  })
  .strict()

export const externalEventSchema = eventBaseSchema
  .extend({
    admission: z.enum(['admitted', 'recorded']),
    clientEventId: boundedIdSchema,
    content: externalEventContentSchema,
    interfaceOwnerId: boundedIdSchema,
    kind: z.literal('external')
  })
  .superRefine((event, context) => {
    if (
      event.provenance.kind !== 'external-interface' ||
      event.provenance.clientEventId !== event.clientEventId ||
      event.provenance.interfaceOwnerId !== event.interfaceOwnerId
    ) {
      context.addIssue({ code: 'custom', message: 'External Event provenance must match its ingress identity' })
    }
  })

export const continuationEventSchema = eventBaseSchema
  .extend({
    admission: z.literal('admitted'),
    content: continuationEventContentSchema,
    continuationId: boundedIdSchema,
    kind: z.literal('continuation')
  })
  .superRefine((event, context) => {
    if (event.provenance.kind !== 'continuation' || event.provenance.continuationId !== event.continuationId) {
      context.addIssue({ code: 'custom', message: 'Continuation Event provenance must match its source' })
    }
  })

export const bootstrapEventSchema = eventBaseSchema
  .extend({
    admission: z.literal('admitted'),
    content: bootstrapEventContentSchema,
    kind: z.literal('bootstrap')
  })
  .superRefine((event, context) => {
    if (event.provenance.kind !== 'bootstrap') {
      context.addIssue({ code: 'custom', message: 'Bootstrap Event requires bootstrap provenance' })
    }
  })

export const eventSchema = z.discriminatedUnion('kind', [
  bootstrapEventSchema,
  continuationEventSchema,
  externalEventSchema
])

export const eventReceiptSchema = z
  .object({
    clientEventId: boundedIdSchema,
    eventId: boundedIdSchema,
    interfaceOwnerId: boundedIdSchema,
    journalSequence: z.number().int().positive(),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    recordedAt: instantSchema,
    stateVersion: z.number().int().nonnegative()
  })
  .strict()

export type Event = z.infer<typeof eventSchema>
export type EventReceipt = z.infer<typeof eventReceiptSchema>
export type ExternalEvent = z.infer<typeof externalEventSchema>
