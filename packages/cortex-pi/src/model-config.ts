/// <reference types="node" />

import type { StreamFn, ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'

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
