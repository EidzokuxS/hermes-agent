import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

async function verifyDatabaseCopy(source, desktopVersion, verifyAuditDatabase) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'nox-offline-verify-'))
  const target = path.join(temporary, 'nox.sqlite')
  try {
    await copyFile(source, target)
    return verifyAuditDatabase(target, desktopVersion)
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
}

async function inspectDatabaseCopy(source, inspect) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'nox-offline-inspect-'))
  const target = path.join(temporary, 'nox.sqlite')
  try {
    await copyFile(source, target)
    return await inspect(target)
  } finally {
    await rm(temporary, { force: true, recursive: true })
  }
}

const bundleArgument = argument('bundle')
if (!bundleArgument) throw new Error('Usage: verify-evidence --bundle <run-directory>')
const deterministicOnly = process.argv.includes('--deterministic-only')
const bundle = path.resolve(root, bundleArgument)
const manifest = await json(path.join(bundle, 'manifest.json'))
requireCondition(manifest.status === 'pass', 'Evidence manifest is not passing')
requireCondition(manifest.redaction?.status === 'pass', 'Evidence redaction report is not passing')

const expected = new Map()
for (const artifact of manifest.artifacts ?? []) {
  requireCondition(typeof artifact.path === 'string' && !expected.has(artifact.path), 'Manifest has duplicate paths')
  const target = path.resolve(bundle, artifact.path)
  requireCondition(
    target.startsWith(`${bundle}${path.sep}`),
    `Manifest artifact escapes the evidence bundle: ${artifact.path}`
  )
  expected.set(artifact.path, artifact)
  const bytes = await readFile(target)
  requireCondition(bytes.byteLength === artifact.bytes, `Artifact byte length mismatch: ${artifact.path}`)
  requireCondition(digest(bytes) === artifact.sha256, `Artifact checksum mismatch: ${artifact.path}`)
}
const actual = (await filesBelow(bundle))
  .map(file => path.relative(bundle, file).replaceAll('\\', '/'))
  .filter(file => file !== 'manifest.json')
requireCondition(actual.length === expected.size, 'Bundle file set does not match the manifest')
for (const file of actual) requireCondition(expected.has(file), `Unmanifested artifact: ${file}`)
const databaseRedactionReports = [
  await inspectDatabaseCopy(path.join(bundle, 'deterministic/nox.sqlite'), scanEvidenceDatabase)
]
if (expected.has('real-pi/nox.sqlite')) {
  databaseRedactionReports.push(
    await inspectDatabaseCopy(path.join(bundle, 'real-pi/nox.sqlite'), scanEvidenceDatabase)
  )
}
const redaction = mergeEvidenceScanReports(
  await scanEvidenceFiles(actual.map(file => path.join(bundle, file))),
  ...databaseRedactionReports
)
requireCondition(redaction.status === 'pass', 'Independent evidence secret scan failed')
requireCondition(
  JSON.stringify({
    credentials: redaction.credentials,
    hiddenReasoning: redaction.hiddenReasoning,
    secrets: redaction.secrets,
    status: redaction.status
  }) ===
    JSON.stringify({
      credentials: manifest.redaction.credentials,
      hiddenReasoning: manifest.redaction.hiddenReasoning,
      secrets: manifest.redaction.secrets,
      status: manifest.redaction.status
    }),
  'Evidence redaction declaration does not match the independent scan'
)

const required = [
  'commands.log',
  'desktop/after-restart.png',
  'desktop/before-restart.png',
  'desktop/capture-report.json',
  'desktop/rpc-trace.json',
  'desktop/silent-or-emitted.png',
  'deterministic/causal-trace.json',
  'deterministic/input-hashes.json',
  'deterministic/nox.sqlite',
  'deterministic/process-restart.json',
  'deterministic/receipt-recovery.json',
  'deterministic/replay-report.json',
  'deterministic/state-replay.json',
  'reviews/kill-criteria.json',
  'reviews/production-graph.json',
  'versions.json'
]
for (const file of required) requireCondition(expected.has(file), `Required artifact is missing: ${file}`)

const { canonicalHash, canonicalStringify, cortexInputSchema, journalRecordSchema } = await import('@nox/protocol')
const { SqliteAuditReader } = await import('@nox/store-sqlite')
const trace = await json(path.join(bundle, 'deterministic/causal-trace.json'))
const records = (trace.records ?? []).map(record => journalRecordSchema.parse(record))
requireCondition(canonicalHash(records) === trace.canonicalTraceHash, 'Canonical causal trace hash mismatch')
for (const [index, record] of records.entries()) {
  requireCondition(record.sequence === index + 1, `Causal trace sequence gap at ${index + 1}`)
}

const stateReplay = await json(path.join(bundle, 'deterministic/state-replay.json'))
requireCondition(stateReplay.status === 'pass', 'Independent State replay artifact failed')
const { verifyAuditDatabase } = await import(pathToFileURL(path.join(root, 'apps/audit/dist/verify.js')).href)
const databaseReport = await verifyDatabaseCopy(
  path.join(bundle, 'deterministic/nox.sqlite'),
  stateReplay.finalStateVersion,
  verifyAuditDatabase
)
requireCondition(
  databaseReport.replay.finalStateHash === stateReplay.finalStateHash,
  'Offline database replay hash mismatch'
)
const databaseEvidence = await inspectDatabaseCopy(path.join(bundle, 'deterministic/nox.sqlite'), databasePath => {
  const reader = new SqliteAuditReader(databasePath)
  try {
    const databaseRecords = reader.readAllJournal()
    const receipts = reader.readExternalReceipts()
    const inputBlobs = databaseRecords.flatMap(record => {
      if (record.entry.kind !== 'act.started') return []
      const inputHash = record.entry.act.input.blobHash
      const blob = reader.getAuditBlob(inputHash)
      requireCondition(blob !== undefined, `CortexInput blob is missing: ${inputHash}`)
      const input = cortexInputSchema.parse(JSON.parse(Buffer.from(blob.bytes).toString('utf8')))
      requireCondition(canonicalHash(input) === inputHash, `CortexInput blob hash mismatch: ${inputHash}`)
      requireCondition(input.actId === record.entry.act.actId, `CortexInput Act ID mismatch: ${inputHash}`)
      return [{ actId: record.entry.act.actId, inputHash }]
    })
    return { inputBlobs, receipts, records: databaseRecords }
  } finally {
    reader.close()
  }
})
requireCondition(
  canonicalStringify(databaseEvidence.records) === canonicalStringify(records),
  'Exported causal trace does not match the SQLite Journal record-for-record'
)

const restart = await json(path.join(bundle, 'deterministic/process-restart.json'))
requireCondition(restart.pidsDiffer === true, 'Runtime restart reused the same PID')
requireCondition(restart.beforeRestart?.pid !== restart.afterRestart?.pid, 'Restart PID evidence is inconsistent')
requireCondition(
  restart.termination?.code !== null || restart.termination?.signal !== null,
  'Forced termination has no exit result'
)
requireCondition(restart.afterRestart?.stateVersion === stateReplay.finalStateVersion, 'Restart State version mismatch')

const capture = await json(path.join(bundle, 'desktop/capture-report.json'))
for (const phase of ['beforeRestart', 'afterRestart']) {
  const screenshot = expected.get(capture[phase]?.screenshot)
  requireCondition(screenshot !== undefined, `${phase} screenshot is absent from the manifest`)
  requireCondition(screenshot.sha256 === capture[phase].screenshotSha256, `${phase} screenshot hash is not bound`)
  requireCondition(
    capture[phase].journalCursor === restart[phase].journalCursor &&
      capture[phase].stateHash === restart[phase].stateHash &&
      capture[phase].stateVersion === restart[phase].stateVersion,
    `${phase} Desktop capture does not match restart evidence`
  )
}
requireCondition(capture.beforeRestart.requests?.length === 1, 'Before-restart Desktop capture has wrong requests')
requireCondition(capture.beforeRestart.emissions?.length === 1, 'Before-restart Desktop capture has wrong emissions')
requireCondition(capture.beforeRestart.continuations?.length === 1, 'Before-restart Continuation is not visible')
requireCondition(capture.afterRestart.requests?.length === 2, 'After-restart Desktop capture has wrong causal events')
requireCondition(capture.afterRestart.emissions?.length === 2, 'After-restart Desktop capture has wrong emissions')
requireCondition(capture.afterRestart.continuations?.length === 0, 'Fired Continuation remained visible after restart')
const outcomeScreenshot = expected.get(capture.outcome?.screenshot)
requireCondition(outcomeScreenshot !== undefined, 'Outcome screenshot is absent from the manifest')
requireCondition(outcomeScreenshot.sha256 === capture.outcome.screenshotSha256, 'Outcome screenshot hash is not bound')

const inputs = await json(path.join(bundle, 'deterministic/input-hashes.json'))
requireCondition(Array.isArray(inputs.inputs) && inputs.inputs.length === 2, 'Expected exactly two CortexInput hashes')
requireCondition(
  inputs.inputs.every(input => /^sha256:[0-9a-f]{64}$/.test(input.inputHash)),
  'Invalid CortexInput hash'
)
requireCondition(
  canonicalStringify(inputs.inputs) === canonicalStringify(databaseEvidence.inputBlobs),
  'CortexInput hash report does not match ActStarted records and stored blobs'
)

const recovery = await json(path.join(bundle, 'deterministic/receipt-recovery.json'))
requireCondition(
  Array.isArray(recovery.matrix) && recovery.matrix.length === 6,
  'Receipt recovery matrix is incomplete'
)
requireCondition(recovery.invariants?.admissionBeforeSenderFlush === 0, 'Admission occurred before sender flush')
requireCondition(recovery.invariants?.duplicateEventsAfterRecovery === 0, 'Duplicate Event after recovery')
requireCondition(recovery.invariants?.duplicateAdmissionsAfterRecovery === 0, 'Duplicate admission after recovery')
requireCondition(recovery.invariants?.duplicateActsAfterRecovery === 0, 'Duplicate Act after recovery')
for (const row of recovery.matrix) {
  requireCondition(
    row.afterRecovery?.events === 1 &&
      row.afterRecovery?.admissions === 1 &&
      row.afterRecovery?.acts === 1 &&
      row.afterRecovery?.terminals === 1,
    `Receipt recovery failed at ${row.boundary}`
  )
}

const rpc = await json(path.join(bundle, 'desktop/rpc-trace.json'))
const rpcRequests = Array.isArray(rpc.requests) ? rpc.requests : [rpc]
requireCondition(rpcRequests.length >= 1, 'RPC trace contains no requests')
for (const request of rpcRequests) {
  requireCondition(
    request.journal?.eventRecordedSequence < request.journal?.eventAdmittedSequence &&
      request.journal?.eventAdmittedSequence < request.journal?.actStartedSequence,
    `${request.requestId ?? 'RPC'} order is not EventRecorded < EventAdmitted < ActStarted`
  )
  requireCondition(
    JSON.stringify(request.observationOrder) ===
      JSON.stringify(['receipt-frame-flushed', 'event.admitted', 'act.started']),
    `${request.requestId ?? 'RPC'} client observation order is invalid`
  )
  const durableReceipt = databaseEvidence.receipts.find(receipt => receipt.eventId === request.eventId)
  requireCondition(durableReceipt !== undefined, `${request.requestId ?? 'RPC'} receipt is absent from SQLite`)
  requireCondition(
    canonicalStringify(durableReceipt) === canonicalStringify(request.receipt),
    `${request.requestId ?? 'RPC'} receipt does not match SQLite`
  )
}

if (!deterministicOnly) {
  requireCondition(manifest.evidenceLane === 'full', 'Full verification requires a full real-Pi evidence lane')
  requireCondition(manifest.sourceTreeDirty === false, 'Full verification requires evidence from a clean source tree')
  requireCondition(expected.has('real-pi/real-pi-run.json'), 'Full verification requires real-Pi evidence')
}

if (expected.has('real-pi/real-pi-run.json')) {
  const realRequired = [
    'real-pi/causal-trace.json',
    'real-pi/desktop/after-restart.png',
    'real-pi/desktop/before-restart.png',
    'real-pi/desktop/capture-report.json',
    'real-pi/desktop/silent-or-emitted.png',
    'real-pi/input-hashes.json',
    'real-pi/nox.sqlite',
    'real-pi/process-restart.json',
    'real-pi/real-pi-run.json',
    'real-pi/rpc-trace.json',
    'real-pi/state-replay.json'
  ]
  for (const file of realRequired) requireCondition(expected.has(file), `Real Pi artifact is missing: ${file}`)
  const realRun = await json(path.join(bundle, 'real-pi/real-pi-run.json'))
  requireCondition(realRun.status === 'pass', 'Real Pi run did not pass')
  requireCondition(realRun.attemptsPerAct === 1, 'Real Pi run used more than one provider attempt per Act')
  requireCondition(Array.isArray(realRun.statuses) && realRun.statuses.length === 2, 'Real Pi terminals are incomplete')
  requireCondition(
    realRun.model === manifest.model?.id && realRun.provider === manifest.model?.provider,
    'Real Pi report model identity does not match the manifest'
  )
  const realTrace = await json(path.join(bundle, 'real-pi/causal-trace.json'))
  const realRecords = (realTrace.records ?? []).map(record => journalRecordSchema.parse(record))
  requireCondition(canonicalHash(realRecords) === realTrace.canonicalTraceHash, 'Real Pi causal trace hash mismatch')
  const realReplay = await json(path.join(bundle, 'real-pi/state-replay.json'))
  const realDatabase = await verifyDatabaseCopy(
    path.join(bundle, 'real-pi/nox.sqlite'),
    realReplay.finalStateVersion,
    verifyAuditDatabase
  )
  requireCondition(realDatabase.replay.finalStateHash === realReplay.finalStateHash, 'Real Pi database replay mismatch')
  const realDatabaseEvidence = await inspectDatabaseCopy(path.join(bundle, 'real-pi/nox.sqlite'), databasePath => {
    const reader = new SqliteAuditReader(databasePath)
    try {
      const databaseRecords = reader.readAllJournal()
      const receipts = reader.readExternalReceipts()
      const inputBlobs = databaseRecords.flatMap(record => {
        if (record.entry.kind !== 'act.started') return []
        const inputHash = record.entry.act.input.blobHash
        const blob = reader.getAuditBlob(inputHash)
        requireCondition(blob !== undefined, `Real Pi CortexInput blob is missing: ${inputHash}`)
        const input = cortexInputSchema.parse(JSON.parse(Buffer.from(blob.bytes).toString('utf8')))
        requireCondition(canonicalHash(input) === inputHash, `Real Pi CortexInput blob hash mismatch: ${inputHash}`)
        return [{ actId: record.entry.act.actId, inputHash }]
      })
      return { inputBlobs, receipts, records: databaseRecords }
    } finally {
      reader.close()
    }
  })
  requireCondition(
    canonicalStringify(realDatabaseEvidence.records) === canonicalStringify(realRecords),
    'Real Pi causal trace does not match SQLite record-for-record'
  )
  const realStarts = realRecords.flatMap(record => (record.entry.kind === 'act.started' ? [record.entry.act] : []))
  const realProposals = realRecords.flatMap(record =>
    record.entry.kind === 'act.proposal-observed' ? [record.entry] : []
  )
  const realTerminals = realRecords.flatMap(record =>
    record.entry.kind === 'act.terminal' ? [record.entry.terminal] : []
  )
  requireCondition(realStarts.length === 2, 'Real Pi Journal must contain exactly two started Acts')
  requireCondition(realProposals.length === 2, 'Real Pi Journal must contain exactly two observed proposals')
  requireCondition(realTerminals.length === 2, 'Real Pi Journal must contain exactly two terminal Acts')
  for (const started of realStarts) {
    requireCondition(started.modelId === manifest.model.id, `Real Pi Act ${started.actId} used the wrong model`)
    const proposals = realProposals.filter(proposal => proposal.actId === started.actId)
    const terminals = realTerminals.filter(terminal => terminal.actId === started.actId)
    requireCondition(proposals.length === 1, `Real Pi Act ${started.actId} does not have exactly one proposal`)
    requireCondition(
      proposals[0].result.kind === 'proposed',
      `Real Pi Act ${started.actId} did not produce a schema-valid proposal`
    )
    requireCondition(terminals.length === 1, `Real Pi Act ${started.actId} does not have exactly one terminal`)
    requireCondition(
      terminals[0].status === 'completed-effects' || terminals[0].status === 'completed-silent',
      `Real Pi Act ${started.actId} did not terminate successfully`
    )
  }
  requireCondition(
    canonicalStringify(realRun.statuses) === canonicalStringify(realTerminals.map(terminal => terminal.status)),
    'Real Pi report statuses do not match Journal terminals'
  )
  const realRestart = await json(path.join(bundle, 'real-pi/process-restart.json'))
  requireCondition(realRestart.pidsDiffer === true, 'Real Pi runtime restart reused its PID')
  const realInputs = await json(path.join(bundle, 'real-pi/input-hashes.json'))
  requireCondition(realInputs.inputs?.length === 2, 'Real Pi run must retain exactly two CortexInput hashes')
  requireCondition(
    canonicalStringify(realInputs.inputs) === canonicalStringify(realDatabaseEvidence.inputBlobs),
    'Real Pi input report does not match ActStarted records and blobs'
  )
  const realRpc = await json(path.join(bundle, 'real-pi/rpc-trace.json'))
  requireCondition(realRpc.requests?.length === 2, 'Real Pi RPC trace must contain E1 and E2')
  for (const request of realRpc.requests) {
    requireCondition(
      JSON.stringify(request.observationOrder) ===
        JSON.stringify(['receipt-frame-flushed', 'event.admitted', 'act.started']),
      `${request.requestId} real Pi client observation order is invalid`
    )
    const receipt = realDatabaseEvidence.receipts.find(item => item.eventId === request.eventId)
    requireCondition(receipt !== undefined, `${request.requestId} real Pi receipt is absent from SQLite`)
    requireCondition(
      canonicalStringify(receipt) === canonicalStringify(request.receipt),
      `${request.requestId} real Pi receipt does not match SQLite`
    )
  }
  const realCapture = await json(path.join(bundle, 'real-pi/desktop/capture-report.json'))
  for (const phase of ['beforeRestart', 'afterRestart']) {
    const screenshot = expected.get(realCapture[phase]?.screenshot)
    requireCondition(screenshot !== undefined, `Real Pi ${phase} screenshot is absent from the manifest`)
    requireCondition(
      screenshot.sha256 === realCapture[phase].screenshotSha256,
      `Real Pi ${phase} screenshot hash is not bound`
    )
    requireCondition(
      realCapture[phase].journalCursor === realRestart[phase].journalCursor &&
        realCapture[phase].stateHash === realRestart[phase].stateHash &&
        realCapture[phase].stateVersion === realRestart[phase].stateVersion,
      `Real Pi ${phase} Desktop capture does not match restart evidence`
    )
  }
  requireCondition(realCapture.beforeRestart.requests?.length === 1, 'Real Pi first Desktop Act is not visible')
  requireCondition(realCapture.afterRestart.requests?.length === 2, 'Real Pi second Desktop Act is not visible')
  const realOutcome = expected.get(realCapture.outcome?.screenshot)
  requireCondition(realOutcome !== undefined, 'Real Pi outcome screenshot is absent from the manifest')
  requireCondition(
    realOutcome.sha256 === realCapture.outcome.screenshotSha256,
    'Real Pi outcome screenshot hash is not bound'
  )
}

const killCriteria = await json(path.join(bundle, 'reviews/kill-criteria.json'))
requireCondition(killCriteria.status === 'pass', 'Kill criteria report failed')
requireCondition(
  killCriteria.rules?.every(rule => rule.pass),
  'A kill-criteria rule failed'
)
const versions = await json(path.join(bundle, 'versions.json'))
requireCondition(versions.dependencyLockSha256 === manifest.dependencyLockSha256, 'Lockfile hash mismatch')
requireCondition(versions.sourceCommit === manifest.sourceCommit, 'Source commit mismatch')
if (!deterministicOnly) {
  requireCondition(versions.sourceTreeDirty === false, 'Full verification versions report a dirty source tree')
}
const pinnedNode = (await readFile(path.join(root, '.node-version'), 'utf8')).trim()
requireCondition(versions.node === `v${pinnedNode}`, `Evidence used ${versions.node}; pinned Node is v${pinnedNode}`)

process.stdout.write(
  `${JSON.stringify({ artifacts: expected.size, bundle, evidenceLane: deterministicOnly ? 'deterministic' : 'full', finalStateHash: stateReplay.finalStateHash, status: 'pass' })}\n`
)
