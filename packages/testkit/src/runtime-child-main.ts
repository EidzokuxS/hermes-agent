/// <reference types="node" />

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalHash, stateSnapshotSchema } from '@nox/protocol'
import type {
  CommitCommand,
  CommitReceipt,
  EventReceipt,
  ExternalEvent,
  JournalRecord,
  StateSnapshot
} from '@nox/protocol'
import { createRuntime } from '@nox/runtime'
import type { AuditBlobInput, AuditBlobReceipt, JournalQuery, StorePort } from '@nox/runtime'
import { SqliteStore } from '@nox/store-sqlite'

import { DeterministicClock } from './deterministic-clock.js'
import { ScriptedCortex } from './scripted-cortex.js'
import type { ScriptedScenario } from './scripted-cortex.js'

export type CrashBoundary =
  | 'after-act-started'
  | 'after-admission-before-act'
  | 'after-receipt-flush'
  | 'after-receipt-queue'
  | 'after-record-before-response'
  | 'before-event-commit'
  | 'none'

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (value !== undefined && !value.startsWith('--')) {
    return value
  }
  if (fallback !== undefined) {
    return fallback
  }
  throw new Error(`Missing --${name}`)
}

function foundationSnapshot(now: string): StateSnapshot {
  const state = {
    cortex: {
      adapter: 'pi' as const,
      configHash: `sha256:${'b'.repeat(64)}`,
      cortexId: 'pi-primary',
      modelId: 'scripted-cortex',
      packageVersion: '0.80.6' as const
    },
    identity: {
      conceptDocument: 'NOX-CONVERGENCE.md' as const,
      identityId: 'nox' as const,
      revision: `sha256:${'a'.repeat(64)}`
    },
    openContinuations: [],
    picture: {},
    schemaVersions: { journal: 1 as const, protocol: 1 as const, state: 1 as const },
    standingPolicies: [
      {
        adoptedAt: now,
        kind: 'attention.every-delivered-event' as const,
        policyId: 'foundation-attention',
        provenance: { source: 'inherited' as const, sourceDocument: 'NOX-CONVERGENCE.md' as const },
        status: 'active' as const,
        version: 1 as const
      }
    ],
    temporalAnchor: { lastObservedAt: now, logicalTick: 0 },
    workingField: {}
  }
  return stateSnapshotSchema.parse({ state, stateHash: canonicalHash(state), stateVersion: 0, throughSequence: 0 })
}

function crash(): never {
  process.exit(86)
}

class CrashInjectingStore implements StorePort {
  readonly #boundary: CrashBoundary
  readonly #store: SqliteStore

  constructor(store: SqliteStore, boundary: CrashBoundary) {
    this.#store = store
    this.#boundary = boundary
  }

  async getUnresolvedReceipts(interfaceOwnerId: string): Promise<EventReceipt[]> {
    return this.#store.getUnresolvedReceipts(interfaceOwnerId)
  }

  async loadSnapshot(): Promise<StateSnapshot> {
    return this.#store.loadSnapshot()
  }

  async putAuditBlob(input: AuditBlobInput): Promise<AuditBlobReceipt> {
    return this.#store.putAuditBlob(input)
  }

  readJournal(query?: JournalQuery): AsyncIterable<JournalRecord> {
    return this.#store.readJournal(query)
  }

  async recordExternalEvent(event: ExternalEvent): Promise<EventReceipt> {
    const receipt = await this.#store.recordExternalEvent(event)
    if (this.#boundary === 'after-record-before-response') {
      crash()
    }
    return receipt
  }

  async transact(command: CommitCommand): Promise<CommitReceipt> {
    const receipt = await this.#store.transact(command)
    if (
      this.#boundary === 'after-admission-before-act' &&
      command.records.some(record => record.entry.kind === 'event.admitted')
    ) {
      crash()
    }
    if (this.#boundary === 'after-act-started' && command.records.some(record => record.entry.kind === 'act.started')) {
      crash()
    }
    return receipt
  }
}

interface ProcessHost {
  close(): Promise<void>
  port: number
}

type CreateProcessHost = (options: {
  faultInjector?: (stage: string) => void
  interfaceOwnerId: string
  launchToken: string
  runtime: ReturnType<typeof createRuntime>
}) => Promise<ProcessHost>

async function loadProcessHost(): Promise<CreateProcessHost> {
  const processHostUrl = new URL(
    import.meta.url.endsWith('.ts')
      ? '../../../apps/runtime/src/create-process-host.ts'
      : '../../../apps/runtime/dist/create-process-host.js',
    import.meta.url
  ).href
  const loaded = (await import(processHostUrl)) as { createProcessHost: CreateProcessHost }
  return loaded.createProcessHost
}

async function main(): Promise<void> {
  const dataDirectory = argument('data-dir')
  const now = argument('now', process.env.NOX_TEST_NOW ?? new Date().toISOString())
  const phase = argument('phase', process.env.NOX_TEST_PHASE ?? 'phase')
  const boundary = argument('crash', 'none') as CrashBoundary
  const scenario = argument('scenario', process.env.NOX_TEST_SCENARIO ?? 'first-loop') as ScriptedScenario
  const clock = new DeterministicClock(now)
  let nextStoreId = 0
  const sqlite = new SqliteStore(join(dataDirectory, 'nox.sqlite'), {
    idFactory: () => `${phase}-record-${(nextStoreId += 1)}`,
    now: () => clock.now()
  })
  try {
    await sqlite.loadSnapshot()
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('not been initialized')) {
      throw error
    }
    await sqlite.initialize(foundationSnapshot(now))
  }
  const store = new CrashInjectingStore(sqlite, boundary)
  let nextId = 0
  const runtime = createRuntime({
    clock,
    cortex: new ScriptedCortex({
      continuationDueAt: argument('continuation-due', '2026-07-12T10:05:00.000Z'),
      delayMilliseconds: Number(argument('delay-ms', '250')),
      scenario
    }),
    idFactory: () => `${phase}-id-${(nextId += 1)}`,
    store
  })
  await runtime.recover()
  if (argument('fire-due', process.env.NOX_TEST_FIRE_DUE ?? 'false') === 'true') {
    await runtime.fireDueContinuations()
  }
  const createProcessHost = await loadProcessHost()
  const host = await createProcessHost({
    ...(boundary === 'none'
      ? {}
      : {
          faultInjector: (stage: string) => {
            if (
              (boundary === 'before-event-commit' && stage === 'before-event-commit') ||
              (boundary === 'after-receipt-queue' && stage === 'after-receipt-queue') ||
              (boundary === 'after-receipt-flush' && stage === 'after-receipt-flush')
            ) {
              crash()
            }
          }
        }),
    interfaceOwnerId: argument('interface-owner'),
    launchToken: argument('launch-token', process.env.NOX_LAUNCH_TOKEN),
    runtime
  })
  if (process.env.NOX_TEST_PID_FILE !== undefined) {
    writeFileSync(process.env.NOX_TEST_PID_FILE, String(process.pid), 'utf8')
  }
  process.stdout.write(`${JSON.stringify({ pid: process.pid, port: host.port, protocolVersion: 1 })}\n`)

  const shutdown = async (): Promise<void> => {
    await host.close()
    sqlite.close()
  }
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
