import { SqliteAuditReader } from '@nox/store-sqlite'

import { readRawDatabase } from './raw-reader.js'
import type { RawAuditExport } from './raw-reader.js'
import { replayState } from './state-replay.js'
import type { StateReplayReport } from './state-replay.js'

export interface AuditVerificationReport {
  integrity: string
  raw: RawAuditExport
  replay: StateReplayReport
  stateHistory: ReturnType<SqliteAuditReader['verifyStateHistory']>
  status: 'pass'
}

export function verifyAuditDatabase(databasePath: string, desktopRestoredVersion?: number): AuditVerificationReport {
  const raw = readRawDatabase(databasePath)
  const replay = replayState(raw, desktopRestoredVersion)
  const reader = new SqliteAuditReader(databasePath)
  try {
    return {
      integrity: reader.integrityCheck(),
      raw,
      replay,
      stateHistory: reader.verifyStateHistory(),
      status: 'pass'
    }
  } finally {
    reader.close()
  }
}
