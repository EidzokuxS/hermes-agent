/// <reference types="node" />

import { createHash, randomUUID } from 'node:crypto'
import type { PathLike } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

import {
  canonicalHash,
  canonicalStringify,
  commitCommandSchema,
  commitReceiptSchema,
  eventReceiptSchema,
  externalEventSchema,
  journalRecordSchema,
  PROTOCOL_VERSION,
  provenanceSchema,
  stateSnapshotSchema
} from '@nox/protocol'
import type {
  CommitCommand,
  CommitReceipt,
  EventReceipt,
  ExternalEvent,
  JournalRecord,
  Provenance,
  StateSnapshot
} from '@nox/protocol'

import { applyMigrations } from './migrations.js'
import type { AuditBlobRow, CommitReceiptRow, ExternalReceiptRow, JournalRow, SnapshotRow } from './schema.js'

export type FaultStage = 'after-journal' | 'before-commit' | 'before-snapshot'

export interface JournalQuery {
  afterSequence?: number
  kinds?: string[]
  limit?: number
}

export interface SqliteStoreOptions {
  faultInjector?: (stage: FaultStage) => void
  idFactory?: () => string
  now?: () => string
}

export interface AuditBlob {
  bytes: Uint8Array
  contentHash: string
  createdAt: string
  mediaType: string
  provenance: Provenance
}

export interface PutAuditBlobInput {
  bytes: Uint8Array
  createdAt: string
  mediaType: string
  provenance: Provenance
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export class SqliteStore {
  readonly #database: DatabaseSync
  readonly #faultInjector: (stage: FaultStage) => void
  readonly #idFactory: () => string
  readonly #now: () => string
  #closed = false

  constructor(databasePath: PathLike, options: SqliteStoreOptions = {}) {
    if (typeof databasePath === 'string' && databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true })
    }
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000
    })
    this.#database.enableDefensive(true)
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
      PRAGMA recursive_triggers = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA wal_autocheckpoint = 1000;
    `)
    this.#faultInjector = options.faultInjector ?? (() => undefined)
    this.#idFactory = options.idFactory ?? randomUUID
    this.#now = options.now ?? (() => new Date().toISOString())
    applyMigrations(this.#database, this.#now())
  }

  async initialize(initialSnapshot: StateSnapshot): Promise<StateSnapshot> {
    this.#assertOpen()
    const snapshot = stateSnapshotSchema.parse(initialSnapshot)
    if (snapshot.stateVersion !== 0 || snapshot.throughSequence !== 0) {
      throw new Error('Foundation initialization requires State version 0 at Journal sequence 0')
    }

    const current = this.#readSnapshot()
    if (current !== undefined) {
      if (current.stateHash !== snapshot.stateHash) {
        throw new Error('Existing foundation State does not match requested initialization')
      }
      return current
    }

    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#database
        .prepare(
          `INSERT INTO state_snapshots(
            state_version, through_sequence, state_hash, state_json, created_at, command_id
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          snapshot.stateVersion,
          snapshot.throughSequence,
          snapshot.stateHash,
          canonicalStringify(snapshot.state),
          this.#now(),
          'foundation:initialize:v0'
        )
      this.#database
        .prepare(
          `INSERT INTO state_head(singleton, state_version, through_sequence, state_hash)
           VALUES (1, ?, ?, ?)`
        )
        .run(snapshot.stateVersion, snapshot.throughSequence, snapshot.stateHash)
      this.#database.exec('COMMIT')
      return snapshot
    } catch (error) {
      this.#rollback()
      throw error
    }
  }

  async loadSnapshot(): Promise<StateSnapshot> {
    this.#assertOpen()
    const snapshot = this.#readSnapshot()
    if (snapshot === undefined) {
      throw new Error('SQLite Store has not been initialized')
    }
    return snapshot
  }

  async *readJournal(query: JournalQuery = {}): AsyncIterable<JournalRecord> {
    this.#assertOpen()
    const afterSequence = query.afterSequence ?? 0
    const limit = Math.min(Math.max(query.limit ?? 1_000, 1), 10_000)
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

    for (const row of rows) {
      yield this.#parseJournalRow(row)
    }
  }

  async transact(input: CommitCommand): Promise<CommitReceipt> {
    this.#assertOpen()
    const command = commitCommandSchema.parse(input)
    const commandHash = canonicalHash(command)
    const existing = this.#readCommitReceipt(command.commandId, commandHash)
    if (existing !== undefined) {
      return existing
    }

    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const raced = this.#readCommitReceipt(command.commandId, commandHash)
      if (raced !== undefined) {
        this.#database.exec('COMMIT')
        return raced
      }

      const head = this.#readHead()
      if (head.stateVersion !== command.expectedStateVersion) {
        throw new Error(`Stale State version: expected ${command.expectedStateVersion}, current ${head.stateVersion}`)
      }

      let sequence = this.#nextJournalSequence()
      const persistedRecords: JournalRecord[] = []
      for (const recordInput of command.records) {
        const recordId = this.#idFactory()
        const hashInput = {
          ...recordInput,
          recordId,
          sequence
        }
        const recordHash = canonicalHash(hashInput)
        const record = journalRecordSchema.parse({ ...hashInput, recordHash })
        this.#insertJournalRecord(command.commandId, record, head.stateVersion)
        persistedRecords.push(record)
        sequence += 1
      }
      this.#faultInjector('after-journal')

      const firstSequence = persistedRecords[0]?.sequence
      const lastSequence = persistedRecords.at(-1)?.sequence
      if (firstSequence === undefined || lastSequence === undefined) {
        throw new Error('CommitCommand produced no Journal records')
      }

      let stateHash = head.stateHash
      let stateVersion = head.stateVersion
      if (command.nextSnapshot !== undefined) {
        this.#faultInjector('before-snapshot')
        stateHash = command.nextSnapshot.stateHash
        stateVersion = command.nextSnapshot.stateVersion
        this.#database
          .prepare(
            `INSERT INTO state_snapshots(
              state_version, through_sequence, state_hash, state_json, created_at, command_id
            ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            stateVersion,
            lastSequence,
            stateHash,
            canonicalStringify(command.nextSnapshot.state),
            this.#now(),
            command.commandId
          )
        this.#database
          .prepare(
            `UPDATE state_head
             SET state_version = ?, through_sequence = ?, state_hash = ?
             WHERE singleton = 1 AND state_version = ?`
          )
          .run(stateVersion, lastSequence, stateHash, head.stateVersion)
      }

      const receipt = commitReceiptSchema.parse({
        commandId: command.commandId,
        firstSequence,
        lastSequence,
        protocolVersion: PROTOCOL_VERSION,
        recordIds: persistedRecords.map(({ recordId }) => recordId),
        snapshotAdvanced: command.nextSnapshot !== undefined,
        stateHash,
        stateVersion
      })
      this.#database
        .prepare('INSERT INTO commit_receipts(command_id, command_hash, receipt_json) VALUES (?, ?, ?)')
        .run(command.commandId, commandHash, canonicalStringify(receipt))
      this.#faultInjector('before-commit')
      this.#database.exec('COMMIT')
      return receipt
    } catch (error) {
      this.#rollback()
      throw error
    }
  }

  async recordExternalEvent(input: ExternalEvent): Promise<EventReceipt> {
    const event = externalEventSchema.parse(input)
    if (event.admission !== 'recorded') {
      throw new Error('External Event ingress must begin in recorded admission state')
    }
    const eventHash = canonicalHash(event)
    const existing = this.#readExternalReceipt(event.interfaceOwnerId, event.clientEventId, eventHash)
    if (existing !== undefined) {
      return existing
    }

    await this.transact({
      commandId: `event:${canonicalHash({
        clientEventId: event.clientEventId,
        interfaceOwnerId: event.interfaceOwnerId
      })}`,
      expectedStateVersion: (await this.loadSnapshot()).stateVersion,
      protocolVersion: PROTOCOL_VERSION,
      records: [
        {
          causal: { causeSequences: [], eventId: event.eventId },
          entry: { event, kind: 'event.recorded' },
          journalSchemaVersion: 1,
          protocolVersion: PROTOCOL_VERSION,
          provenance: event.provenance,
          recordedAt: event.occurredAt
        }
      ]
    })

    const receipt = this.#readExternalReceipt(event.interfaceOwnerId, event.clientEventId, eventHash)
    if (receipt === undefined) {
      throw new Error('Committed external Event has no durable receipt')
    }
    return receipt
  }

  async getUnresolvedReceipts(interfaceOwnerId: string): Promise<EventReceipt[]> {
    this.#assertOpen()
    const rows = this.#database
      .prepare(
        `SELECT receipt_json
         FROM external_event_receipts AS receipt
         LEFT JOIN event_admissions AS admission ON admission.event_id = receipt.event_id
         WHERE receipt.interface_owner_id = ? AND admission.event_id IS NULL
         ORDER BY receipt.journal_sequence`
      )
      .all(interfaceOwnerId) as unknown as Array<{ receipt_json: string }>
    return rows.map(({ receipt_json }) => eventReceiptSchema.parse(parseJson(receipt_json)))
  }

  async putAuditBlob(input: PutAuditBlobInput): Promise<AuditBlob> {
    this.#assertOpen()
    const provenance = provenanceSchema.parse(input.provenance)
    const contentHash = digestBytes(input.bytes)
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO audit_blobs(
          content_hash, media_type, byte_length, bytes, provenance_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        contentHash,
        input.mediaType,
        input.bytes.byteLength,
        input.bytes,
        canonicalStringify(provenance),
        input.createdAt
      )
    const stored = await this.getAuditBlob(contentHash)
    if (stored === undefined) {
      throw new Error('Audit blob insert did not produce a readable blob')
    }
    if (stored.mediaType !== input.mediaType || canonicalHash(stored.provenance) !== canonicalHash(provenance)) {
      throw new Error('Content hash collision with incompatible audit metadata')
    }
    return stored
  }

  async getAuditBlob(contentHash: string): Promise<AuditBlob | undefined> {
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
      throw new Error('Audit blob failed content-address verification')
    }
    return {
      bytes: row.bytes,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      mediaType: row.media_type,
      provenance: provenanceSchema.parse(parseJson(row.provenance_json))
    }
  }

  async createEvidenceCopy(targetPath: PathLike): Promise<number> {
    this.#assertOpen()
    if (typeof targetPath === 'string') {
      mkdirSync(dirname(targetPath), { recursive: true })
    }
    this.#database.prepare('PRAGMA wal_checkpoint(FULL)').get()
    return backup(this.#database, targetPath)
  }

  configuration(): Record<string, string | number> {
    this.#assertOpen()
    const read = (name: string): string | number => {
      const row = this.#database.prepare(`PRAGMA ${name}`).get() as Record<string, string | number>
      const value = Object.values(row)[0]
      if (value === undefined) {
        throw new Error(`PRAGMA ${name} returned no value`)
      }
      return value
    }
    return {
      foreignKeys: read('foreign_keys'),
      journalMode: read('journal_mode'),
      synchronous: read('synchronous'),
      trustedSchema: read('trusted_schema')
    }
  }

  close(): void {
    if (this.#closed) {
      return
    }
    this.#database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    this.#database.close()
    this.#closed = true
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('SQLite Store is closed')
    }
  }

  #insertJournalRecord(commandId: string, record: JournalRecord, stateVersion: number): void {
    this.#database
      .prepare(
        `INSERT INTO journal_records(
          sequence, record_id, record_hash, command_id, protocol_version,
          journal_schema_version, recorded_at, entry_kind, entry_json,
          provenance_json, causal_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.sequence,
        record.recordId,
        record.recordHash,
        commandId,
        record.protocolVersion,
        record.journalSchemaVersion,
        record.recordedAt,
        record.entry.kind,
        canonicalStringify(record.entry),
        canonicalStringify(record.provenance),
        canonicalStringify(record.causal)
      )

    if (record.entry.kind === 'event.recorded' && record.entry.event.kind === 'external') {
      const event = record.entry.event
      const receipt = eventReceiptSchema.parse({
        clientEventId: event.clientEventId,
        eventId: event.eventId,
        interfaceOwnerId: event.interfaceOwnerId,
        journalSequence: record.sequence,
        protocolVersion: PROTOCOL_VERSION,
        recordedAt: record.recordedAt,
        stateVersion
      })
      this.#database
        .prepare(
          `INSERT INTO external_event_receipts(
            interface_owner_id, client_event_id, event_id, event_hash, event_json,
            journal_sequence, receipt_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.interfaceOwnerId,
          event.clientEventId,
          event.eventId,
          canonicalHash(event),
          canonicalStringify(event),
          record.sequence,
          canonicalStringify(receipt)
        )
    }
    if (record.entry.kind === 'event.admitted') {
      this.#database
        .prepare('INSERT INTO event_admissions(event_id, journal_sequence) VALUES (?, ?)')
        .run(record.entry.eventId, record.sequence)
    }
    if (
      record.entry.kind === 'effect.decision' &&
      record.entry.decision.decision === 'accepted' &&
      record.entry.decision.effect.kind === 'continuation.fire'
    ) {
      const eventId = record.causal.eventId
      if (eventId === undefined) {
        throw new Error('Accepted continuation.fire requires a causal Event ID')
      }
      this.#database
        .prepare('INSERT INTO continuation_fires(continuation_id, event_id, journal_sequence) VALUES (?, ?, ?)')
        .run(record.entry.decision.effect.continuationId, eventId, record.sequence)
    }
  }

  #nextJournalSequence(): number {
    const row = this.#database
      .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM journal_records')
      .get() as { next_sequence: number }
    return row.next_sequence
  }

  #readHead(): { stateHash: string; stateVersion: number; throughSequence: number } {
    const row = this.#database
      .prepare('SELECT state_version, state_hash, through_sequence FROM state_head WHERE singleton = 1')
      .get() as { state_hash: string; state_version: number; through_sequence: number } | undefined
    if (row === undefined) {
      throw new Error('SQLite Store has not been initialized')
    }
    return {
      stateHash: row.state_hash,
      stateVersion: row.state_version,
      throughSequence: row.through_sequence
    }
  }

  #readSnapshot(): StateSnapshot | undefined {
    const row = this.#database
      .prepare(
        `SELECT snapshot.state_version, snapshot.through_sequence, snapshot.state_hash, snapshot.state_json
         FROM state_head AS head
         JOIN state_snapshots AS snapshot ON snapshot.state_version = head.state_version
         WHERE head.singleton = 1`
      )
      .get() as unknown as SnapshotRow | undefined
    if (row === undefined) {
      return undefined
    }
    return stateSnapshotSchema.parse({
      state: parseJson(row.state_json),
      stateHash: row.state_hash,
      stateVersion: row.state_version,
      throughSequence: row.through_sequence
    })
  }

  #readCommitReceipt(commandId: string, commandHash: string): CommitReceipt | undefined {
    const row = this.#database
      .prepare('SELECT command_hash, receipt_json FROM commit_receipts WHERE command_id = ?')
      .get(commandId) as unknown as CommitReceiptRow | undefined
    if (row === undefined) {
      return undefined
    }
    if (row.command_hash !== commandHash) {
      throw new Error(`Command ID ${commandId} was reused with different content`)
    }
    return commitReceiptSchema.parse(parseJson(row.receipt_json))
  }

  #readExternalReceipt(interfaceOwnerId: string, clientEventId: string, eventHash: string): EventReceipt | undefined {
    const row = this.#database
      .prepare(
        `SELECT event_hash, event_json, receipt_json
         FROM external_event_receipts
         WHERE interface_owner_id = ? AND client_event_id = ?`
      )
      .get(interfaceOwnerId, clientEventId) as unknown as ExternalReceiptRow | undefined
    if (row === undefined) {
      return undefined
    }
    if (row.event_hash !== eventHash) {
      throw new Error('clientEventId was reused with different Event content')
    }
    externalEventSchema.parse(parseJson(row.event_json))
    return eventReceiptSchema.parse(parseJson(row.receipt_json))
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

  #rollback(): void {
    try {
      this.#database.exec('ROLLBACK')
    } catch {
      // The original error remains authoritative if SQLite already ended the transaction.
    }
  }
}
