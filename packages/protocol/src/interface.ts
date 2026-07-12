import { z } from 'zod'

import { actStartedSchema, actTerminalSchema } from './act.js'
import { continuationSchema, openContinuationSchema } from './continuation.js'
import { eventReceiptSchema, eventSchema, externalEventContentSchema } from './event.js'
import { boundedIdSchema, canonicalHash, contentHashSchema, instantSchema, PROTOCOL_VERSION } from './provenance.js'
import { stateSnapshotSchema } from './state.js'

export const interfaceEmissionSchema = z
  .object({
    actId: boundedIdSchema,
    content: z.string().min(1).max(32_768),
    effectId: boundedIdSchema,
    emissionId: boundedIdSchema,
    format: z.enum(['markdown', 'text']),
    journalSequence: z.number().int().positive(),
    occurredAt: instantSchema
  })
  .strict()

const interfaceEventEnvelope = {
  interfaceEventId: boundedIdSchema,
  journalSequence: z.number().int().positive(),
  observedAt: instantSchema,
  protocolVersion: z.literal(PROTOCOL_VERSION)
}

const receiptInterfaceEventSchema = z
  .object({
    ...interfaceEventEnvelope,
    kind: z.literal('event.receipt'),
    receipt: eventReceiptSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.journalSequence !== event.receipt.journalSequence) {
      context.addIssue({ code: 'custom', message: 'Receipt event must retain its Journal sequence' })
    }
  })

const admittedInterfaceEventSchema = z
  .object({
    ...interfaceEventEnvelope,
    eventId: boundedIdSchema,
    kind: z.literal('event.admitted')
  })
  .strict()

const actStartedInterfaceEventSchema = z
  .object({
    ...interfaceEventEnvelope,
    act: actStartedSchema,
    kind: z.literal('act.started')
  })
  .strict()

const actTerminalInterfaceEventSchema = z
  .object({
    ...interfaceEventEnvelope,
    act: actTerminalSchema,
    kind: z.literal('act.terminal')
  })
  .strict()

const emissionInterfaceEventSchema = z
  .object({
    ...interfaceEventEnvelope,
    emission: interfaceEmissionSchema,
    kind: z.literal('emission.appended')
  })
  .strict()
  .superRefine((event, context) => {
    if (event.journalSequence !== event.emission.journalSequence) {
      context.addIssue({ code: 'custom', message: 'Emission event must retain its Journal sequence' })
    }
  })

const continuationInterfaceEventSchema = z
  .object({
    ...interfaceEventEnvelope,
    continuation: continuationSchema,
    kind: z.literal('continuation.changed')
  })
  .strict()

const stateInterfaceEventSchema = z
  .object({
    ...interfaceEventEnvelope,
    kind: z.literal('state.advanced'),
    stateHash: contentHashSchema,
    stateVersion: z.number().int().positive()
  })
  .strict()

export const interfaceEventSchema = z.discriminatedUnion('kind', [
  actStartedInterfaceEventSchema,
  actTerminalInterfaceEventSchema,
  admittedInterfaceEventSchema,
  continuationInterfaceEventSchema,
  emissionInterfaceEventSchema,
  receiptInterfaceEventSchema,
  stateInterfaceEventSchema
])

export const viewSnapshotSchema = z
  .object({
    currentAct: actStartedSchema.optional(),
    emissions: z.array(interfaceEmissionSchema).max(512),
    events: z.array(eventSchema).max(512),
    interfaceOwnerId: boundedIdSchema,
    journalCursor: z.number().int().nonnegative(),
    openContinuations: z.array(openContinuationSchema).max(128),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    state: stateSnapshotSchema,
    unresolvedReceipts: z.array(eventReceiptSchema).max(128)
  })
  .strict()
  .superRefine((view, context) => {
    if (canonicalHash(view.openContinuations) !== canonicalHash(view.state.state.openContinuations)) {
      context.addIssue({ code: 'custom', message: 'Open Continuations must match the State snapshot' })
    }
    if (view.unresolvedReceipts.some(({ interfaceOwnerId }) => interfaceOwnerId !== view.interfaceOwnerId)) {
      context.addIssue({ code: 'custom', message: 'Recovery receipts must belong to the authenticated owner' })
    }
  })

const eventAppendCallSchema = z
  .object({
    method: z.literal('event.append'),
    params: z
      .object({
        clientEventId: boundedIdSchema,
        content: externalEventContentSchema,
        protocolVersion: z.literal(PROTOCOL_VERSION)
      })
      .strict()
  })
  .strict()

const viewSnapshotCallSchema = z
  .object({
    method: z.literal('view.snapshot'),
    params: z
      .object({
        protocolVersion: z.literal(PROTOCOL_VERSION)
      })
      .strict()
  })
  .strict()

const journalSubscribeCallSchema = z
  .object({
    method: z.literal('journal.subscribe'),
    params: z
      .object({
        afterSequence: z.number().int().nonnegative(),
        protocolVersion: z.literal(PROTOCOL_VERSION)
      })
      .strict()
  })
  .strict()

const actCancelCallSchema = z
  .object({
    method: z.literal('act.cancel'),
    params: z
      .object({
        actId: boundedIdSchema,
        protocolVersion: z.literal(PROTOCOL_VERSION),
        reason: z.string().min(1).max(512)
      })
      .strict()
  })
  .strict()

export const domainCallSchema = z.discriminatedUnion('method', [
  actCancelCallSchema,
  eventAppendCallSchema,
  journalSubscribeCallSchema,
  viewSnapshotCallSchema
])

export const eventAppendResultSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    receipt: eventReceiptSchema
  })
  .strict()

export const actCancelResultSchema = z
  .object({
    actId: boundedIdSchema,
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requested: z.boolean()
  })
  .strict()

export type DomainCall = z.infer<typeof domainCallSchema>
export type InterfaceEmission = z.infer<typeof interfaceEmissionSchema>
export type InterfaceEvent = z.infer<typeof interfaceEventSchema>
export type ViewSnapshot = z.infer<typeof viewSnapshotSchema>
