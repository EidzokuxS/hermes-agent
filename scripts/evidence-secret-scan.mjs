import { readFile } from 'node:fs/promises'
import path from 'node:path'

const textExtensions = new Set(['.json', '.log', '.md', '.txt', '.yaml', '.yml'])
const credentialPatterns = [
  /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}\b/g,
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

export async function scanEvidenceFiles(files, sensitiveValues = environmentSensitiveValues()) {
  const findings = []
  for (const file of files) {
    const bytes = await readFile(file)
    for (const sensitive of sensitiveValues) {
      if (sensitive && bytes.includes(Buffer.from(sensitive, 'utf8'))) {
        findings.push({ kind: 'configured-secret', path: file })
        break
      }
    }
    if (!textExtensions.has(path.extname(file).toLowerCase())) continue
    const text = bytes.toString('utf8')
    if (matchesAny(credentialPatterns, text)) {
      findings.push({ kind: 'credential-pattern', path: file })
    }
    if (matchesAny(hiddenReasoningPatterns, text)) {
      findings.push({ kind: 'hidden-reasoning', path: file })
    }
  }
  const credentials = findings.filter(({ kind }) => kind === 'credential-pattern').length
  const hiddenReasoning = findings.filter(({ kind }) => kind === 'hidden-reasoning').length
  const secrets = findings.filter(({ kind }) => kind === 'configured-secret').length
  return {
    credentials,
    findings: findings.map(finding => ({ ...finding, path: path.basename(finding.path) })),
    hiddenReasoning,
    secrets,
    status: findings.length === 0 ? 'pass' : 'fail'
  }
}
