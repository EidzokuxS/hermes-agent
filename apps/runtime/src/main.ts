/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { assertPiCortexReference, createPiCortexReference, PiCortex, resolveBuiltinPiModel } from '@nox/cortex-pi'
import { canonicalHash, canonicalStringify, stateSnapshotSchema } from '@nox/protocol'
import { createRuntime } from '@nox/runtime'
import { SqliteStore } from '@nox/store-sqlite'

import { startContinuationLoop } from './continuation-loop.js'
import { createProcessHost } from './create-process-host.js'

function argument(name: string, environmentName?: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (value !== undefined && !value.startsWith('--')) {
    return value
  }
  const environmentValue = environmentName === undefined ? undefined : process.env[environmentName]
  if (environmentValue === undefined || environmentValue.length === 0) {
    throw new Error(`Missing --${name}`)
  }
  return environmentValue
}

async function main(): Promise<void> {
  const dataDirectory = argument('data-dir')
  const launchToken = argument('launch-token', 'NOX_LAUNCH_TOKEN')
  const interfaceOwnerId = argument('interface-owner')
  const provider = argument('provider')
  const modelId = argument('model')
  const model = resolveBuiltinPiModel(provider, modelId)
  const now = (): string => new Date().toISOString()
  const store = new SqliteStore(join(dataDirectory, 'nox.sqlite'), { now })
  const conceptText = readFileSync(join(process.cwd(), 'NOX-CONVERGENCE.md'), 'utf8')
  const foundationState = {
    cortex: createPiCortexReference(model),
    identity: {
      conceptDocument: 'NOX-CONVERGENCE.md' as const,
      identityId: 'nox' as const,
      revision: canonicalHash(conceptText)
    },
    openContinuations: [],
    picture: {},
    schemaVersions: { journal: 1 as const, protocol: 1 as const, state: 1 as const },
    standingPolicies: [
      {
        adoptedAt: now(),
        kind: 'attention.every-delivered-event' as const,
        policyId: 'foundation-attention',
        provenance: {
          source: 'inherited' as const,
          sourceDocument: 'NOX-CONVERGENCE.md' as const
        },
        status: 'active' as const,
        version: 1 as const
      }
    ],
    temporalAnchor: { lastObservedAt: now(), logicalTick: 0 },
    workingField: {}
  }
  const initialSnapshot = stateSnapshotSchema.parse({
    state: foundationState,
    stateHash: canonicalHash(foundationState),
    stateVersion: 0,
    throughSequence: 0
  })
  let existing
  try {
    existing = await store.loadSnapshot()
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('not been initialized')) {
      throw error
    }
    existing = await store.initialize(initialSnapshot)
  }
  assertPiCortexReference(existing.state.cortex, model)
  const configuredApiKey = process.env.NOX_PI_API_KEY
  const cortex = new PiCortex({
    ...(configuredApiKey === undefined
      ? {}
      : {
          getApiKey: (requestedProvider: string) => (requestedProvider === provider ? configuredApiKey : undefined),
          sensitiveValues: [configuredApiKey]
        }),
    model,
    onArtifact: async artifact => {
      await store.putAuditBlob({
        bytes: Uint8Array.from(Buffer.from(canonicalStringify(artifact), 'utf8')),
        createdAt: now(),
        mediaType: 'application/vnd.nox.pi-operational-artifact+json',
        provenance: {
          actId: artifact.actId,
          cortexId: 'pi-primary',
          kind: 'cortex',
          modelId: model.id
        }
      })
    }
  })
  let nextId = 0
  const runtime = createRuntime({
    clock: { now },
    cortex,
    idFactory: () => `runtime-${Date.now()}-${(nextId += 1)}`,
    store
  })
  await runtime.recover()
  const host = await createProcessHost({ interfaceOwnerId, launchToken, runtime })
  const continuationLoop = startContinuationLoop(runtime, {
    onError: async error => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`Continuation loop failed: ${message}\n`)
      try {
        await runtime.recordOperationalFailure('continuation-loop', message)
      } catch (persistenceError) {
        process.stderr.write(
          `Continuation failure could not be journaled: ${
            persistenceError instanceof Error ? persistenceError.message : String(persistenceError)
          }\n`
        )
      }
    }
  })
  process.stdout.write(`${JSON.stringify({ port: host.port, protocolVersion: 1 })}\n`)

  const shutdown = async (): Promise<void> => {
    await continuationLoop.stop()
    await host.close()
    store.close()
  }
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
