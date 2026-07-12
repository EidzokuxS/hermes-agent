/// <reference types="node" />

import { createHash } from 'node:crypto'
import type { PathLike } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { journalRecordSchema, provenanceSchema, stateSnapshotSchema } from '@nox/protocol'
import type { JournalRecord, Provenance, StateSnapshot } from '@nox/protocol'

import { foundationMigration } from './migrations.js'
import type { AuditBlobRow, JournalRow, MigrationRow, SnapshotRow } from './schema.js'
import type { AuditBlob, JournalQuery } from './sqlite-store.js'

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export interface StateHistoryReport {
  journalRecords: number
  snapshots: number
  stateHash: string
  stateVersion: number
  throughSequence: number
}

export class SqliteAuditReader {
  readonly #database: DatabaseSync
  #closed = false

  constructor(databasePath: PathLike) {
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readOnly: true,
      timeout: 5_000
    })
    this.#database.enableDefensive(true)
    this.#database.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;')
    this.#verifySchema()
  }

  readJournal(query: JournalQuery = {}): JournalRecord[] {
    this.#assertOpen()
    const afterSequence = query.afterSequence ?? 0
    const limit = Math.min(Math.max(query.limit ?? 10_000, 1), 100_000)
    const kinds = query.kinds ?? []
    const kindClause = kinds.length === 0 ? '' : `AND entry_kind IN (${kinds.map(() => '?').join(', ')})`
    const rows = this.#database
      .prepare(
        `SELECT sequence, record_id, record_hash, command_id, protocol_version,
                journal_schema_version, recorded_at, entry_json, provenance_json, causal_json
         FROM journal_records
         WHERE sequence > ? ${kindClause}
         ORDER BY sequence
         LIMIT ?`
      )
      .all(afterSequence, ...kinds, limit) as unknown as JournalRow[]
    return rows.map(row => this.#parseJournalRow(row))
  }

  readRejectedEffects(): JournalRecord[] {
    this.#assertOpen()
    const rows = this.#database
      .prepare(
        `SELECT sequence, record_id, record_hash, command_id, protocol_version,
                journal_schema_version, recorded_at, entry_json, provenance_json, causal_json
         FROM journal_records
         WHERE entry_kind = 'effect.decision'
           AND json_extract(entry_json, '$.decision.decision') = 'rejected'
         ORDER BY sequence`
      )
      .all() as unknown as JournalRow[]
    return rows.map(row => this.#parseJournalRow(row))
  }

  loadSnapshot(stateVersion?: number): StateSnapshot {
    this.#assertOpen()
    const row = (stateVersion === undefined
      ? this.#database
          .prepare(
            `SELECT state_version, through_sequence, state_hash, state_json
               FROM state_snapshots ORDER BY state_version DESC LIMIT 1`
          )
          .get()
      : this.#database
          .prepare(
            `SELECT state_version, through_sequence, state_hash, state_json
               FROM state_snapshots WHERE state_version = ?`
          )
          .get(stateVersion)) as unknown as SnapshotRow | undefined
    if (row === undefined) {
      throw new Error(
        stateVersion === undefined ? 'Audit copy contains no State snapshot' : `No State version ${stateVersion}`
      )
    }
    return stateSnapshotSchema.parse({
      state: parseJson(row.state_json),
      stateHash: row.state_hash,
      stateVersion: row.state_version,
      throughSequence: row.through_sequence
    })
  }

  verifyStateHistory(): StateHistoryReport {
    this.#assertOpen()
    const snapshots = this.#database
      .prepare(
        `SELECT state_version, through_sequence, state_hash, state_json
         FROM state_snapshots ORDER BY state_version`
      )
      .all() as unknown as SnapshotRow[]
    if (snapshots.length === 0) {
      throw new Error('State history has no foundation snapshot')
    }
    const records = this.readJournal({ limit: 100_000 })
    for (const [index, record] of records.entries()) {
      if (record.sequence !== index + 1) {
        throw new Error(`Journal sequence gap at ${index + 1}`)
      }
    }

    let previousThroughSequence = 0
    for (const [index, row] of snapshots.entries()) {
      const snapshot = stateSnapshotSchema.parse({
        state: parseJson(row.state_json),
        stateHash: row.state_hash,
        stateVersion: row.state_version,
        throughSequence: row.through_sequence
      })
      if (snapshot.stateVersion !== index) {
        throw new Error(`State snapshot version gap at ${index}`)
      }
      if (index === 0) {
        if (snapshot.throughSequence !== 0) {
          throw new Error('Foundation snapshot must begin at Journal sequence 0')
        }
      } else {
        const advancements = records.filter(({ entry, sequence }) => {
          return (
            sequence > previousThroughSequence &&
            sequence <= snapshot.throughSequence &&
            entry.kind === 'state.advanced'
          )
        })
        if (advancements.length !== 1) {
          throw new Error(`State version ${snapshot.stateVersion} has ${advancements.length} advancements`)
        }
        const advancement = advancements[0]?.entry
        if (
          advancement?.kind !== 'state.advanced' ||
          advancement.stateVersion !== snapshot.stateVersion ||
          advancement.stateHash !== snapshot.stateHash
        ) {
          throw new Error(`State version ${snapshot.stateVersion} does not match its Journal advancement`)
        }
      }
      previousThroughSequence = snapshot.throughSequence
    }

    const latest = stateSnapshotSchema.parse({
      state: parseJson(snapshots.at(-1)?.state_json ?? ''),
      stateHash: snapshots.at(-1)?.state_hash,
      stateVersion: snapshots.at(-1)?.state_version,
      throughSequence: snapshots.at(-1)?.through_sequence
    })
    return {
      journalRecords: records.length,
      snapshots: snapshots.length,
      stateHash: latest.stateHash,
      stateVersion: latest.stateVersion,
      throughSequence: latest.throughSequence
    }
  }

  getAuditBlob(contentHash: string): AuditBlob | undefined {
    this.#assertOpen()
    const row = this.#database
      .prepare(
        `SELECT content_hash, media_type, byte_length, bytes, provenance_json, created_at
         FROM audit_blobs WHERE content_hash = ?`
      )
      .get(contentHash) as unknown as AuditBlobRow | undefined
    if (row === undefined) {
      return undefined
    }
    if (row.byte_length !== row.bytes.byteLength || digestBytes(row.bytes) !== row.content_hash) {
      throw new Error('Audit blob failed independent content-address verification')
    }
    return {
      bytes: row.bytes,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      mediaType: row.media_type,
      provenance: provenanceSchema.parse(parseJson(row.provenance_json)) as Provenance
    }
  }

  integrityCheck(): string {
    this.#assertOpen()
    const row = this.#database.prepare('PRAGMA integrity_check').get() as Record<string, string>
    return Object.values(row)[0] ?? 'missing integrity result'
  }

  close(): void {
    if (this.#closed) {
      return
    }
    this.#database.close()
    this.#closed = true
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('SQLite Audit Reader is closed')
    }
  }

  #parseJournalRow(row: JournalRow): JournalRecord {
    return journalRecordSchema.parse({
      causal: parseJson(row.causal_json),
      entry: parseJson(row.entry_json),
      journalSchemaVersion: row.journal_schema_version,
      protocolVersion: row.protocol_version,
      provenance: parseJson(row.provenance_json),
      recordedAt: row.recorded_at,
      recordHash: row.record_hash,
      recordId: row.record_id,
      sequence: row.sequence
    })
  }

  #verifySchema(): void {
    const rows = this.#database
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
      .all() as unknown as MigrationRow[]
    const [migration] = rows
    if (
      rows.length !== 1 ||
      migration?.version !== foundationMigration.version ||
      migration.name !== foundationMigration.name ||
      migration.checksum !== foundationMigration.checksum
    ) {
      throw new Error('Audit database schema does not match the Nox foundation schema')
    }
  }
}
