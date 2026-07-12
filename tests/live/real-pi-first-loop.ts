/// <reference types="node" />

import type { Api, Model } from '@earendil-works/pi-ai'
import { PiCortex } from '@nox/cortex-pi'
import type { PiOperationalArtifact } from '@nox/cortex-pi'
import type { ActProposalResult, CortexInput } from '@nox/protocol'

export interface RealPiFirstLoopOptions {
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
  input: CortexInput
  model: Model<Api>
  onArtifact: (artifact: PiOperationalArtifact) => Promise<void> | void
  signal: AbortSignal
}

export async function runRealPiFirstLoop(options: RealPiFirstLoopOptions): Promise<ActProposalResult> {
  const cortex = new PiCortex({
    ...(options.getApiKey === undefined ? {} : { getApiKey: options.getApiKey }),
    model: options.model,
    onArtifact: options.onArtifact
  })
  return cortex.runAct(options.input, options.signal)
}
