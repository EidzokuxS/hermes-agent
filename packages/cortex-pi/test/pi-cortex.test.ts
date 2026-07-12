import type { Api, Context, Model, StreamOptions } from '@earendil-works/pi-ai'
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall
} from '@earendil-works/pi-ai/providers/faux'
import { canonicalHash, cortexInputSchema } from '@nox/protocol'
import type { ActProposal, CortexInput } from '@nox/protocol'
import { describe, expect, it } from 'vitest'

import { createPiCortexReference, PiCortex, resolvePiRunLimits } from '../src/index.js'
import type { PiOperationalArtifact } from '../src/index.js'

const at = '2026-07-12T08:00:00.000Z'

function inputFor(model: Model<Api>): CortexInput {
  return cortexInputSchema.parse({
    actId: 'act-001',
    bounds: {
      allowedEffectKinds: ['continuation.cancel', 'continuation.schedule', 'emission.append', 'state.patch'],
      allowedStateRoots: ['/picture', '/workingField'],
      maxEffects: 8,
      maxJournalRecords: 16,
      maxOutputTokens: 2048,
      timeoutMilliseconds: 30_000
    },
    builderVersion: 1,
    cortex: createPiCortexReference(model),
    identity: {
      conceptDocument: 'NOX-CONVERGENCE.md',
      identityId: 'nox',
      revision: `sha256:${'a'.repeat(64)}`
    },
    inputSchemaVersion: 1,
    journalContext: [],
    openContinuations: [],
    picture: {},
    protocolVersion: 1,
    standingPolicies: [
      {
        adoptedAt: at,
        kind: 'attention.every-delivered-event',
        policyId: 'foundation-attention',
        provenance: { source: 'inherited', sourceDocument: 'NOX-CONVERGENCE.md' },
        status: 'active',
        version: 1
      }
    ],
    stateRef: {
      stateHash: `sha256:${'c'.repeat(64)}`,
      stateVersion: 0,
      throughSequence: 0
    },
    temporal: {
      clockRelation: 'same',
      elapsedMilliseconds: 0,
      observedAt: at,
      rawClockDeltaMilliseconds: 0
    },
    temporalAnchor: { lastObservedAt: at, logicalTick: 0 },
    triggerEvent: {
      admission: 'admitted',
      clientEventId: 'client-event-001',
      content: { content: 'Привет, Nox.', format: 'text', kind: 'message' },
      eventId: 'event-001',
      interfaceOwnerId: 'eiji-local',
      kind: 'external',
      occurredAt: at,
      protocolVersion: 1,
      provenance: {
        clientEventId: 'client-event-001',
        interfaceOwnerId: 'eiji-local',
        kind: 'external-interface'
      }
    },
    workingField: {}
  })
}

const validProposal: ActProposal = {
  effects: [
    {
      content: 'Я здесь.',
      format: 'text',
      kind: 'emission.append',
      protocolVersion: 1
    }
  ],
  protocolVersion: 1,
  settlement: 'effects'
}

function createHarness() {
  const faux = createFauxCore({ models: [{ id: 'nox-faux', maxTokens: 4096 }] })
  const model = faux.getModel() as Model<Api>
  const artifacts: PiOperationalArtifact[] = []
  const cortex = new PiCortex({
    model,
    onArtifact: artifact => artifacts.push(artifact),
    streamFn: faux.streamSimple
  })
  return { artifacts, cortex, faux, input: inputFor(model), model }
}

describe('bounded Pi CortexPort', () => {
  it('returns one valid schema-bound proposal and exposes no State-changing tool', async () => {
    const harness = createHarness()
    let observedContext: Context | undefined
    let observedContextLength = -1
    let observedOptions: StreamOptions | undefined
    harness.faux.setResponses([
      (context, options) => {
        observedContext = context
        observedContextLength = context.messages.length
        observedOptions = options
        return fauxAssistantMessage(
          [
            fauxThinking('hidden chain must not enter the artifact'),
            fauxText('visible preface'),
            fauxToolCall('propose_act', validProposal)
          ],
          { stopReason: 'toolUse' }
        )
      }
    ])

    const result = await harness.cortex.runAct(harness.input, new AbortController().signal)

    expect(result).toMatchObject({ kind: 'proposed', proposal: validProposal })
    expect(observedContext?.tools?.map(({ name }) => name)).toEqual(['propose_act'])
    expect(observedContextLength).toBe(1)
    expect(observedOptions).toMatchObject({ maxRetries: 0, maxTokens: 2048, timeoutMs: 30_000 })
    expect(harness.faux.state.callCount).toBe(1)
    expect(harness.artifacts).toHaveLength(1)
    expect(harness.artifacts[0]?.inputHash).toBe(canonicalHash(harness.input))
    expect(JSON.stringify(harness.artifacts[0])).not.toContain('hidden chain')
    expect(harness.artifacts[0]?.output?.visibleText).toEqual(['visible preface'])
  })

  it('classifies a missing terminal tool as plain text', async () => {
    const harness = createHarness()
    harness.faux.setResponses([fauxAssistantMessage('A non-authoritative answer')])
    await expect(harness.cortex.runAct(harness.input, new AbortController().signal)).resolves.toEqual({
      kind: 'plain-text',
      text: 'A non-authoritative answer'
    })
  })

  it('classifies duplicate proposals without accepting either as a commit', async () => {
    const harness = createHarness()
    harness.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('propose_act', validProposal, { id: 'proposal-1' }),
          fauxToolCall('propose_act', validProposal, { id: 'proposal-2' })
        ],
        { stopReason: 'toolUse' }
      )
    ])
    await expect(harness.cortex.runAct(harness.input, new AbortController().signal)).resolves.toMatchObject({
      kind: 'duplicate-proposal',
      proposalCount: 2
    })
    expect(harness.faux.state.callCount).toBe(1)
  })

  it('classifies malformed tool arguments as schema-invalid after one transition', async () => {
    const harness = createHarness()
    harness.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('propose_act', {
          effects: [
            {
              kind: 'state.patch',
              operation: 'replace',
              path: '/identity/revision',
              protocolVersion: 1,
              value: 'forbidden'
            }
          ],
          protocolVersion: 1,
          settlement: 'effects'
        }),
        { stopReason: 'toolUse' }
      )
    ])
    const result = await harness.cortex.runAct(harness.input, new AbortController().signal)
    expect(result.kind).toBe('schema-invalid')
    expect(harness.faux.state.callCount).toBe(1)
  })

  it('classifies truncated tool output without executing the partial proposal', async () => {
    const harness = createHarness()
    harness.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('propose_act', validProposal), { stopReason: 'length' })
    ])
    await expect(harness.cortex.runAct(harness.input, new AbortController().signal)).resolves.toEqual({
      kind: 'truncated'
    })
  })

  it('classifies provider failure', async () => {
    const harness = createHarness()
    harness.faux.setResponses([fauxAssistantMessage('', { errorMessage: 'provider unavailable', stopReason: 'error' })])
    await expect(harness.cortex.runAct(harness.input, new AbortController().signal)).resolves.toEqual({
      code: 'pi-provider-error',
      kind: 'provider-error',
      message: 'provider unavailable',
      retryable: false
    })
  })

  it('honors an already-aborted signal without invoking Pi', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    controller.abort('cancelled by runtime')
    await expect(harness.cortex.runAct(harness.input, controller.signal)).resolves.toEqual({
      kind: 'aborted',
      reason: 'Act aborted before Pi invocation'
    })
    expect(harness.faux.state.callCount).toBe(0)
  })

  it('creates a fresh context for every Act and rejects complete configuration drift', async () => {
    const harness = createHarness()
    const contextLengths: number[] = []
    harness.faux.setResponses([
      context => {
        contextLengths.push(context.messages.length)
        return fauxAssistantMessage(fauxToolCall('propose_act', validProposal), { stopReason: 'toolUse' })
      },
      context => {
        contextLengths.push(context.messages.length)
        return fauxAssistantMessage(fauxToolCall('propose_act', validProposal), { stopReason: 'toolUse' })
      }
    ])
    await harness.cortex.runAct(harness.input, new AbortController().signal)
    await harness.cortex.runAct({ ...harness.input, actId: 'act-002' }, new AbortController().signal)
    expect(contextLengths).toEqual([1, 1])

    await expect(
      harness.cortex.runAct(
        { ...harness.input, cortex: { ...harness.input.cortex, modelId: 'another-model' } },
        new AbortController().signal
      )
    ).rejects.toThrow('does not match requested')

    await expect(
      harness.cortex.runAct(
        { ...harness.input, cortex: { ...harness.input.cortex, configHash: `sha256:${'d'.repeat(64)}` } },
        new AbortController().signal
      )
    ).rejects.toThrow('does not match requested')
  })

  it('redacts configured credentials from provider failures and operational artifacts', async () => {
    const faux = createFauxCore({ models: [{ id: 'nox-faux', maxTokens: 4096 }] })
    const model = faux.getModel() as Model<Api>
    const secret = 'synthetic-secret-value-1234567890'
    const artifacts: PiOperationalArtifact[] = []
    const cortex = new PiCortex({
      model,
      onArtifact: artifact => artifacts.push(artifact),
      sensitiveValues: [secret],
      streamFn: faux.streamSimple
    })
    faux.setResponses([
      fauxAssistantMessage('', { errorMessage: `provider echoed api_key=${secret}`, stopReason: 'error' })
    ])

    await expect(cortex.runAct(inputFor(model), new AbortController().signal)).resolves.toEqual({
      code: 'pi-provider-error',
      kind: 'provider-error',
      message: 'provider echoed api_key=[REDACTED]',
      retryable: false
    })
    expect(JSON.stringify(artifacts)).not.toContain(secret)
    expect(JSON.stringify(artifacts)).toContain('[REDACTED]')
  })

  it('caps requested output tokens at the selected model limit', () => {
    const harness = createHarness()
    expect(resolvePiRunLimits(harness.model, { maxOutputTokens: 10_000, timeoutMilliseconds: 1234 })).toEqual({
      maxOutputTokens: 4096,
      timeoutMilliseconds: 1234
    })
  })
})
