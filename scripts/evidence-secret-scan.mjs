import { readFile } from 'node:fs/promises'
import path from 'node:path'

const textExtensions = new Set(['.json', '.log', '.md', '.txt', '.yaml', '.yml'])
const credentialPatterns = [
  /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{12,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*(?!\[REDACTED\])["']?[A-Za-z0-9._~+/=-]{12,}/gi
]
const hiddenReasoningPatterns = [
  /<(?:analysis|thinking)>/gi,
  /"(?:chain_of_thought|reasoning_content|thinking_content)"\s*:/gi
]

export function environmentSensitiveValues(environment = process.env) {
  return Object.entries(environment)
    .filter(([name, value]) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET)$/i.test(name) && value?.length >= 4)
    .map(([, value]) => value)
}

function matchesAny(patterns, text) {
  return patterns.some(pattern => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

function report(findings) {
  const credentials = findings.filter(({ kind }) => kind === 'credential-pattern').length
  const hiddenReasoning = findings.filter(({ kind }) => kind === 'hidden-reasoning').length
  const secrets = findings.filter(({ kind }) => kind === 'configured-secret').length
  return {
    credentials,
    findings: findings.map(finding => ({ ...finding, path: finding.path.replaceAll('\\', '/') })),
    hiddenReasoning,
    secrets,
    status: findings.length === 0 ? 'pass' : 'fail'
  }
}

function scanPayload(bytes, payloadPath, inspectText, sensitiveValues) {
  const findings = []
  for (const sensitive of sensitiveValues) {
    if (sensitive && bytes.includes(Buffer.from(sensitive, 'utf8'))) {
      findings.push({ kind: 'configured-secret', path: payloadPath })
      break
    }
  }
  if (!inspectText) return findings
  const text = bytes.toString('utf8')
  if (matchesAny(credentialPatterns, text)) findings.push({ kind: 'credential-pattern', path: payloadPath })
  if (matchesAny(hiddenReasoningPatterns, text)) findings.push({ kind: 'hidden-reasoning', path: payloadPath })
  return findings
}

export function mergeEvidenceScanReports(...reports) {
  return report(reports.flatMap(item => item.findings ?? []))
}

export function scanEvidencePayloads(payloads, sensitiveValues = environmentSensitiveValues()) {
  return report(
    payloads.flatMap(payload =>
      scanPayload(Buffer.from(payload.bytes), payload.path, payload.inspectText !== false, sensitiveValues)
    )
  )
}

export async function scanEvidenceFiles(files, sensitiveValues = environmentSensitiveValues()) {
  const findings = []
  for (const file of files) {
    const bytes = await readFile(file)
    findings.push(...scanPayload(bytes, file, textExtensions.has(path.extname(file).toLowerCase()), sensitiveValues))
  }
  return report(findings)
}

export async function scanEvidenceDatabase(databasePath, sensitiveValues = environmentSensitiveValues()) {
  const { SqliteAuditReader } = await import('@nox/store-sqlite')
  const reader = new SqliteAuditReader(databasePath)
  try {
    return scanEvidencePayloads(
      reader.readAuditBlobs().map(blob => ({
        bytes: blob.bytes,
        inspectText:
          blob.mediaType.startsWith('text/') || /(?:json|xml|yaml|javascript|typescript)/i.test(blob.mediaType),
        path: `audit-blob-${blob.contentHash}`
      })),
      sensitiveValues
    )
  } finally {
    reader.close()
  }
}
