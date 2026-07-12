import { z } from 'zod'

import { continuationSeedSchema } from './continuation.js'
import { boundedIdSchema, instantSchema, jsonValueSchema, PROTOCOL_VERSION, provenanceSchema } from './provenance.js'

export const statePathSchema = z
  .string()
  .max(512)
  .regex(/^\/(picture|workingField)(?:\/(?:[^~/]|~0|~1)+)*$/)
  .refine(path => {
    const tokens = path
      .split('/')
      .slice(1)
      .map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
    return !tokens.some(token => ['__proto__', 'constructor', 'prototype'].includes(token))
  }, 'State path contains a forbidden object key')

export const statePatchEffectSchema = z
  .object({
    kind: z.literal('state.patch'),
    operation: z.enum(['add', 'remove', 'replace']),
    path: statePathSchema,
    protocolVersion: z.literal(PROTOCOL_VERSION),
    value: jsonValueSchema.optional()
  })
  .strict()
  .superRefine((effect, context) => {
    const isRoot = effect.path === '/picture' || effect.path === '/workingField'
    if (effect.operation === 'remove' && isRoot) {
      context.addIssue({ code: 'custom', message: 'Foundation State roots cannot be removed' })
    }
    if (effect.operation === 'remove' && effect.value !== undefined) {
      context.addIssue({ code: 'custom', message: 'Remove operations cannot carry a value' })
    }
    if (effect.operation !== 'remove' && effect.value === undefined) {
      context.addIssue({ code: 'custom', message: 'Add and replace operations require a value' })
    }
  })

export const emissionAppendEffectSchema = z
  .object({
    content: z.string().min(1).max(32_768),
    format: z.enum(['markdown', 'text']),
    kind: z.literal('emission.append'),
    protocolVersion: z.literal(PROTOCOL_VERSION)
  })
  .strict()

export const continuationScheduleEffectSchema = z
  .object({
    kind: z.literal('continuation.schedule'),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    seed: continuationSeedSchema
  })
  .strict()

export const continuationCancelEffectSchema = z
  .object({
    continuationId: boundedIdSchema,
    kind: z.literal('continuation.cancel'),
    protocolVersion: z.literal(PROTOCOL_VERSION)
  })
  .strict()

export const continuationFireEffectSchema = z
  .object({
    continuationId: boundedIdSchema,
    firedAt: instantSchema,
    kind: z.literal('continuation.fire'),
    protocolVersion: z.literal(PROTOCOL_VERSION)
  })
  .strict()

export const proposedEffectSchema = z.discriminatedUnion('kind', [
  continuationCancelEffectSchema,
  continuationScheduleEffectSchema,
  emissionAppendEffectSchema,
  statePatchEffectSchema
])

export const runtimeEffectSchema = z.discriminatedUnion('kind', [
  continuationCancelEffectSchema,
  continuationFireEffectSchema,
  continuationScheduleEffectSchema,
  emissionAppendEffectSchema,
  statePatchEffectSchema
])

const effectDecisionBaseSchema = z
  .object({
    actId: boundedIdSchema,
    effect: runtimeEffectSchema,
    effectId: boundedIdSchema,
    ordinal: z.number().int().nonnegative(),
    provenance: provenanceSchema
  })
  .strict()

const acceptedEffectDecisionSchema = effectDecisionBaseSchema.extend({
  decision: z.literal('accepted'),
  decidedAt: instantSchema,
  stateChanging: z.boolean()
})

const rejectedEffectDecisionSchema = effectDecisionBaseSchema.extend({
  code: z.enum([
    'continuation-not-found',
    'duplicate-effect',
    'invalid-transition',
    'policy-denied',
    'stale-state',
    'unsupported-path'
  ]),
  decision: z.literal('rejected'),
  decidedAt: instantSchema,
  message: z.string().min(1).max(1024),
  stateChanging: z.literal(false)
})

export const effectDecisionSchema = z
  .discriminatedUnion('decision', [acceptedEffectDecisionSchema, rejectedEffectDecisionSchema])
  .superRefine((decision, context) => {
    if (decision.decision !== 'accepted') {
      return
    }
    const expected = decision.effect.kind !== 'emission.append'
    if (decision.stateChanging !== expected) {
      context.addIssue({ code: 'custom', message: `${decision.effect.kind} has incorrect stateChanging flag` })
    }
  })

export type EffectDecision = z.infer<typeof effectDecisionSchema>
export type ProposedEffect = z.infer<typeof proposedEffectSchema>
export type RuntimeEffect = z.infer<typeof runtimeEffectSchema>
