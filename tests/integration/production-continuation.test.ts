import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPiCortexReference, resolveBuiltinPiModel } from '@nox/cortex-pi'
import { canonicalHash, PROTOCOL_VERSION, stateSnapshotSchema } from '@nox/protocol'
import type { FoundationState, JournalRecordInput } from '@nox/protocol'
import { SqliteAuditReader, SqliteStore } from '@nox/store-sqlite'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const at = '2026-07-12T08:00:00.000Z'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function foundationState(): FoundationState {
  const model = resolveBuiltinPiModel('openai', 'gpt-4o-mini')
  return {
    cortex: createPiCortexReference(model),
    identity: {
      conceptDocument: 'NOX-CONVERGENCE.md',
      identityId: 'nox',
      revision: `sha256:${'a'.repeat(64)}`
    },
    openContinuations: [],
    picture: {},
    schemaVersions: { journal: 1, protocol: 1, state: 1 },
    standingPolicies: [
      {
        adoptedAt: at,
        kind: 'attention.every-delivered-event',
        policyId: 'foundation-attention',
        provenance: { source: 'inherited', sourceDocument: 'NOX-CONVERGENCE.md' },
        status: 'active',
        version: 1
      }
    ],
    temporalAnchor: { lastObservedAt: at, logicalTick: 0 },
    workingField: {}
  }
}

async function seedDueContinuation(dataDirectory: string): Promise<string> {
  const store = new SqliteStore(join(dataDirectory, 'nox.sqlite'), { now: () => at })
  const state = foundationState()
  await store.initialize(
    stateSnapshotSchema.parse({ state, stateHash: canonicalHash(state), stateVersion: 0, throughSequence: 0 })
  )
  const decision = {
    actId: 'seed-act',
    decidedAt: at,
    decision: 'accepted',
    effect: {
      kind: 'continuation.schedule',
      protocolVersion: PROTOCOL_VERSION,
      seed: {
        due: { at, kind: 'at-time' },
        instruction: 'Resume the production continuation.',
        label: 'Production restart proof',
        maxFireCount: 1,
        protocolVersion: PROTOCOL_VERSION
      }
    },
    effectId: 'seed-effect',
    ordinal: 0,
    provenance: { component: 'production-continuation-test', kind: 'runtime' },
    stateChanging: true
  } as const
  const continuationId = `continuation:${canonicalHash({ actId: decision.actId, effectId: decision.effectId })}`
  const nextState: FoundationState = {
    ...state,
    openContinuations: [
      {
        continuationId,
        createdAt: at,
        fireCount: 0,
        originActId: decision.actId,
        seed: decision.effect.seed,
        status: 'open'
      }
    ]
  }
  const stateHash = canonicalHash(nextState)
  const records: JournalRecordInput[] = [
    {
      causal: { actId: decision.actId, causeSequences: [], eventId: 'seed-event' },
      entry: { decision, kind: 'effect.decision' },
      journalSchemaVersion: 1,
      protocolVersion: PROTOCOL_VERSION,
      provenance: decision.provenance,
      recordedAt: at
    },
    {
      causal: { actId: decision.actId, causeSequences: [], eventId: 'seed-event' },
      entry: { kind: 'state.advanced', stateHash, stateVersion: 1 },
      journalSchemaVersion: 1,
      protocolVersion: PROTOCOL_VERSION,
      provenance: decision.provenance,
      recordedAt: at
    }
  ]
  await store.transact({
    commandId: 'seed-production-continuation',
    expectedStateVersion: 0,
    nextSnapshot: { state: nextState, stateHash, stateVersion: 1 },
    protocolVersion: PROTOCOL_VERSION,
    records
  })
  store.close()
  return continuationId
}

describe('production runtime Continuation continuity', () => {
  it('fires a due persisted Continuation after process restart without a testkit fire call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nox-production-continuation-'))
    roots.push(root)
    const continuationId = await seedDueContinuation(root)
    const environment = { ...process.env }
    delete environment.NOX_PI_API_KEY
    delete environment.OPENAI_API_KEY
    const child = spawn(
      process.execPath,
      [
        'apps/runtime/dist/main.js',
        '--data-dir',
        root,
        '--launch-token',
        'production-continuation-token',
        '--interface-owner',
        'production-continuation-test',
        '--provider',
        'openai',
        '--model',
        'gpt-4o-mini'
      ],
      { cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stderr = ''
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = ''
        const onExit = (code: number | null): void => reject(new Error(`Runtime exited (${code}): ${stderr}`))
        child.once('exit', onExit)
        child.stdout.on('data', chunk => {
          stdout += String(chunk)
          if (!stdout.includes('\n')) {
            return
          }
          child.off('exit', onExit)
          resolve()
        })
      })

      let observed = false
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const reader = new SqliteAuditReader(join(root, 'nox.sqlite'))
        try {
          observed = reader.readJournal({ limit: 1000 }).some(record => {
            return (
              record.entry.kind === 'effect.decision' &&
              record.entry.decision.decision === 'accepted' &&
              record.entry.decision.effect.kind === 'continuation.fire' &&
              record.entry.decision.effect.continuationId === continuationId
            )
          })
        } finally {
          reader.close()
        }
        if (observed) {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(observed, stderr).toBe(true)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
      }
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve()
        } else {
          child.once('exit', () => resolve())
        }
      })
    }
  }, 15_000)
})
