CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE journal_records (
  sequence INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE,
  record_hash TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL,
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
  journal_schema_version INTEGER NOT NULL CHECK (journal_schema_version = 1),
  recorded_at TEXT NOT NULL,
  entry_kind TEXT NOT NULL,
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  causal_json TEXT NOT NULL CHECK (json_valid(causal_json))
) STRICT;

CREATE INDEX journal_records_command_sequence
ON journal_records(command_id, sequence);

CREATE INDEX journal_records_kind_sequence
ON journal_records(entry_kind, sequence);

CREATE TABLE state_snapshots (
  state_version INTEGER PRIMARY KEY CHECK (state_version >= 0),
  through_sequence INTEGER NOT NULL UNIQUE CHECK (through_sequence >= 0),
  state_hash TEXT NOT NULL UNIQUE,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  created_at TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE state_head (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state_version INTEGER NOT NULL REFERENCES state_snapshots(state_version),
  through_sequence INTEGER NOT NULL,
  state_hash TEXT NOT NULL
) STRICT;

CREATE TABLE audit_blobs (
  content_hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  bytes BLOB NOT NULL,
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE external_event_receipts (
  interface_owner_id TEXT NOT NULL,
  client_event_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_hash TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  journal_sequence INTEGER NOT NULL UNIQUE REFERENCES journal_records(sequence),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  PRIMARY KEY (interface_owner_id, client_event_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE event_admissions (
  event_id TEXT PRIMARY KEY,
  journal_sequence INTEGER NOT NULL UNIQUE REFERENCES journal_records(sequence)
) WITHOUT ROWID, STRICT;

CREATE TABLE continuation_fires (
  continuation_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  journal_sequence INTEGER NOT NULL UNIQUE REFERENCES journal_records(sequence)
) WITHOUT ROWID, STRICT;

CREATE TABLE commit_receipts (
  command_id TEXT PRIMARY KEY,
  command_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json))
) WITHOUT ROWID, STRICT;

CREATE TRIGGER journal_records_no_update
BEFORE UPDATE ON journal_records
BEGIN
  SELECT RAISE(ABORT, 'journal_records is append-only');
END;

CREATE TRIGGER schema_migrations_no_update
BEFORE UPDATE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema_migrations is append-only');
END;

CREATE TRIGGER schema_migrations_no_delete
BEFORE DELETE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'schema_migrations is append-only');
END;

CREATE TRIGGER journal_records_no_delete
BEFORE DELETE ON journal_records
BEGIN
  SELECT RAISE(ABORT, 'journal_records is append-only');
END;

CREATE TRIGGER state_snapshots_no_update
BEFORE UPDATE ON state_snapshots
BEGIN
  SELECT RAISE(ABORT, 'state_snapshots is append-only');
END;

CREATE TRIGGER state_snapshots_no_delete
BEFORE DELETE ON state_snapshots
BEGIN
  SELECT RAISE(ABORT, 'state_snapshots is append-only');
END;

CREATE TRIGGER audit_blobs_no_update
BEFORE UPDATE ON audit_blobs
BEGIN
  SELECT RAISE(ABORT, 'audit_blobs is content-addressed');
END;

CREATE TRIGGER audit_blobs_no_delete
BEFORE DELETE ON audit_blobs
BEGIN
  SELECT RAISE(ABORT, 'audit_blobs is append-only');
END;

CREATE TRIGGER external_event_receipts_no_update
BEFORE UPDATE ON external_event_receipts
BEGIN
  SELECT RAISE(ABORT, 'external_event_receipts is append-only');
END;

CREATE TRIGGER external_event_receipts_no_delete
BEFORE DELETE ON external_event_receipts
BEGIN
  SELECT RAISE(ABORT, 'external_event_receipts is append-only');
END;

CREATE TRIGGER event_admissions_no_update
BEFORE UPDATE ON event_admissions
BEGIN
  SELECT RAISE(ABORT, 'event_admissions is append-only');
END;

CREATE TRIGGER event_admissions_no_delete
BEFORE DELETE ON event_admissions
BEGIN
  SELECT RAISE(ABORT, 'event_admissions is append-only');
END;

CREATE TRIGGER continuation_fires_no_update
BEFORE UPDATE ON continuation_fires
BEGIN
  SELECT RAISE(ABORT, 'continuation_fires is append-only');
END;

CREATE TRIGGER continuation_fires_no_delete
BEFORE DELETE ON continuation_fires
BEGIN
  SELECT RAISE(ABORT, 'continuation_fires is append-only');
END;

CREATE TRIGGER commit_receipts_no_update
BEFORE UPDATE ON commit_receipts
BEGIN
  SELECT RAISE(ABORT, 'commit_receipts is append-only');
END;

CREATE TRIGGER commit_receipts_no_delete
BEFORE DELETE ON commit_receipts
BEGIN
  SELECT RAISE(ABORT, 'commit_receipts is append-only');
END;

CREATE TRIGGER state_head_no_delete
BEFORE DELETE ON state_head
BEGIN
  SELECT RAISE(ABORT, 'state_head cannot be deleted');
END;

CREATE TRIGGER state_head_monotonic_update
BEFORE UPDATE ON state_head
WHEN NEW.state_version <> OLD.state_version + 1
BEGIN
  SELECT RAISE(ABORT, 'state_head must advance by one version');
END;

CREATE TRIGGER state_head_single_insert
BEFORE INSERT ON state_head
WHEN EXISTS (SELECT 1 FROM state_head)
BEGIN
  SELECT RAISE(ABORT, 'state_head already exists');
END;
