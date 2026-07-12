/// <reference types="node" />

import { DatabaseSync } from 'node:sqlite'

import { eventReceiptSchema, stateSnapshotSchema } from '@nox/protocol'
import type { EventReceipt, JournalRecord, StateSnapshot } from '@nox/protocol'
import { SqliteAuditReader } from '@nox/store-sqlite'

interface SnapshotRow {
  state_hash: string
  state_json: string
  state_version: number
  through_sequence: number
}

interface ReceiptRow {
  receipt_json: string
}

export interface RawAuditExport {
  integrity: string
  journal: JournalRecord[]
  receipts: EventReceipt[]
  snapshots: StateSnapshot[]
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

export function readRawDatabase(databasePath: string): RawAuditExport {
  const validated = new SqliteAuditReader(databasePath)
  const integrity = validated.integrityCheck()
  const journal = validated.readAllJournal()
  validated.close()

  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: 5_000
  })
  database.enableDefensive(true)
  database.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;')
  try {
    const snapshots = (
      database
        .prepare(
          `SELECT state_version, through_sequence, state_hash, state_json
           FROM state_snapshots ORDER BY state_version`
        )
        .all() as unknown as SnapshotRow[]
    ).map(row =>
      stateSnapshotSchema.parse({
        state: parseJson(row.state_json),
        stateHash: row.state_hash,
        stateVersion: row.state_version,
        throughSequence: row.through_sequence
      })
    )
    const receipts = (
      database
        .prepare('SELECT receipt_json FROM external_event_receipts ORDER BY journal_sequence')
        .all() as unknown as ReceiptRow[]
    ).map(row => eventReceiptSchema.parse(parseJson(row.receipt_json)))
    return { integrity, journal, receipts, snapshots }
  } finally {
    database.close()
  }
}
