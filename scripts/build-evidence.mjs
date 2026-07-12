/* global document, MutationObserver, window */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { checkKillCriteria } from './check-kill-criteria.mjs'
import { mergeEvidenceScanReports, scanEvidenceDatabase, scanEvidenceFiles } from './evidence-secret-scan.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  return value && !value.startsWith('--') ? value : undefined
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`)
  }
  return { command: [command, ...args].join(' '), exitCode: result.status, output: `${result.stdout}${result.stderr}` }
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function filesBelow(directory) {
  const result = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(target)
      else result.push(target)
    }
  }
  await visit(directory)
  return result.sort()
}

function recordFor(records, predicate, label) {
  const record = records.find(predicate)
  if (!record) throw new Error(`Evidence trace is missing ${label}`)
  return record
}

const commands = []
const realPiRequested = process.argv.includes('--real-pi')
const npmCli = process.env.npm_execpath
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmPrefix = npmCli ? [npmCli] : []
commands.push(run(npmCommand, [...npmPrefix, 'run', 'node:check']))
commands.push(run(npmCommand, [...npmPrefix, 'run', 'build']))
commands.push(run(npmCommand, [...npmPrefix, 'run', 'test:foundation']))
commands.push(run(npmCommand, [...npmPrefix, 'run', 'test', '--workspace', '@nox/audit']))
const { canonicalHash } = await import('@nox/protocol')
const { SqliteAuditReader, SqliteStore } = await import('@nox/store-sqlite')
const { verifyAuditDatabase } = await import(pathToFileURL(path.join(root, 'apps/audit/dist/verify.js')).href)

function rpcTraceFor(records, receipt, requestId, rawObservations) {
  const recorded = recordFor(
    records,
    record => record.entry.kind === 'event.recorded' && record.entry.event.eventId === receipt.eventId,
    `${requestId} EventRecorded`
  )
  const admitted = recordFor(
    records,
    record => record.entry.kind === 'event.admitted' && record.entry.eventId === receipt.eventId,
    `${requestId} EventAdmitted`
  )
  const started = recordFor(
    records,
    record => record.entry.kind === 'act.started' && record.entry.act.input.triggerEventId === receipt.eventId,
    `${requestId} ActStarted`
  )
  return {
    clientEventId: receipt.clientEventId,
    eventId: receipt.eventId,
    journal: {
      actStartedSequence: started.sequence,
      eventAdmittedSequence: admitted.sequence,
      eventRecordedSequence: recorded.sequence
    },
    observationOrder: requireObservedDeliveryOrder(rawObservations, requestId),
    rawObservations,
    receipt,
    requestId
  }
}

async function launchDeterministicDesktop({ fireDue, now, phase, pidFile, userData }) {
  const { _electron: electron } = await import('playwright')
  const electronApp = await electron.launch({
    args: ['apps/desktop'],
    cwd: root,
    env: {
      ...process.env,
      NOX_DESKTOP_USER_DATA: userData,
      NOX_RUNTIME_ENTRY: path.join(root, 'packages/testkit/dist/runtime-child-main.js'),
      NOX_TEST_FIRE_DUE: String(fireDue),
      NOX_TEST_NOW: now,
      NOX_TEST_PHASE: phase,
      NOX_TEST_PID_FILE: pidFile,
      NOX_TEST_SCENARIO: 'first-loop'
    }
  })
  const page = await electronApp.firstWindow()
  await page.waitForSelector('text=runtime present', { timeout: 15_000 })
  return { electronApp, page }
}

async function readRuntimePid(pidFile) {
  const pid = Number(await readFile(pidFile, 'utf8'))
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid runtime PID: ${pid}`)
  return pid
}

async function waitForProcessExit(pid) {
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

async function desktopProjection(page) {
  return page.evaluate(() => {
    const version = Number(document.querySelector('.state-version strong')?.textContent?.replace(/^v/, ''))
    const cursorText = document.querySelector('.field-heading code')?.textContent ?? ''
    const journalCursor = Number(/cursor\s+(\d+)/.exec(cursorText)?.[1])
    if (!Number.isInteger(version) || !Number.isInteger(journalCursor)) {
      throw new Error('Desktop projection did not expose a valid State version and Journal cursor')
    }
    return {
      continuations: [...document.querySelectorAll('.continuations li strong')].map(item => item.textContent?.trim()),
      emissions: [...document.querySelectorAll('.emission p')].map(item => item.textContent?.trim()),
      journalCursor,
      requests: [...document.querySelectorAll('.request-content')].map(item => item.textContent?.trim()),
      stateVersion: version
    }
  })
}

async function installDesktopObservations(page) {
  await page.evaluate(() => {
    const observations = []
    const sample = () => {
      const delivery = [...document.querySelectorAll('.delivery')].at(-1)?.textContent?.trim()
      const act = [...document.querySelectorAll('.act-line [data-slot="badge"]')].at(-1)?.textContent?.trim()
      for (const value of [delivery && `delivery:${delivery}`, act && `act:${act}`]) {
        if (value && observations.at(-1) !== value) observations.push(value)
      }
    }
    new MutationObserver(sample).observe(document.body, { childList: true, subtree: true, characterData: true })
    window.__noxObservations = observations
  })
}

async function deterministicDesktopFlow({ desktopDirectory, userData, temporary }) {
  const firstPidFile = path.join(temporary, 'desktop-runtime-p1.pid')
  const secondPidFile = path.join(temporary, 'desktop-runtime-p2.pid')
  const first = await launchDeterministicDesktop({
    fireDue: false,
    now: '2026-07-12T10:00:00.000Z',
    phase: 'evidence-desktop-p1',
    pidFile: firstPidFile,
    userData
  })
  let firstPid
  let beforeRestart
  let observations
  let observationOrder
  try {
    await installDesktopObservations(first.page)
    await first.page.getByLabel('Offer Nox a request').fill('Please consider this Event, Nox.')
    await first.page.getByRole('button', { name: 'Deliver' }).click()
    await first.page.getByText('E1 was accepted and C1 was planted.').waitFor({ timeout: 15_000 })
    await first.page.locator('.state-version strong').filter({ hasText: 'v1' }).waitFor({ timeout: 15_000 })
    await first.page.locator('.continuations li').waitFor({ timeout: 15_000 })
    observations = await first.page.evaluate(() => window.__noxObservations)
    observationOrder = requireObservedDeliveryOrder(observations, 'Deterministic Desktop Act')
    beforeRestart = await desktopProjection(first.page)
    await first.page.screenshot({ path: path.join(desktopDirectory, 'before-restart.png') })
    firstPid = await readRuntimePid(firstPidFile)
    process.kill(firstPid, 'SIGKILL')
    await waitForProcessExit(firstPid)
  } finally {
    await first.electronApp.close()
  }

  const second = await launchDeterministicDesktop({
    fireDue: true,
    now: '2026-07-12T10:06:00.000Z',
    phase: 'evidence-desktop-p2',
    pidFile: secondPidFile,
    userData
  })
  let afterRestart
  let secondPid
  try {
    await second.page.locator('.state-version strong').filter({ hasText: 'v3' }).waitFor({ timeout: 15_000 })
    await second.page.getByText('E1 was accepted and C1 was planted.').waitFor({ timeout: 15_000 })
    await second.page.getByText('C1 returned through a fresh runtime process.').waitFor({ timeout: 15_000 })
    afterRestart = await desktopProjection(second.page)
    secondPid = await readRuntimePid(secondPidFile)
    await second.page.screenshot({ path: path.join(desktopDirectory, 'after-restart.png') })
    await second.page
      .locator('.emission')
      .last()
      .screenshot({ path: path.join(desktopDirectory, 'silent-or-emitted.png') })
  } finally {
    await second.electronApp.close()
  }

  return {
    afterRestart,
    beforeRestart,
    firstPid,
    observationOrder,
    rawObservations: observations,
    secondPid,
    termination: { code: null, observedExited: true, signal: 'SIGKILL' }
  }
}

function requireObservedDeliveryOrder(observations, label) {
  const delivered = observations.indexOf('delivery:delivered')
  const admitted = observations.indexOf('delivery:admitted')
  const thinking = observations.indexOf('act:thinking')
  if (!(delivered >= 0 && admitted > delivered && thinking > admitted)) {
    throw new Error(`${label} did not observe receipt -> admission -> Act order: ${JSON.stringify(observations)}`)
  }
  return ['receipt-frame-flushed', 'event.admitted', 'act.started']
}

async function launchRealDesktop({ model, pidFile, provider, userData }) {
  const { _electron: electron } = await import('playwright')
  const electronApp = await electron.launch({
    args: ['apps/desktop'],
    cwd: root,
    env: {
      ...process.env,
      NOX_DESKTOP_RUNTIME_PID_FILE: pidFile,
      NOX_DESKTOP_USER_DATA: userData,
      NOX_PI_API_KEY: process.env.NOX_PI_API_KEY,
      NOX_PI_MODEL: model,
      NOX_PI_PROVIDER: provider
    }
  })
  const page = await electronApp.firstWindow()
  await page.waitForSelector('text=runtime present', { timeout: 15_000 })
  return { electronApp, page }
}

async function waitForRealTerminal(page, ordinal) {
  await page.waitForFunction(
    expectedOrdinal => {
      const entries = [...document.querySelectorAll('.causal-entry')]
      const label = entries[expectedOrdinal - 1]?.querySelector('.act-line [data-slot="badge"]')?.textContent?.trim()
      return ['failed', 'rejected', 'settled', 'silent'].includes(label ?? '')
    },
    ordinal,
    { timeout: 180_000 }
  )
  const label = await page
    .locator('.causal-entry')
    .nth(ordinal - 1)
    .locator('.act-line [data-slot="badge"]')
    .textContent()
  if (label?.trim() !== 'settled' && label?.trim() !== 'silent') {
    const detail = await page
      .locator('.causal-entry')
      .nth(ordinal - 1)
      .textContent()
    throw new Error(`Real Pi Act ${ordinal} did not settle successfully: ${detail}`)
  }
  return label.trim()
}

async function realDesktopFlow({ desktopDirectory, model, provider, temporary, userData }) {
  await mkdir(desktopDirectory, { recursive: true })
  const firstPidFile = path.join(temporary, 'real-desktop-runtime-p1.pid')
  const secondPidFile = path.join(temporary, 'real-desktop-runtime-p2.pid')
  const first = await launchRealDesktop({ model, pidFile: firstPidFile, provider, userData })
  let beforeRestart
  let firstObservations
  let firstPid
  let firstStatus
  try {
    await installDesktopObservations(first.page)
    await first.page
      .getByLabel('Offer Nox a request')
      .fill(
        'Observe this delivered Event and settle exactly one bounded Nox Act. Use propose_act once; an emission or explicit silence is valid.'
      )
    await first.page.getByRole('button', { name: 'Deliver' }).click()
    firstStatus = await waitForRealTerminal(first.page, 1)
    firstObservations = await first.page.evaluate(() => window.__noxObservations)
    requireObservedDeliveryOrder(firstObservations, 'First real Pi Desktop Act')
    beforeRestart = await desktopProjection(first.page)
    await first.page.screenshot({ path: path.join(desktopDirectory, 'before-restart.png') })
    firstPid = await readRuntimePid(firstPidFile)
    process.kill(firstPid, 'SIGKILL')
    await waitForProcessExit(firstPid)
  } finally {
    await first.electronApp.close()
  }

  const second = await launchRealDesktop({ model, pidFile: secondPidFile, provider, userData })
  let afterRestart
  let secondObservations
  let secondPid
  let secondStatus
  try {
    await installDesktopObservations(second.page)
    await second.page
      .getByLabel('Offer Nox a request')
      .fill(
        'This Event arrived after a hard runtime restart. Observe restored State and settle exactly one bounded Nox Act with propose_act once.'
      )
    await second.page.getByRole('button', { name: 'Deliver' }).click()
    secondStatus = await waitForRealTerminal(second.page, 2)
    secondObservations = await second.page.evaluate(() => window.__noxObservations)
    requireObservedDeliveryOrder(secondObservations, 'Second real Pi Desktop Act')
    afterRestart = await desktopProjection(second.page)
    secondPid = await readRuntimePid(secondPidFile)
    await second.page.screenshot({ path: path.join(desktopDirectory, 'after-restart.png') })
    const outcome = second.page.locator('.emission').last()
    if ((await outcome.count()) > 0) {
      await outcome.screenshot({ path: path.join(desktopDirectory, 'silent-or-emitted.png') })
    } else {
      await second.page
        .locator('.silent-settlement')
        .last()
        .screenshot({ path: path.join(desktopDirectory, 'silent-or-emitted.png') })
    }
  } finally {
    await second.electronApp.close()
  }

  return {
    afterRestart,
    beforeRestart,
    firstObservations,
    firstPid,
    secondObservations,
    secondPid,
    statuses: [firstStatus, secondStatus],
    termination: { code: null, observedExited: true, signal: 'SIGKILL' }
  }
}

const runId = argument('run-id') ?? `deterministic-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`
const bundle = path.join(root, 'artifacts/evidence/first-causal-loop', runId)
const temporary = await mkdtemp(path.join(tmpdir(), 'nox-evidence-'))
await mkdir(bundle, { recursive: true })

try {
  const desktopDirectory = path.join(bundle, 'desktop')
  await mkdir(desktopDirectory, { recursive: true })
  const desktopUserData = path.join(temporary, 'desktop-user-data')
  const desktopFlow = await deterministicDesktopFlow({ desktopDirectory, temporary, userData: desktopUserData })
  const deterministicDirectory = path.join(bundle, 'deterministic')
  const databaseTarget = path.join(deterministicDirectory, 'nox.sqlite')
  await mkdir(deterministicDirectory, { recursive: true })
  const evidenceStore = new SqliteStore(path.join(desktopUserData, 'runtime/nox.sqlite'))
  await evidenceStore.createEvidenceCopy(databaseTarget)
  evidenceStore.close()
  const audit = verifyAuditDatabase(databaseTarget, desktopFlow.afterRestart.stateVersion)
  const reader = new SqliteAuditReader(databaseTarget)
  const records = reader.readAllJournal()
  const receipts = reader.readExternalReceipts()
  const beforeSnapshot = reader.loadSnapshot(desktopFlow.beforeRestart.stateVersion)
  const afterSnapshot = reader.loadSnapshot(desktopFlow.afterRestart.stateVersion)
  reader.close()
  if (receipts.length !== 1) throw new Error(`Expected one Desktop-delivered Event receipt, found ${receipts.length}`)
  const receipt = receipts[0]

  const recorded = recordFor(
    records,
    record => record.entry.kind === 'event.recorded' && record.entry.event.eventId === receipt.eventId,
    'E1 EventRecorded'
  )
  const admitted = recordFor(
    records,
    record => record.entry.kind === 'event.admitted' && record.entry.eventId === receipt.eventId,
    'E1 EventAdmitted'
  )
  const actStarted = recordFor(
    records,
    record => record.entry.kind === 'act.started' && record.entry.act.input.triggerEventId === receipt.eventId,
    'E1 ActStarted'
  )
  const inputHashes = records.flatMap(record =>
    record.entry.kind === 'act.started'
      ? [{ actId: record.entry.act.actId, inputHash: record.entry.act.input.blobHash }]
      : []
  )

  await writeJson(path.join(deterministicDirectory, 'causal-trace.json'), {
    canonicalTraceHash: canonicalHash(records),
    records
  })
  await writeJson(path.join(deterministicDirectory, 'replay-report.json'), {
    integrity: audit.integrity,
    stateHistory: audit.stateHistory,
    status: audit.status
  })
  await writeJson(path.join(deterministicDirectory, 'state-replay.json'), audit.replay)
  await writeJson(path.join(deterministicDirectory, 'process-restart.json'), {
    afterRestart: {
      journalCursor: desktopFlow.afterRestart.journalCursor,
      pid: desktopFlow.secondPid,
      stateHash: afterSnapshot.stateHash,
      stateVersion: desktopFlow.afterRestart.stateVersion
    },
    beforeRestart: {
      journalCursor: desktopFlow.beforeRestart.journalCursor,
      pid: desktopFlow.firstPid,
      stateHash: beforeSnapshot.stateHash,
      stateVersion: desktopFlow.beforeRestart.stateVersion
    },
    pidsDiffer: desktopFlow.firstPid !== desktopFlow.secondPid,
    termination: desktopFlow.termination
  })
  await writeJson(path.join(deterministicDirectory, 'input-hashes.json'), { inputs: inputHashes })
  await copyFile(
    path.join(root, 'docs/goals/nox-first-causal-loop/artifacts/task9-receipt-recovery.json'),
    path.join(deterministicDirectory, 'receipt-recovery.json')
  )

  await writeJson(path.join(desktopDirectory, 'rpc-trace.json'), {
    clientEventId: receipt.clientEventId,
    eventId: receipt.eventId,
    journal: {
      actStartedSequence: actStarted.sequence,
      eventAdmittedSequence: admitted.sequence,
      eventRecordedSequence: recorded.sequence
    },
    observationOrder: desktopFlow.observationOrder,
    rawObservations: desktopFlow.rawObservations,
    receipt,
    requestId: 'rpc-1'
  })
  await writeJson(path.join(desktopDirectory, 'capture-report.json'), {
    afterRestart: {
      ...desktopFlow.afterRestart,
      screenshot: 'desktop/after-restart.png',
      screenshotSha256: digest(await readFile(path.join(desktopDirectory, 'after-restart.png'))),
      stateHash: afterSnapshot.stateHash
    },
    beforeRestart: {
      ...desktopFlow.beforeRestart,
      screenshot: 'desktop/before-restart.png',
      screenshotSha256: digest(await readFile(path.join(desktopDirectory, 'before-restart.png'))),
      stateHash: beforeSnapshot.stateHash
    },
    outcome: {
      screenshot: 'desktop/silent-or-emitted.png',
      screenshotSha256: digest(await readFile(path.join(desktopDirectory, 'silent-or-emitted.png'))),
      settlement: 'completed-with-emission'
    }
  })

  let realPiStatus = realPiRequested ? 'fail' : 'not-requested'
  const realProvider = process.env.NOX_PI_PROVIDER ?? 'openai-codex'
  const realModel = process.env.NOX_PI_MODEL ?? 'gpt-5.4-mini'
  if (realPiRequested) {
    const realDirectory = path.join(bundle, 'real-pi')
    const realDesktopDirectory = path.join(realDirectory, 'desktop')
    const realUserData = path.join(temporary, 'real-pi-desktop-user-data')
    const realDatabase = path.join(realUserData, 'runtime/nox.sqlite')
    await mkdir(realDirectory, { recursive: true })
    try {
      if (!process.env.NOX_PI_API_KEY) throw new Error('NOX_PI_API_KEY is required for a real Pi evidence run')
      const realFlow = await realDesktopFlow({
        desktopDirectory: realDesktopDirectory,
        model: realModel,
        provider: realProvider,
        temporary,
        userData: realUserData
      })
      const realDatabaseTarget = path.join(realDirectory, 'nox.sqlite')
      const finalStore = new SqliteStore(realDatabase)
      await finalStore.createEvidenceCopy(realDatabaseTarget)
      finalStore.close()
      const realReader = new SqliteAuditReader(realDatabaseTarget)
      const realRecords = realReader.readAllJournal()
      const realReceipts = realReader.readExternalReceipts()
      const realTerminals = realRecords.flatMap(record =>
        record.entry.kind === 'act.terminal' ? [record.entry.terminal] : []
      )
      if (realReceipts.length !== 2 || realTerminals.length !== 2) {
        throw new Error(
          `Real Pi Desktop run expected two receipts and terminals, found ${realReceipts.length}/${realTerminals.length}`
        )
      }
      const realBeforeSnapshot = realReader.loadSnapshot(realFlow.beforeRestart.stateVersion)
      const realAfterSnapshot = realReader.loadSnapshot(realFlow.afterRestart.stateVersion)
      realReader.close()
      const realAudit = verifyAuditDatabase(realDatabaseTarget, realFlow.afterRestart.stateVersion)
      const realInputs = realRecords.flatMap(record =>
        record.entry.kind === 'act.started'
          ? [{ actId: record.entry.act.actId, inputHash: record.entry.act.input.blobHash }]
          : []
      )
      await writeJson(path.join(realDirectory, 'causal-trace.json'), {
        canonicalTraceHash: canonicalHash(realRecords),
        records: realRecords
      })
      await writeJson(path.join(realDirectory, 'state-replay.json'), realAudit.replay)
      await writeJson(path.join(realDirectory, 'process-restart.json'), {
        afterRestart: {
          journalCursor: realFlow.afterRestart.journalCursor,
          pid: realFlow.secondPid,
          stateHash: realAfterSnapshot.stateHash,
          stateVersion: realFlow.afterRestart.stateVersion
        },
        beforeRestart: {
          journalCursor: realFlow.beforeRestart.journalCursor,
          pid: realFlow.firstPid,
          stateHash: realBeforeSnapshot.stateHash,
          stateVersion: realFlow.beforeRestart.stateVersion
        },
        pidsDiffer: realFlow.firstPid !== realFlow.secondPid,
        termination: realFlow.termination
      })
      await writeJson(path.join(realDirectory, 'input-hashes.json'), { inputs: realInputs })
      await writeJson(path.join(realDirectory, 'real-pi-run.json'), {
        attemptsPerAct: 1,
        model: realModel,
        provider: realProvider,
        statuses: realTerminals.map(terminal => terminal.status),
        status: 'pass'
      })
      await writeJson(path.join(realDirectory, 'rpc-trace.json'), {
        requests: [
          rpcTraceFor(realRecords, realReceipts[0], 'rpc-1', realFlow.firstObservations),
          rpcTraceFor(realRecords, realReceipts[1], 'rpc-2', realFlow.secondObservations)
        ]
      })
      await writeJson(path.join(realDesktopDirectory, 'capture-report.json'), {
        afterRestart: {
          ...realFlow.afterRestart,
          screenshot: 'real-pi/desktop/after-restart.png',
          screenshotSha256: digest(await readFile(path.join(realDesktopDirectory, 'after-restart.png'))),
          stateHash: realAfterSnapshot.stateHash
        },
        beforeRestart: {
          ...realFlow.beforeRestart,
          screenshot: 'real-pi/desktop/before-restart.png',
          screenshotSha256: digest(await readFile(path.join(realDesktopDirectory, 'before-restart.png'))),
          stateHash: realBeforeSnapshot.stateHash
        },
        outcome: {
          screenshot: 'real-pi/desktop/silent-or-emitted.png',
          screenshotSha256: digest(await readFile(path.join(realDesktopDirectory, 'silent-or-emitted.png'))),
          settlement: realFlow.statuses[1]
        }
      })
      realPiStatus = 'pass'
    } catch (error) {
      if (await stat(realDatabase).catch(() => undefined)) {
        const failedStore = new SqliteStore(realDatabase)
        await failedStore.createEvidenceCopy(path.join(realDirectory, 'nox.sqlite'))
        failedStore.close()
      }
      await writeJson(path.join(realDirectory, 'real-pi-run.json'), {
        error: error instanceof Error ? error.message : String(error),
        model: realModel,
        provider: realProvider,
        status: 'fail'
      })
    }
  }

  const reviewsDirectory = path.join(bundle, 'reviews')
  const killCriteria = await checkKillCriteria()
  await writeJson(path.join(reviewsDirectory, 'kill-criteria.json'), killCriteria)
  await writeJson(path.join(reviewsDirectory, 'production-graph.json'), {
    ...killCriteria.productionGraph,
    sourceFiles: killCriteria.sourceFiles,
    status: killCriteria.status
  })

  const git = run('git', ['rev-parse', 'HEAD'])
  const gitStatus = run('git', ['status', '--short'])
  const npmVersion = run(npmCommand, [...npmPrefix, '--version'])
  const lockBytes = await readFile(path.join(root, 'package-lock.json'))
  await writeJson(path.join(bundle, 'versions.json'), {
    dependencyLockSha256: digest(lockBytes),
    evidenceLane: realPiRequested ? 'full' : 'deterministic',
    node: process.version,
    npm: npmVersion.output.trim(),
    protocolVersion: 1,
    sourceCommit: git.output.trim(),
    sourceTreeDirty: gitStatus.output.trim().length > 0
  })
  await writeFile(
    path.join(bundle, 'commands.log'),
    `${commands.map(command => `${command.command}\texit=${command.exitCode}`).join('\n')}\n`,
    'utf8'
  )

  const evidenceDatabases = [databaseTarget, path.join(bundle, 'real-pi/nox.sqlite')]
  const databaseRedactionReports = []
  for (const databasePath of evidenceDatabases) {
    if (await stat(databasePath).catch(() => undefined)) {
      databaseRedactionReports.push(await scanEvidenceDatabase(databasePath))
    }
    await rm(`${databasePath}-shm`, { force: true })
    await rm(`${databasePath}-wal`, { force: true })
  }

  const artifactFiles = (await filesBelow(bundle)).filter(file => path.basename(file) !== 'manifest.json')
  const redaction = mergeEvidenceScanReports(await scanEvidenceFiles(artifactFiles), ...databaseRedactionReports)
  const artifacts = []
  for (const file of artifactFiles) {
    const bytes = await readFile(file)
    artifacts.push({
      bytes: (await stat(file)).size,
      path: path.relative(bundle, file).replaceAll('\\', '/'),
      sha256: digest(bytes)
    })
  }
  await writeJson(path.join(bundle, 'manifest.json'), {
    artifacts,
    commands: commands.map(({ command, exitCode }) => ({ command, exitCode })),
    dependencyLockSha256: digest(lockBytes),
    evidenceLane: realPiRequested ? 'full' : 'deterministic',
    model: realPiRequested
      ? { id: realModel, provider: realProvider }
      : { id: 'scripted-cortex', provider: 'deterministic-testkit' },
    protocolVersion: 1,
    redaction,
    runId,
    sourceCommit: git.output.trim(),
    sourceTreeDirty: gitStatus.output.trim().length > 0,
    status:
      killCriteria.status === 'pass' &&
      audit.status === 'pass' &&
      redaction.status === 'pass' &&
      (!realPiRequested || realPiStatus === 'pass')
        ? 'pass'
        : 'fail'
  })
  const status =
    killCriteria.status === 'pass' &&
    audit.status === 'pass' &&
    redaction.status === 'pass' &&
    (!realPiRequested || realPiStatus === 'pass')
      ? 'pass'
      : 'fail'
  process.stdout.write(`${JSON.stringify({ bundle, runId, status })}\n`)
  if (status !== 'pass') process.exitCode = 1
} finally {
  await rm(temporary, { force: true, recursive: true })
}
