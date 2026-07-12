import { describe, expect, it } from 'vitest'

import { scanEvidencePayloads } from '../../scripts/evidence-secret-scan.mjs'

describe('evidence audit-blob redaction scan', () => {
  it('detects unknown bearer credentials and hidden reasoning in decoded payloads', () => {
    const report = scanEvidencePayloads([
      {
        bytes: Buffer.from('{"error":"Bearer unknown-token-123456789","reasoning_content":"private"}'),
        path: 'audit-blob-synthetic'
      }
    ])
    expect(report.status).toBe('fail')
    expect(report.credentials).toBe(1)
    expect(report.hiddenReasoning).toBe(1)
  })
})
