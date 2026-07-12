import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { actCancelResultSchema, PROTOCOL_VERSION } from '@nox/protocol'
import { SqliteAuditReader } from '@nox/store-sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { startRuntimeChild } from '../../packages/testkit/src/runtime-harness.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe('process-level negative causal paths', () => {
  it('fences late Cortex output after committed cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nox-cancel-fence-'))
    roots.push(root)
    const child = await startRuntimeChild({
      dataDirectory: root,
      delayMilliseconds: 400,
      now: '2026-07-12T10:00:00.000Z',
      phase: 'cancel',
      scenario: 'blocking'
    })
    await child.append('cancel-event')
    const running = await child.waitForSnapshot(view => view.currentAct !== undefined)
    const actId = running.currentAct?.actId
    expect(actId).toBeDefined()
    const cancellation = actCancelResultSchema.parse(
      await child.client.call({
        method: 'act.cancel',
        params: { actId: actId!, protocolVersion: PROTOCOL_VERSION, reason: 'Deterministic cancellation fence' }
      })
    )
    expect(cancellation.requested).toBe(true)
    const settled = await child.waitForSnapshot(view => view.actTerminals.some(act => act.status === 'cancelled'))
    expect(settled.emissions).toHaveLength(0)
    await child.close()

    const reader = new SqliteAuditReader(join(root, 'nox.sqlite'))
    const records = reader.readJournal()
    reader.close()
    expect(records.filter(record => record.entry.kind === 'act.cancel-requested')).toHaveLength(1)
    expect(records.filter(record => record.entry.kind === 'act.late-output-diagnostic')).toHaveLength(1)
    expect(records.filter(record => record.entry.kind === 'effect.decision')).toHaveLength(0)
    expect(records.filter(record => record.entry.kind === 'act.terminal')).toHaveLength(1)
  }, 30_000)

  it('records a malformed proposal as a rejected terminal without State mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nox-invalid-proposal-'))
    roots.push(root)
    const child = await startRuntimeChild({
      dataDirectory: root,
      now: '2026-07-12T10:00:00.000Z',
      phase: 'invalid',
      scenario: 'invalid'
    })
    await child.append('invalid-event')
    const settled = await child.waitForSnapshot(view => view.actTerminals.length === 1)
    expect(settled.actTerminals[0]).toMatchObject({ code: 'schema-invalid', status: 'rejected' })
    expect(settled.state.stateVersion).toBe(0)
    await child.close()

    const reader = new SqliteAuditReader(join(root, 'nox.sqlite'))
    const records = reader.readJournal()
    reader.close()
    expect(records.filter(record => record.entry.kind === 'effect.decision')).toHaveLength(0)
    expect(records.filter(record => record.entry.kind === 'state.advanced')).toHaveLength(0)
  }, 30_000)

  it('keeps a rejected Effect in the raw audit while excluding it from State', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nox-rejected-effect-'))
    roots.push(root)
    const child = await startRuntimeChild({
      dataDirectory: root,
      now: '2026-07-12T10:00:00.000Z',
      phase: 'rejected-effect',
      scenario: 'rejected-effect'
    })
    await child.append('rejected-effect-event')
    const settled = await child.waitForSnapshot(view => view.actTerminals.length === 1)
    expect(settled.state.stateVersion).toBe(0)
    expect(settled.emissions).toHaveLength(1)
    await child.close()

    const reader = new SqliteAuditReader(join(root, 'nox.sqlite'))
    const rejected = reader.readRejectedEffects()
    const records = reader.readJournal()
    reader.close()
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.entry).toMatchObject({ decision: { decision: 'rejected' }, kind: 'effect.decision' })
    expect(records.filter(record => record.entry.kind === 'state.advanced')).toHaveLength(0)
  }, 30_000)
})
