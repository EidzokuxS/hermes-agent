import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalHash } from '@nox/protocol'
import { SqliteAuditReader } from '@nox/store-sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { startRuntimeChild } from '../../packages/testkit/src/runtime-harness.js'

const roots: string[] = []
const before = '2026-07-12T10:00:00.000Z'
const after = '2026-07-12T10:06:00.000Z'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function runLoop() {
  const root = await mkdtemp(join(tmpdir(), 'nox-first-loop-'))
  roots.push(root)
  const first = await startRuntimeChild({ dataDirectory: root, now: before, phase: 'p1' })
  const receipt = await first.append('external-e1')
  const beforeRestart = await first.waitForSnapshot(
    view => view.actTerminals.length === 1 && view.openContinuations.length === 1 && view.state.stateVersion === 1
  )
  const firstPid = first.pid
  const termination = await first.forceTerminate()

  const second = await startRuntimeChild({ dataDirectory: root, fireDue: true, now: after, phase: 'p2' })
  const afterRestart = await second.waitForSnapshot(
    view => view.actTerminals.length === 2 && view.emissions.length === 2 && view.state.stateVersion === 3
  )
  const secondPid = second.pid
  await second.close()

  const reader = new SqliteAuditReader(join(root, 'nox.sqlite'))
  const records = reader.readJournal()
  const history = reader.verifyStateHistory()
  reader.close()
  const trace = records.map(record => ({
    entry: record.entry,
    recordHash: record.recordHash,
    sequence: record.sequence
  }))
  return {
    afterRestart,
    beforeRestart,
    firstPid,
    history,
    inputHashes: records.flatMap(record =>
      record.entry.kind === 'act.started' ? [record.entry.act.input.blobHash] : []
    ),
    receipt,
    secondPid,
    termination,
    traceHash: canonicalHash(trace)
  }
}

describe('first process-level causal loop', () => {
  it('survives a forced OS-process restart and resumes C1 in a fresh PID', async () => {
    const result = await runLoop()
    expect(result.firstPid).not.toBe(result.secondPid)
    expect(result.termination.code !== null || result.termination.signal !== null).toBe(true)
    expect(result.beforeRestart.state.state.workingField).toEqual({ phase: 'continuation-pending' })
    expect(result.afterRestart.state.state.workingField).toEqual({ phase: 'continuation-complete' })
    expect(result.afterRestart.openContinuations).toEqual([])
    expect(result.inputHashes).toHaveLength(2)
    expect(result.history).toMatchObject({ snapshots: 4, stateVersion: 3 })
    expect(result.receipt.journalSequence).toBe(1)
  }, 30_000)

  it('produces identical canonical traces and State hashes on repetition', async () => {
    const left = await runLoop()
    const right = await runLoop()
    expect(right.traceHash).toBe(left.traceHash)
    expect(right.afterRestart.state.stateHash).toBe(left.afterRestart.state.stateHash)
    expect(right.inputHashes).toEqual(left.inputHashes)
  }, 60_000)
})
