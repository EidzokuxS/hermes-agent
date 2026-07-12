import type { AgentTool } from '@earendil-works/pi-agent-core'
import { actProposalJsonSchema, actProposalSchema, canonicalHash } from '@nox/protocol'
import type { ActProposal, ActProposalResult } from '@nox/protocol'

export class ProposalRecorder {
  readonly #issues: string[] = []
  readonly #proposals: ActProposal[] = []

  createTool(): AgentTool<any> {
    return {
      description:
        'Submit the complete bounded consequence proposal for this Act. This is the only available tool and ends the Act.',
      execute: async (_toolCallId, params) => {
        const parsed = actProposalSchema.safeParse(params)
        if (!parsed.success) {
          const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || 'root'}: ${issue.message}`)
          this.#issues.push(...issues)
          throw new Error(`Invalid propose_act payload: ${issues.join('; ')}`)
        }
        this.#proposals.push(parsed.data)
        return {
          content: [{ text: 'Proposal recorded by the Nox runtime.', type: 'text' }],
          details: { proposalHash: canonicalHash(parsed.data) },
          terminate: true
        }
      },
      executionMode: 'sequential',
      label: 'Propose Act',
      name: 'propose_act',
      parameters: actProposalJsonSchema as AgentTool['parameters']
    }
  }

  addIssue(issue: string): void {
    if (issue.length > 0) {
      this.#issues.push(issue.slice(0, 512))
    }
  }

  outcome(): ActProposalResult | undefined {
    if (this.#proposals.length > 1) {
      if (this.#proposals.length > 16) {
        return { issues: ['More than 16 propose_act calls were attempted'], kind: 'schema-invalid' }
      }
      return {
        firstProposalHash: canonicalHash(this.#proposals[0]),
        kind: 'duplicate-proposal',
        proposalCount: this.#proposals.length
      }
    }
    const proposal = this.#proposals[0]
    if (proposal !== undefined) {
      return { kind: 'proposed', proposal, proposalHash: canonicalHash(proposal) }
    }
    if (this.#issues.length > 0) {
      return { issues: this.#issues.slice(0, 32), kind: 'schema-invalid' }
    }
    return undefined
  }
}
