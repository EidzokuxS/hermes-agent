import { canonicalHash, PROTOCOL_VERSION } from '@nox/protocol'
import type { ActProposal, ActProposalResult, CortexInput } from '@nox/protocol'
import type { CortexPort } from '@nox/runtime'

export type ScriptedScenario = 'blocking' | 'first-loop' | 'invalid' | 'rejected-effect' | 'silent'

function proposalResult(proposal: ActProposal): ActProposalResult {
  return { kind: 'proposed', proposal, proposalHash: canonicalHash(proposal) }
}

function firstLoopProposal(input: CortexInput, continuationDueAt: string): ActProposalResult {
  if (input.triggerEvent.kind === 'continuation') {
    return proposalResult({
      effects: [
        {
          kind: 'state.patch',
          operation: 'replace',
          path: '/workingField/phase',
          protocolVersion: PROTOCOL_VERSION,
          value: 'continuation-complete'
        },
        {
          content: 'C1 returned through a fresh runtime process.',
          format: 'text',
          kind: 'emission.append',
          protocolVersion: PROTOCOL_VERSION
        }
      ],
      protocolVersion: PROTOCOL_VERSION,
      settlement: 'effects'
    })
  }
  return proposalResult({
    effects: [
      {
        kind: 'state.patch',
        operation: 'add',
        path: '/workingField/phase',
        protocolVersion: PROTOCOL_VERSION,
        value: 'continuation-pending'
      },
      {
        kind: 'continuation.schedule',
        protocolVersion: PROTOCOL_VERSION,
        seed: {
          due: { at: continuationDueAt, kind: 'at-time' },
          instruction: 'Resume the first deterministic causal loop.',
          label: 'Resume first causal loop',
          maxFireCount: 1,
          protocolVersion: PROTOCOL_VERSION
        }
      },
      {
        content: 'E1 was accepted and C1 was planted.',
        format: 'text',
        kind: 'emission.append',
        protocolVersion: PROTOCOL_VERSION
      }
    ],
    protocolVersion: PROTOCOL_VERSION,
    settlement: 'effects'
  })
}

export interface ScriptedCortexOptions {
  continuationDueAt: string
  delayMilliseconds?: number
  scenario: ScriptedScenario
}

export class ScriptedCortex implements CortexPort {
  readonly inputs: CortexInput[] = []
  readonly #options: ScriptedCortexOptions

  constructor(options: ScriptedCortexOptions) {
    this.#options = options
  }

  async runAct(input: CortexInput, _signal: AbortSignal): Promise<ActProposalResult> {
    this.inputs.push(input)
    if (this.#options.scenario === 'blocking') {
      await new Promise<void>(resolve => setTimeout(resolve, this.#options.delayMilliseconds ?? 250))
      return proposalResult({
        effects: [
          {
            content: 'Late scripted output.',
            format: 'text',
            kind: 'emission.append',
            protocolVersion: PROTOCOL_VERSION
          }
        ],
        protocolVersion: PROTOCOL_VERSION,
        settlement: 'effects'
      })
    }
    if (this.#options.scenario === 'invalid') {
      return {
        issues: ['Scripted malformed proposal'],
        kind: 'schema-invalid',
        rawOutputHash: canonicalHash('invalid')
      }
    }
    if (this.#options.scenario === 'rejected-effect') {
      return proposalResult({
        effects: [
          {
            kind: 'state.patch',
            operation: 'replace',
            path: '/workingField/missing',
            protocolVersion: PROTOCOL_VERSION,
            value: 'must-be-rejected'
          },
          {
            content: 'A valid emission remains independently decidable.',
            format: 'text',
            kind: 'emission.append',
            protocolVersion: PROTOCOL_VERSION
          }
        ],
        protocolVersion: PROTOCOL_VERSION,
        settlement: 'effects'
      })
    }
    if (this.#options.scenario === 'silent') {
      return proposalResult({ effects: [], protocolVersion: PROTOCOL_VERSION, settlement: 'silent' })
    }
    return firstLoopProposal(input, this.#options.continuationDueAt)
  }
}
