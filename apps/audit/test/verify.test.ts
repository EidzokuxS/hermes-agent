import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { startRuntimeChild } from '../../../packages/testkit/src/runtime-harness.js'
import { replayState } from '../src/state-replay.js'
import { verifyAuditDatabase } from '../src/verify.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe('independent audit replay', () => {
  it('replays a production-kernel database from genesis and rejects a tampered snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nox-audit-replay-'))
    roots.push(root)
    const child = await startRuntimeChild({
      dataDirectory: root,
      now: '2026-07-12T10:00:00.000Z',
      phase: 'audit'
    })
    await child.append('audit-event')
    await child.waitForSnapshot(view => view.state.stateVersion === 1)
    await child.close()

    const report = verifyAuditDatabase(join(root, 'nox.sqlite'), 1)
    expect(report).toMatchObject({ integrity: 'ok', replay: { finalStateVersion: 1, status: 'pass' } })
    const tampered = {
      ...report.raw,
      snapshots: report.raw.snapshots.map(snapshot =>
        snapshot.stateVersion === 1 ? { ...snapshot, stateHash: `sha256:${'0'.repeat(64)}` } : snapshot
      )
    }
    expect(() => replayState(tampered)).toThrow()
  }, 30_000)

  it('counts rejected Effects without replaying them into State', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nox-audit-rejected-'))
    roots.push(root)
    const child = await startRuntimeChild({
      dataDirectory: root,
      now: '2026-07-12T10:00:00.000Z',
      phase: 'audit-rejected',
      scenario: 'rejected-effect'
    })
    await child.append('audit-rejected-event')
    await child.waitForSnapshot(view => view.actTerminals.length === 1)
    await child.close()

    const report = verifyAuditDatabase(join(root, 'nox.sqlite'), 0)
    expect(report.replay).toMatchObject({ acceptedStateEffects: 0, finalStateVersion: 0, rejectedEffects: 1 })
  }, 30_000)
})
