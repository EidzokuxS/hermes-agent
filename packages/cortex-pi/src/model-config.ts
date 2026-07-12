/// <reference types="node" />

import type { StreamFn, ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { canonicalHash, canonicalStringify, cortexReferenceSchema } from '@nox/protocol'
import type { CortexInput } from '@nox/protocol'

export const PI_CORTEX_ID = 'pi-primary'
export const PI_PACKAGE_VERSION = '0.80.6'

export interface PiModelConfig {
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
  model: Model<Api>
  reasoning?: Exclude<ThinkingLevel, 'off'>
  sensitiveValues?: readonly string[]
  streamFn?: StreamFn
  systemPrompt?: string
}

export interface PiRunLimits {
  maxOutputTokens: number
  timeoutMilliseconds: number
}

export function resolvePiRunLimits(model: Model<Api>, requested: PiRunLimits): PiRunLimits {
  return {
    maxOutputTokens: Math.min(requested.maxOutputTokens, model.maxTokens),
    timeoutMilliseconds: requested.timeoutMilliseconds
  }
}

export function resolveBuiltinPiModel(provider: string, modelId: string): Model<Api> {
  const model = builtinModels().getModel(provider, modelId)
  if (model === undefined) {
    throw new Error(`Unknown pinned Pi model: ${provider}/${modelId}`)
  }
  return model
}

export function createPiCortexReference(model: Model<Api>): CortexInput['cortex'] {
  return cortexReferenceSchema.parse({
    adapter: 'pi',
    configHash: canonicalHash({
      adapter: 'pi',
      api: model.api,
      modelId: model.id,
      packageVersion: PI_PACKAGE_VERSION,
      provider: model.provider
    }),
    cortexId: PI_CORTEX_ID,
    modelId: model.id,
    packageVersion: PI_PACKAGE_VERSION
  })
}

export function assertPiCortexReference(reference: CortexInput['cortex'], model: Model<Api>): void {
  const expected = createPiCortexReference(model)
  if (canonicalStringify(reference) !== canonicalStringify(expected)) {
    throw new Error(
      `Persisted Cortex configuration ${reference.configHash} does not match requested ${expected.configHash}`
    )
  }
}
