import { describe, expect, it } from 'vitest'

import { rejectUnsafePathSyntax, resolveRequestedPathForIpc, sensitiveFileBlockReason } from './hardening.js'

describe('Desktop path hardening', () => {
  it('rejects device paths and known secret-bearing files', () => {
    expect(() => rejectUnsafePathSyntax('\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1', 'Read')).toThrow('device paths')
    expect(sensitiveFileBlockReason('C:\\Users\\nox\\.ssh\\id_ed25519')).toContain('SSH')
    expect(sensitiveFileBlockReason('project/.env.example')).toBeNull()
  })

  it('resolves relative input beneath an explicit base', () => {
    expect(resolveRequestedPathForIpc('journal/evidence.json', { baseDir: 'C:\\nox' })).toBe(
      'C:\\nox\\journal\\evidence.json'
    )
  })
})
