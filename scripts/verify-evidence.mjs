import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const bundleArgument = argument('bundle')
if (!bundleArgument) throw new Error('Usage: verify-evidence --bundle <run-directory>')
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

const required = [
  'commands.log',
  'desktop/after-restart.png',
  'desktop/before-restart.png',
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

const { canonicalHash, journalRecordSchema } = await import('@nox/protocol')
const trace = await json(path.join(bundle, 'deterministic/causal-trace.json'))
const records = (trace.records ?? []).map(record => journalRecordSchema.parse(record))
requireCondition(canonicalHash(records) === trace.canonicalTraceHash, 'Canonical causal trace hash mismatch')
for (const [index, record] of records.entries()) {
  requireCondition(record.sequence === index + 1, `Causal trace sequence gap at ${index + 1}`)
}

const stateReplay = await json(path.join(bundle, 'deterministic/state-replay.json'))
requireCondition(stateReplay.status === 'pass', 'Independent State replay artifact failed')
const { verifyAuditDatabase } = await import(pathToFileURL(path.join(root, 'apps/audit/dist/verify.js')).href)
const databaseReport = verifyAuditDatabase(path.join(bundle, 'deterministic/nox.sqlite'), stateReplay.finalStateVersion)
requireCondition(
  databaseReport.replay.finalStateHash === stateReplay.finalStateHash,
  'Offline database replay hash mismatch'
)

const restart = await json(path.join(bundle, 'deterministic/process-restart.json'))
requireCondition(restart.pidsDiffer === true, 'Runtime restart reused the same PID')
requireCondition(restart.beforeRestart?.pid !== restart.afterRestart?.pid, 'Restart PID evidence is inconsistent')
requireCondition(
  restart.termination?.code !== null || restart.termination?.signal !== null,
  'Forced termination has no exit result'
)
requireCondition(restart.afterRestart?.stateVersion === stateReplay.finalStateVersion, 'Restart State version mismatch')

const inputs = await json(path.join(bundle, 'deterministic/input-hashes.json'))
requireCondition(Array.isArray(inputs.inputs) && inputs.inputs.length === 2, 'Expected exactly two CortexInput hashes')
requireCondition(
  inputs.inputs.every(input => /^sha256:[0-9a-f]{64}$/.test(input.inputHash)),
  'Invalid CortexInput hash'
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
}

if (expected.has('real-pi/real-pi-run.json')) {
  const realRequired = [
    'real-pi/causal-trace.json',
    'real-pi/input-hashes.json',
    'real-pi/nox.sqlite',
    'real-pi/process-restart.json',
    'real-pi/real-pi-run.json',
    'real-pi/state-replay.json'
  ]
  for (const file of realRequired) requireCondition(expected.has(file), `Real Pi artifact is missing: ${file}`)
  const realRun = await json(path.join(bundle, 'real-pi/real-pi-run.json'))
  requireCondition(realRun.status === 'pass', 'Real Pi run did not pass')
  requireCondition(realRun.attemptsPerAct === 1, 'Real Pi run used more than one provider attempt per Act')
  requireCondition(Array.isArray(realRun.statuses) && realRun.statuses.length === 2, 'Real Pi terminals are incomplete')
  const realTrace = await json(path.join(bundle, 'real-pi/causal-trace.json'))
  const realRecords = (realTrace.records ?? []).map(record => journalRecordSchema.parse(record))
  requireCondition(canonicalHash(realRecords) === realTrace.canonicalTraceHash, 'Real Pi causal trace hash mismatch')
  const realReplay = await json(path.join(bundle, 'real-pi/state-replay.json'))
  const realDatabase = verifyAuditDatabase(path.join(bundle, 'real-pi/nox.sqlite'), realReplay.finalStateVersion)
  requireCondition(realDatabase.replay.finalStateHash === realReplay.finalStateHash, 'Real Pi database replay mismatch')
  const realRestart = await json(path.join(bundle, 'real-pi/process-restart.json'))
  requireCondition(realRestart.pidsDiffer === true, 'Real Pi runtime restart reused its PID')
  const realInputs = await json(path.join(bundle, 'real-pi/input-hashes.json'))
  requireCondition(realInputs.inputs?.length === 2, 'Real Pi run must retain exactly two CortexInput hashes')
  requireCondition(rpcRequests.length === 2, 'Real Pi RPC trace must contain E1 and E2')
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

process.stdout.write(
  `${JSON.stringify({ artifacts: expected.size, bundle, finalStateHash: stateReplay.finalStateHash, status: 'pass' })}\n`
)
