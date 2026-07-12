/// <reference types="node" />

import { runAgentLoop } from '@earendil-works/pi-agent-core'
import type { AgentEvent, AgentLoopConfig, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Message, ToolCall, Usage, UserMessage } from '@earendil-works/pi-ai'
import { actProposalResultSchema, canonicalHash, canonicalStringify, cortexInputSchema } from '@nox/protocol'
import type { ActProposal, ActProposalResult, CortexInput, JsonValue } from '@nox/protocol'

import type { PiModelConfig } from './model-config.js'
import { assertPiCortexReference, resolvePiRunLimits } from './model-config.js'
import { ProposalRecorder } from './proposal-tool.js'

export interface PiToolCallArtifact {
  arguments: Record<string, JsonValue>
  id: string
  name: string
}

export interface PiOperationalArtifact {
  actId: string
  diagnostics: string[]
  inputHash: string
  model: {
    api: string
    id: string
    provider: string
  }
  output?: {
    errorMessage?: string
    stopReason: AssistantMessage['stopReason']
    toolCalls: PiToolCallArtifact[]
    usage: Usage
    visibleText: string[]
  }
  proposal?: ActProposal
  systemPrompt: string
  userPrompt: string
}

export interface PiCortexOptions extends PiModelConfig {
  onArtifact?: (artifact: PiOperationalArtifact) => Promise<void> | void
}

const DEFAULT_SYSTEM_PROMPT = `You are the replaceable cortex for one bounded Nox Act.
The user message is a canonical CortexInput owned by the Nox runtime.
Evaluate it and call propose_act exactly once with either explicit silence or bounded Effects.
You have no direct State authority. Do not invent other tools, tasks, or persistence.`

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return typeof message === 'object' && message !== null && 'role' in message && message.role === 'assistant'
}

function visibleText(message: AssistantMessage | undefined): string[] {
  if (message === undefined) {
    return []
  }
  return message.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map(({ text }) => text)
}

function toolCalls(message: AssistantMessage | undefined): PiToolCallArtifact[] {
  if (message === undefined) {
    return []
  }
  return message.content
    .filter((part): part is ToolCall => part.type === 'toolCall')
    .map(call => ({
      arguments: call.arguments as Record<string, JsonValue>,
      id: call.id,
      name: call.name
    }))
}

function describeDiagnostic(value: unknown): string {
  try {
    return canonicalStringify(value)
  } catch {
    return value instanceof Error ? value.message : String(value)
  }
}

function redactText(value: string, sensitiveValues: ReadonlySet<string>): string {
  let redacted = value
  for (const sensitive of sensitiveValues) {
    if (sensitive.length >= 4) {
      redacted = redacted.replaceAll(sensitive, '[REDACTED]')
    }
  }
  return redacted
    .replace(/\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
}

function redactUnknown(value: unknown, sensitiveValues: ReadonlySet<string>): unknown {
  if (typeof value === 'string') {
    return redactText(value, sensitiveValues)
  }
  if (Array.isArray(value)) {
    return value.map(item => redactUnknown(item, sensitiveValues))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactUnknown(item, sensitiveValues)]))
  }
  return value
}

function combineSignal(
  parent: AbortSignal,
  timeoutMilliseconds: number
): {
  cleanup: () => void
  signal: AbortSignal
} {
  const controller = new AbortController()
  const abortFromParent = (): void => controller.abort(parent.reason)
  if (parent.aborted) {
    abortFromParent()
  } else {
    parent.addEventListener('abort', abortFromParent, { once: true })
  }
  const timeout = setTimeout(
    () => controller.abort(new Error(`Pi Act exceeded ${timeoutMilliseconds}ms`)),
    timeoutMilliseconds
  )
  return {
    cleanup: () => {
      clearTimeout(timeout)
      parent.removeEventListener('abort', abortFromParent)
    },
    signal: controller.signal
  }
}

export class PiCortex {
  readonly #options: PiCortexOptions

  constructor(options: PiCortexOptions) {
    this.#options = options
  }

  async runAct(inputValue: CortexInput, parentSignal: AbortSignal): Promise<ActProposalResult> {
    const input = cortexInputSchema.parse(inputValue)
    assertPiCortexReference(input.cortex, this.#options.model)
    const sensitiveValues = new Set(this.#options.sensitiveValues ?? [])

    const systemPrompt = this.#options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
    const userPrompt = canonicalStringify(input)
    const limits = resolvePiRunLimits(this.#options.model, {
      maxOutputTokens: input.bounds.maxOutputTokens,
      timeoutMilliseconds: input.bounds.timeoutMilliseconds
    })
    const combined = combineSignal(parentSignal, limits.timeoutMilliseconds)
    const recorder = new ProposalRecorder()
    const diagnostics: string[] = []
    let finalAssistant: AssistantMessage | undefined
    let newMessages: AgentMessage[] = []

    const artifact = async (): Promise<void> => {
      const proposalOutcome = recorder.outcome()
      const value: PiOperationalArtifact = {
        actId: input.actId,
        diagnostics,
        inputHash: canonicalHash(input),
        model: {
          api: this.#options.model.api,
          id: this.#options.model.id,
          provider: this.#options.model.provider
        },
        ...(finalAssistant === undefined
          ? {}
          : {
              output: {
                ...(finalAssistant.errorMessage === undefined ? {} : { errorMessage: finalAssistant.errorMessage }),
                stopReason: finalAssistant.stopReason,
                toolCalls: toolCalls(finalAssistant),
                usage: finalAssistant.usage,
                visibleText: visibleText(finalAssistant)
              }
            }),
        ...(proposalOutcome?.kind === 'proposed' ? { proposal: proposalOutcome.proposal } : {}),
        systemPrompt,
        userPrompt
      }
      await this.#options.onArtifact?.(redactUnknown(value, sensitiveValues) as PiOperationalArtifact)
    }

    if (combined.signal.aborted) {
      combined.cleanup()
      const result = actProposalResultSchema.parse({ kind: 'aborted', reason: 'Act aborted before Pi invocation' })
      await artifact()
      return result
    }

    const prompt: UserMessage = {
      content: userPrompt,
      role: 'user',
      timestamp: Date.parse(input.temporal.observedAt)
    }
    const config: AgentLoopConfig = {
      convertToLlm: messages => messages as Message[],
      ...(this.#options.getApiKey === undefined
        ? {}
        : {
            getApiKey: async (provider: string) => {
              const key = await this.#options.getApiKey?.(provider)
              if (key !== undefined) {
                sensitiveValues.add(key)
              }
              return key
            }
          }),
      maxRetries: 0,
      maxTokens: limits.maxOutputTokens,
      model: this.#options.model,
      ...(this.#options.reasoning === undefined ? {} : { reasoning: this.#options.reasoning }),
      shouldStopAfterTurn: () => true,
      timeoutMs: limits.timeoutMilliseconds,
      toolExecution: 'sequential'
    }

    try {
      newMessages = await runAgentLoop(
        [prompt],
        { messages: [], systemPrompt, tools: [recorder.createTool()] },
        config,
        (event: AgentEvent) => {
          if (event.type === 'turn_end' && isAssistantMessage(event.message)) {
            finalAssistant = event.message
          }
          if (event.type === 'tool_execution_end' && event.isError) {
            const issue = `Tool ${event.toolName} failed: ${describeDiagnostic(event.result)}`
            diagnostics.push(issue.slice(0, 512))
            recorder.addIssue(issue)
          }
        },
        combined.signal,
        this.#options.streamFn
      )
      finalAssistant ??= [...newMessages].reverse().find(isAssistantMessage)
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error), sensitiveValues)
      diagnostics.push(message.slice(0, 512))
      const result = actProposalResultSchema.parse(
        combined.signal.aborted
          ? { kind: 'aborted', reason: message || 'Pi Act aborted' }
          : { code: 'pi-loop-error', kind: 'provider-error', message, retryable: false }
      )
      await artifact()
      return result
    } finally {
      combined.cleanup()
    }

    let result: ActProposalResult
    if (finalAssistant?.stopReason === 'aborted' || combined.signal.aborted) {
      result = { kind: 'aborted', reason: finalAssistant?.errorMessage ?? 'Pi Act aborted' }
    } else if (finalAssistant?.stopReason === 'error') {
      result = {
        code: 'pi-provider-error',
        kind: 'provider-error',
        message: finalAssistant.errorMessage ?? 'Pi provider error',
        retryable: false
      }
    } else if (finalAssistant?.stopReason === 'length') {
      result = { kind: 'truncated' }
    } else {
      result = recorder.outcome() ?? {
        kind: 'plain-text',
        text: visibleText(finalAssistant).join('\n')
      }
    }
    const parsed = actProposalResultSchema.parse(redactUnknown(result, sensitiveValues))
    await artifact()
    return parsed
  }
}
