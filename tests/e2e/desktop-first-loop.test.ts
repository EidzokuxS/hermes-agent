import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _electron as electron } from 'playwright'
import type { ElectronApplication, Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function launchDesktop(
  userData: string,
  pidFile: string,
  phase: string,
  now: string,
  fireDue = false
): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({
    args: ['apps/desktop'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NOX_DESKTOP_USER_DATA: userData,
      NOX_RUNTIME_ENTRY: join(process.cwd(), 'packages/testkit/dist/runtime-child-main.js'),
      NOX_TEST_FIRE_DUE: String(fireDue),
      NOX_TEST_NOW: now,
      NOX_TEST_PHASE: phase,
      NOX_TEST_PID_FILE: pidFile,
      NOX_TEST_SCENARIO: 'first-loop'
    }
  })
  const page = await application.firstWindow()
  await page.waitForSelector('text=runtime present', { timeout: 15_000 })
  return { application, page }
}

async function runtimePid(pidFile: string): Promise<number> {
  const pid = Number(await readFile(pidFile, 'utf8'))
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid runtime PID: ${pid}`)
  }
  return pid
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Runtime process ${pid} remained alive after SIGKILL`)
}

describe('Desktop first causal loop', () => {
  it('drives E1 through the renderer and restores C1/E2/A2 after a hard runtime restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nox-desktop-first-loop-'))
    roots.push(root)
    const userData = join(root, 'desktop-user-data')
    const firstPidFile = join(root, 'runtime-p1.pid')
    const secondPidFile = join(root, 'runtime-p2.pid')

    const first = await launchDesktop(userData, firstPidFile, 'desktop-p1', '2026-07-12T10:00:00.000Z')
    let firstPid = 0
    try {
      await first.page.evaluate(() => {
        const observations: string[] = []
        const sample = (): void => {
          const delivery = [...document.querySelectorAll('.delivery')].at(-1)?.textContent?.trim()
          const act = [...document.querySelectorAll('.act-line [data-slot="badge"]')].at(-1)?.textContent?.trim()
          for (const value of [delivery && `delivery:${delivery}`, act && `act:${act}`]) {
            if (value && observations.at(-1) !== value) {
              observations.push(value)
            }
          }
        }
        new MutationObserver(sample).observe(document.body, { childList: true, subtree: true, characterData: true })
        Object.assign(window, { __noxObservations: observations })
      })
      await first.page.getByLabel('Offer Nox a request').fill('Please consider this Event, Nox.')
      await first.page.getByRole('button', { name: 'Deliver' }).click()
      await first.page.getByText('E1 was accepted and C1 was planted.').waitFor({ timeout: 15_000 })
      await first.page.locator('.state-version strong').filter({ hasText: 'v1' }).waitFor({ timeout: 15_000 })
      await first.page.locator('.continuations li').waitFor({ timeout: 15_000 })
      const observations = await first.page.evaluate(
        () => (window as unknown as { __noxObservations: string[] }).__noxObservations
      )
      expect(observations.indexOf('delivery:delivered')).toBeGreaterThanOrEqual(0)
      expect(observations.indexOf('delivery:admitted')).toBeGreaterThan(observations.indexOf('delivery:delivered'))
      expect(observations.indexOf('act:thinking')).toBeGreaterThan(observations.indexOf('delivery:admitted'))

      firstPid = await runtimePid(firstPidFile)
      process.kill(firstPid, 'SIGKILL')
      await waitForProcessExit(firstPid)
    } finally {
      await first.application.close()
    }

    const second = await launchDesktop(userData, secondPidFile, 'desktop-p2', '2026-07-12T10:06:00.000Z', true)
    try {
      await second.page.locator('.state-version strong').filter({ hasText: 'v3' }).waitFor({ timeout: 15_000 })
      expect(await second.page.getByText('E1 was accepted and C1 was planted.').count()).toBe(1)
      expect(await second.page.getByText('C1 returned through a fresh runtime process.').count()).toBe(1)
      expect(await runtimePid(secondPidFile)).not.toBe(firstPid)
    } finally {
      await second.application.close()
    }
  }, 45_000)
})
