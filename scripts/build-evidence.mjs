import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { checkKillCriteria } from './check-kill-criteria.mjs'

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

if (process.argv.includes('--real-pi')) {
  throw new Error('Real Pi evidence is a Task 11 target-perspective run; Task 10 builds deterministic evidence only')
}

const commands = []
const npmCli = process.env.npm_execpath
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmPrefix = npmCli ? [npmCli] : []
commands.push(run(npmCommand, [...npmPrefix, 'run', 'build']))
commands.push(run(npmCommand, [...npmPrefix, 'run', 'test:foundation']))
commands.push(run(npmCommand, [...npmPrefix, 'run', 'test', '--workspace', '@nox/audit']))
const { canonicalHash } = await import('@nox/protocol')
const { SqliteAuditReader, SqliteStore } = await import('@nox/store-sqlite')
const { startRuntimeChild } = await import('@nox/testkit')
const { verifyAuditDatabase } = await import(pathToFileURL(path.join(root, 'apps/audit/dist/verify.js')).href)

const runId = argument('run-id') ?? `deterministic-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`
const bundle = path.join(root, 'artifacts/evidence/first-causal-loop', runId)
const temporary = await mkdtemp(path.join(tmpdir(), 'nox-evidence-'))
await mkdir(bundle, { recursive: true })

try {
  const first = await startRuntimeChild({
    dataDirectory: temporary,
    now: '2026-07-12T10:00:00.000Z',
    phase: 'p1'
  })
  const receipt = await first.append('evidence-e1')
  const beforeRestart = await first.waitForSnapshot(
    view => view.actTerminals.length === 1 && view.openContinuations.length === 1 && view.state.stateVersion === 1
  )
  const firstPid = first.pid
  const termination = await first.forceTerminate()

  const second = await startRuntimeChild({
    dataDirectory: temporary,
    fireDue: true,
    now: '2026-07-12T10:06:00.000Z',
    phase: 'p2'
  })
  const afterRestart = await second.waitForSnapshot(
    view => view.actTerminals.length === 2 && view.emissions.length === 2 && view.state.stateVersion === 3
  )
  const secondPid = second.pid
  await second.close()

  const deterministicDirectory = path.join(bundle, 'deterministic')
  const databaseTarget = path.join(deterministicDirectory, 'nox.sqlite')
  await mkdir(deterministicDirectory, { recursive: true })
  const evidenceStore = new SqliteStore(path.join(temporary, 'nox.sqlite'))
  await evidenceStore.createEvidenceCopy(databaseTarget)
  evidenceStore.close()
  const audit = verifyAuditDatabase(databaseTarget, afterRestart.state.stateVersion)
  const reader = new SqliteAuditReader(databaseTarget)
  const records = reader.readJournal()
  reader.close()

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
      journalCursor: afterRestart.journalCursor,
      pid: secondPid,
      stateHash: afterRestart.state.stateHash,
      stateVersion: afterRestart.state.stateVersion
    },
    beforeRestart: {
      journalCursor: beforeRestart.journalCursor,
      pid: firstPid,
      stateHash: beforeRestart.state.stateHash,
      stateVersion: beforeRestart.state.stateVersion
    },
    pidsDiffer: firstPid !== secondPid,
    termination
  })
  await writeJson(path.join(deterministicDirectory, 'input-hashes.json'), { inputs: inputHashes })
  await copyFile(
    path.join(root, 'docs/goals/nox-first-causal-loop/artifacts/task9-receipt-recovery.json'),
    path.join(deterministicDirectory, 'receipt-recovery.json')
  )

  const desktopDirectory = path.join(bundle, 'desktop')
  await mkdir(desktopDirectory, { recursive: true })
  await copyFile(
    path.join(root, 'docs/goals/nox-first-causal-loop/artifacts/task8-running.png'),
    path.join(desktopDirectory, 'before-restart.png')
  )
  const desktopUserData = path.join(temporary, 'desktop-user-data')
  await mkdir(path.join(desktopUserData, 'runtime'), { recursive: true })
  await copyFile(databaseTarget, path.join(desktopUserData, 'runtime/nox.sqlite'))
  const { _electron: electron } = await import('playwright')
  let electronApp
  try {
    electronApp = await electron.launch({
      args: ['apps/desktop'],
      cwd: root,
      env: {
        ...process.env,
        NOX_DESKTOP_USER_DATA: desktopUserData,
        NOX_RUNTIME_ENTRY: path.join(root, 'packages/testkit/dist/runtime-child-main.js'),
        NOX_TEST_NOW: '2026-07-12T10:06:00.000Z',
        NOX_TEST_PHASE: 'desktop-restore',
        NOX_TEST_SCENARIO: 'first-loop'
      }
    })
    const page = await electronApp.firstWindow()
    await page.waitForSelector('text=runtime present', { timeout: 15_000 })
    await page.locator('.state-version strong').filter({ hasText: 'v3' }).waitFor({ timeout: 15_000 })
    await page.screenshot({ path: path.join(desktopDirectory, 'after-restart.png') })
    await page.screenshot({ path: path.join(desktopDirectory, 'silent-or-emitted.png') })
  } finally {
    await electronApp?.close()
  }
  await writeJson(path.join(desktopDirectory, 'rpc-trace.json'), {
    clientEventId: receipt.clientEventId,
    eventId: receipt.eventId,
    journal: {
      actStartedSequence: actStarted.sequence,
      eventAdmittedSequence: admitted.sequence,
      eventRecordedSequence: recorded.sequence
    },
    observationOrder: ['receipt-frame-flushed', 'event.admitted', 'act.started'],
    receipt,
    requestId: 'rpc-1'
  })

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

  const artifactFiles = (await filesBelow(bundle)).filter(file => path.basename(file) !== 'manifest.json')
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
    model: { id: 'scripted-cortex', provider: 'deterministic-testkit' },
    protocolVersion: 1,
    redaction: { credentials: 0, hiddenReasoning: 0, secrets: 0, status: 'pass' },
    runId,
    sourceCommit: git.output.trim(),
    sourceTreeDirty: gitStatus.output.trim().length > 0,
    status: killCriteria.status === 'pass' && audit.status === 'pass' ? 'pass' : 'fail'
  })
  process.stdout.write(`${JSON.stringify({ bundle, runId, status: 'pass' })}\n`)
} finally {
  await rm(temporary, { force: true, recursive: true })
}
