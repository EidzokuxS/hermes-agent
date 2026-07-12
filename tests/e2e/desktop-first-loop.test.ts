import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteStore } from '@nox/store-sqlite'
import { _electron as electron } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'

import { startRuntimeChild } from '../../packages/testkit/src/runtime-harness.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe('Desktop first causal loop', () => {
  it('restores E1/A1 and continuation E2/A2 from the same database after a hard process restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nox-desktop-first-loop-'))
    roots.push(root)
    const dataDirectory = join(root, 'runtime-source')
    const first = await startRuntimeChild({
      dataDirectory,
      now: '2026-07-12T10:00:00.000Z',
      phase: 'p1'
    })
    await first.append('desktop-first-e1')
    await first.waitForSnapshot(
      view => view.actTerminals.length === 1 && view.openContinuations.length === 1 && view.state.stateVersion === 1
    )
    await first.forceTerminate()

    const second = await startRuntimeChild({
      dataDirectory,
      fireDue: true,
      now: '2026-07-12T10:06:00.000Z',
      phase: 'p2'
    })
    await second.waitForSnapshot(
      view => view.actTerminals.length === 2 && view.emissions.length === 2 && view.state.stateVersion === 3
    )
    await second.close()

    const userData = join(root, 'desktop-user-data')
    await mkdir(join(userData, 'runtime'), { recursive: true })
    const store = new SqliteStore(join(dataDirectory, 'nox.sqlite'))
    await store.createEvidenceCopy(join(userData, 'runtime/nox.sqlite'))
    store.close()

    const application = await electron.launch({
      args: ['apps/desktop'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        NOX_DESKTOP_USER_DATA: userData,
        NOX_RUNTIME_ENTRY: join(process.cwd(), 'packages/testkit/dist/runtime-child-main.js'),
        NOX_TEST_NOW: '2026-07-12T10:06:00.000Z',
        NOX_TEST_PHASE: 'desktop-proof',
        NOX_TEST_SCENARIO: 'first-loop'
      }
    })
    try {
      const page = await application.firstWindow()
      await page.waitForSelector('text=runtime present', { timeout: 15_000 })
      await page.locator('.state-version strong').filter({ hasText: 'v3' }).waitFor({ timeout: 15_000 })
      expect(await page.getByText('E1 was accepted and C1 was planted.').count()).toBe(1)
      expect(await page.getByText('C1 returned through a fresh runtime process.').count()).toBe(1)
    } finally {
      await application.close()
    }
  }, 45_000)
})
