/// <reference types="node" />

import { runAgentLoop } from '@earendil-works/pi-agent-core'
import type { AgentEvent, AgentLoopConfig, AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Message, ToolCall, Usage, UserMessage } from '@earendil-works/pi-ai'
import { actProposalResultSchema, canonicalHash, canonicalStringify, cortexInputSchema } from '@nox/protocol'
import type { ActProposal, ActProposalResult, CortexInput, JsonValue } from '@nox/protocol'

import type { PiModelConfig } from './model-config.js'
import { resolvePiRunLimits } from './model-config.js'
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
    if (input.cortex.modelId !== this.#options.model.id) {
      throw new Error(
        `CortexInput model ${input.cortex.modelId} does not match configured Pi model ${this.#options.model.id}`
      )
    }

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
      await this.#options.onArtifact?.({
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
      })
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
      ...(this.#options.getApiKey === undefined ? {} : { getApiKey: this.#options.getApiKey }),
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
      const message = error instanceof Error ? error.message : String(error)
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
    const parsed = actProposalResultSchema.parse(result)
    await artifact()
    return parsed
  }
}
