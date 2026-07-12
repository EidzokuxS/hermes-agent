import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteAuditReader } from '@nox/store-sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import type { CrashBoundary } from '../../packages/testkit/src/runtime-child-main.js'
import { startRuntimeChild } from '../../packages/testkit/src/runtime-harness.js'

const roots: string[] = []
const boundaries: CrashBoundary[] = [
  'before-event-commit',
  'after-record-before-response',
  'after-receipt-queue',
  'after-receipt-flush',
  'after-admission-before-act',
  'after-act-started'
]

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function counts(databasePath: string) {
  const reader = new SqliteAuditReader(databasePath)
  const records = reader.readJournal()
  reader.close()
  return {
    acts: records.filter(record => record.entry.kind === 'act.started').length,
    admissions: records.filter(record => record.entry.kind === 'event.admitted').length,
    events: records.filter(record => record.entry.kind === 'event.recorded').length,
    terminals: records.filter(record => record.entry.kind === 'act.terminal').length
  }
}

describe('receipt recovery crash matrix', () => {
  for (const boundary of boundaries) {
    it(`recovers exactly once from ${boundary}`, async () => {
      const root = await mkdtemp(join(tmpdir(), `nox-receipt-${boundary}-`))
      roots.push(root)
      const databasePath = join(root, 'nox.sqlite')
      const crashed = await startRuntimeChild({
        crashBoundary: boundary,
        dataDirectory: root,
        now: '2026-07-12T10:00:00.000Z',
        phase: `crash-${boundary}`
      })
      let receiptObserved = false
      try {
        await crashed.append('matrix-event')
        receiptObserved = true
      } catch {
        // A process ending before the receipt callback is the expected fault surface.
      }
      await crashed.forceTerminate()

      const beforeRecovery = counts(databasePath)
      if (
        boundary === 'before-event-commit' ||
        boundary === 'after-record-before-response' ||
        boundary === 'after-receipt-queue' ||
        boundary === 'after-receipt-flush'
      ) {
        expect(beforeRecovery.admissions).toBe(0)
        expect(beforeRecovery.acts).toBe(0)
      }
      if (boundary === 'before-event-commit' || boundary === 'after-record-before-response') {
        expect(receiptObserved).toBe(false)
      }
      // At after-receipt-queue the peer may observe buffered bytes before the
      // sender callback runs. Admission must still remain zero either way.
      if (boundary === 'after-receipt-flush') {
        expect(receiptObserved).toBe(true)
      }
      if (boundary === 'after-admission-before-act') {
        expect(beforeRecovery).toMatchObject({ acts: 0, admissions: 1, events: 1 })
        expect(receiptObserved).toBe(true)
      }
      if (boundary === 'after-act-started') {
        expect(beforeRecovery).toMatchObject({ acts: 1, admissions: 1, events: 1, terminals: 0 })
        expect(receiptObserved).toBe(true)
      }

      const recovered = await startRuntimeChild({
        dataDirectory: root,
        now: '2026-07-12T10:01:00.000Z',
        phase: `recover-${boundary}`
      })
      if (boundary === 'before-event-commit') {
        await recovered.append('matrix-event')
      } else {
        await recovered.snapshot()
      }
      await recovered.waitForSnapshot(view => view.actTerminals.length === 1)
      await recovered.close()

      expect(counts(databasePath)).toEqual({ acts: 1, admissions: 1, events: 1, terminals: 1 })
    }, 30_000)
  }
})
