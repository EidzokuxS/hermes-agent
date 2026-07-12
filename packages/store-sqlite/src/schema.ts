export const FOUNDATION_MIGRATION_NAME = '001_foundation'
export const FOUNDATION_SCHEMA_VERSION = 1

export interface AuditBlobRow {
  byte_length: number
  bytes: Uint8Array
  content_hash: string
  created_at: string
  media_type: string
  provenance_json: string
}

export interface CommitReceiptRow {
  command_hash: string
  receipt_json: string
}

export interface ExternalReceiptRow {
  event_hash: string
  event_json: string
  receipt_json: string
}

export interface JournalRow {
  causal_json: string
  command_id: string
  entry_json: string
  journal_schema_version: number
  protocol_version: number
  provenance_json: string
  record_hash: string
  record_id: string
  recorded_at: string
  sequence: number
}

export interface MigrationRow {
  checksum: string
  name: string
  version: number
}

export interface SnapshotRow {
  state_hash: string
  state_json: string
  state_version: number
  through_sequence: number
}
