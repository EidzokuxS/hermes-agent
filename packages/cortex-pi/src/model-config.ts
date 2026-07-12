/// <reference types="node" />

import type { StreamFn, ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'

export interface PiModelConfig {
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
  model: Model<Api>
  reasoning?: Exclude<ThinkingLevel, 'off'>
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
