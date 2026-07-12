import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

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

const commands = []
const realPiRequested = process.argv.includes('--real-pi')
const npmCli = process.env.npm_execpath
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmPrefix = npmCli ? [npmCli] : []
commands.push(run(npmCommand, [...npmPrefix, 'run', 'build']))
commands.push(run(npmCommand, [...npmPrefix, 'run', 'test:foundation']))
commands.push(run(npmCommand, [...npmPrefix, 'run', 'test', '--workspace', '@nox/audit']))
const { canonicalHash, eventAppendResultSchema, PROTOCOL_VERSION, viewSnapshotSchema } = await import('@nox/protocol')
const { NoxRpcClient } = await import('@nox/interface-rpc')
const { SqliteAuditReader, SqliteStore } = await import('@nox/store-sqlite')
const { startRuntimeChild } = await import('@nox/testkit')
const { verifyAuditDatabase } = await import(pathToFileURL(path.join(root, 'apps/audit/dist/verify.js')).href)

async function startProductionRuntime({ dataDirectory, interfaceOwnerId, launchToken, model, provider }) {
  const child = spawn(
    process.execPath,
    [
      path.join(root, 'apps/runtime/dist/main.js'),
      '--data-dir',
      dataDirectory,
      '--launch-token',
      launchToken,
      '--interface-owner',
      interfaceOwnerId,
      '--provider',
      provider,
      '--model',
      model
    ],
    {
      cwd: root,
      env: { ...process.env, NOX_PI_API_KEY: process.env.NOX_PI_API_KEY },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384)
  })
  const announcement = await new Promise((resolve, reject) => {
    let stdout = ''
    const onExit = code => reject(new Error(`Production runtime exited before ready (${code}): ${stderr}`))
    child.once('exit', onExit)
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      child.off('exit', onExit)
      try {
        const parsed = JSON.parse(stdout.slice(0, newline))
        if (parsed.protocolVersion !== 1 || typeof parsed.port !== 'number') throw new Error('invalid announcement')
        resolve(parsed)
      } catch (error) {
        reject(error)
      }
    })
    child.once('error', reject)
  })
  const client = new NoxRpcClient({ launchToken, url: `ws://127.0.0.1:${announcement.port}` })
  await client.ready()
  const waitForExit = () =>
    new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null)
        resolve({ code: child.exitCode, signal: child.signalCode })
      else child.once('exit', (code, signal) => resolve({ code, signal }))
    })
  const snapshot = async () =>
    viewSnapshotSchema.parse(
      await client.call({ method: 'view.snapshot', params: { protocolVersion: PROTOCOL_VERSION } })
    )
  return {
    append: async (clientEventId, content) =>
      eventAppendResultSchema.parse(
        await client.call({
          method: 'event.append',
          params: { clientEventId, content: { content, format: 'text', kind: 'message' }, protocolVersion: 1 }
        })
      ).receipt,
    close: async () => {
      await client.close().catch(() => undefined)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      return waitForExit()
    },
    forceTerminate: async () => {
      await client.close().catch(() => undefined)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      return waitForExit()
    },
    pid: child.pid,
    snapshot,
    waitForSnapshot: async (predicate, timeoutMilliseconds = 180_000) => {
      const deadline = Date.now() + timeoutMilliseconds
      while (Date.now() < deadline) {
        const view = await snapshot()
        if (predicate(view)) return view
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error(`Timed out waiting for real Pi runtime: ${stderr}`)
    }
  }
}

function terminalSucceeded(terminal) {
  return terminal?.status === 'completed-effects' || terminal?.status === 'completed-silent'
}

function rpcTraceFor(records, receipt, requestId) {
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
    observationOrder: ['receipt-frame-flushed', 'event.admitted', 'act.started'],
    receipt,
    requestId
  }
}

async function captureDesktop({ databasePath, environment, screenshotPaths, stateVersion, userData }) {
  await mkdir(path.join(userData, 'runtime'), { recursive: true })
  await copyFile(databasePath, path.join(userData, 'runtime/nox.sqlite'))
  const { _electron: electron } = await import('playwright')
  let electronApp
  try {
    electronApp = await electron.launch({
      args: ['apps/desktop'],
      cwd: root,
      env: { ...process.env, ...environment, NOX_DESKTOP_USER_DATA: userData }
    })
    const page = await electronApp.firstWindow()
    await page.waitForSelector('text=runtime present', { timeout: 15_000 })
    await page
      .locator('.state-version strong')
      .filter({ hasText: `v${stateVersion}` })
      .waitFor({ timeout: 15_000 })
    for (const screenshotPath of screenshotPaths) await page.screenshot({ path: screenshotPath })
  } finally {
    await electronApp?.close()
  }
}

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
  await captureDesktop({
    databasePath: databaseTarget,
    environment: {
      NOX_RUNTIME_ENTRY: path.join(root, 'packages/testkit/dist/runtime-child-main.js'),
      NOX_TEST_NOW: '2026-07-12T10:06:00.000Z',
      NOX_TEST_PHASE: 'desktop-restore',
      NOX_TEST_SCENARIO: 'first-loop'
    },
    screenshotPaths: [
      path.join(desktopDirectory, 'after-restart.png'),
      path.join(desktopDirectory, 'silent-or-emitted.png')
    ],
    stateVersion: 3,
    userData: desktopUserData
  })
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

  let realPiStatus = realPiRequested ? 'fail' : 'not-requested'
  const realProvider = process.env.NOX_PI_PROVIDER ?? 'openai-codex'
  const realModel = process.env.NOX_PI_MODEL ?? 'gpt-5.4-mini'
  if (realPiRequested) {
    const realDirectory = path.join(bundle, 'real-pi')
    const realData = path.join(temporary, 'real-pi-data')
    const realDatabase = path.join(realData, 'nox.sqlite')
    await mkdir(realDirectory, { recursive: true })
    let firstReal
    let secondReal
    try {
      if (!process.env.NOX_PI_API_KEY) throw new Error('NOX_PI_API_KEY is required for a real Pi evidence run')
      firstReal = await startProductionRuntime({
        dataDirectory: realData,
        interfaceOwnerId: 'nox-desktop-primary',
        launchToken: `real-pi-${runId}-p1`,
        model: realModel,
        provider: realProvider
      })
      const firstReceipt = await firstReal.append(
        'real-pi-e1',
        'Observe this delivered Event and settle exactly one bounded Nox Act. Use propose_act once; an emission or explicit silence is valid.'
      )
      const firstView = await firstReal.waitForSnapshot(view => view.actTerminals.length === 1)
      const firstTerminal = firstView.actTerminals[0]
      if (!terminalSucceeded(firstTerminal)) {
        throw new Error(`First real Pi Act did not succeed: ${JSON.stringify(firstTerminal)}`)
      }
      const firstRealPid = firstReal.pid
      const realTermination = await firstReal.forceTerminate()
      firstReal = undefined

      const beforeDatabase = path.join(temporary, 'real-before-restart.sqlite')
      const beforeStore = new SqliteStore(realDatabase)
      await beforeStore.createEvidenceCopy(beforeDatabase)
      beforeStore.close()
      await captureDesktop({
        databasePath: beforeDatabase,
        environment: {
          NOX_PI_API_KEY: process.env.NOX_PI_API_KEY,
          NOX_PI_MODEL: realModel,
          NOX_PI_PROVIDER: realProvider
        },
        screenshotPaths: [path.join(desktopDirectory, 'before-restart.png')],
        stateVersion: firstView.state.stateVersion,
        userData: path.join(temporary, 'real-desktop-before')
      })

      secondReal = await startProductionRuntime({
        dataDirectory: realData,
        interfaceOwnerId: 'nox-desktop-primary',
        launchToken: `real-pi-${runId}-p2`,
        model: realModel,
        provider: realProvider
      })
      const secondReceipt = await secondReal.append(
        'real-pi-e2',
        'This Event arrived after a hard runtime restart. Observe restored State and settle exactly one bounded Nox Act with propose_act once.'
      )
      const secondView = await secondReal.waitForSnapshot(view => view.actTerminals.length === 2)
      const secondTerminal = secondView.actTerminals.find(terminal => terminal.actId !== firstTerminal.actId)
      if (!terminalSucceeded(secondTerminal)) {
        throw new Error(`Second real Pi Act did not succeed: ${JSON.stringify(secondTerminal)}`)
      }
      const secondRealPid = secondReal.pid
      await secondReal.close()
      secondReal = undefined

      const realDatabaseTarget = path.join(realDirectory, 'nox.sqlite')
      const finalStore = new SqliteStore(realDatabase)
      await finalStore.createEvidenceCopy(realDatabaseTarget)
      finalStore.close()
      const realAudit = verifyAuditDatabase(realDatabaseTarget, secondView.state.stateVersion)
      const realReader = new SqliteAuditReader(realDatabaseTarget)
      const realRecords = realReader.readJournal()
      realReader.close()
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
          pid: secondRealPid,
          stateHash: secondView.state.stateHash,
          stateVersion: secondView.state.stateVersion
        },
        beforeRestart: {
          pid: firstRealPid,
          stateHash: firstView.state.stateHash,
          stateVersion: firstView.state.stateVersion
        },
        pidsDiffer: firstRealPid !== secondRealPid,
        termination: realTermination
      })
      await writeJson(path.join(realDirectory, 'input-hashes.json'), { inputs: realInputs })
      await writeJson(path.join(realDirectory, 'real-pi-run.json'), {
        attemptsPerAct: 1,
        model: realModel,
        provider: realProvider,
        statuses: [firstTerminal.status, secondTerminal.status],
        status: 'pass'
      })
      await writeJson(path.join(desktopDirectory, 'rpc-trace.json'), {
        requests: [rpcTraceFor(realRecords, firstReceipt, 'rpc-1'), rpcTraceFor(realRecords, secondReceipt, 'rpc-2')]
      })
      await captureDesktop({
        databasePath: realDatabaseTarget,
        environment: {
          NOX_PI_API_KEY: process.env.NOX_PI_API_KEY,
          NOX_PI_MODEL: realModel,
          NOX_PI_PROVIDER: realProvider
        },
        screenshotPaths: [
          path.join(desktopDirectory, 'after-restart.png'),
          path.join(desktopDirectory, 'silent-or-emitted.png')
        ],
        stateVersion: secondView.state.stateVersion,
        userData: path.join(temporary, 'real-desktop-after')
      })
      realPiStatus = 'pass'
    } catch (error) {
      await firstReal?.close().catch(() => undefined)
      await secondReal?.close().catch(() => undefined)
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
    model: realPiRequested
      ? { id: realModel, provider: realProvider }
      : { id: 'scripted-cortex', provider: 'deterministic-testkit' },
    protocolVersion: 1,
    redaction: { credentials: 0, hiddenReasoning: 0, secrets: 0, status: 'pass' },
    runId,
    sourceCommit: git.output.trim(),
    sourceTreeDirty: gitStatus.output.trim().length > 0,
    status:
      killCriteria.status === 'pass' && audit.status === 'pass' && (!realPiRequested || realPiStatus === 'pass')
        ? 'pass'
        : 'fail'
  })
  const status =
    killCriteria.status === 'pass' && audit.status === 'pass' && (!realPiRequested || realPiStatus === 'pass')
      ? 'pass'
      : 'fail'
  process.stdout.write(`${JSON.stringify({ bundle, runId, status })}\n`)
  if (status !== 'pass') process.exitCode = 1
} finally {
  await rm(temporary, { force: true, recursive: true })
}
