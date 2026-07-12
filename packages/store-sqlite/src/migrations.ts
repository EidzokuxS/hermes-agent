/// <reference types="node" />

import { readFileSync } from 'node:fs'

import { canonicalHash } from '@nox/protocol'

import { FOUNDATION_MIGRATION_NAME, FOUNDATION_SCHEMA_VERSION } from './schema.js'

interface MigrationDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    all(...anonymousParameters: unknown[]): unknown[]
    run(...anonymousParameters: unknown[]): unknown
  }
}

const foundationSql = readFileSync(new URL('../migrations/001_foundation.sql', import.meta.url), 'utf8')

export const foundationMigration = {
  checksum: canonicalHash(foundationSql),
  name: FOUNDATION_MIGRATION_NAME,
  sql: foundationSql,
  version: FOUNDATION_SCHEMA_VERSION
} as const

export function applyMigrations(database: MigrationDatabase, appliedAt: string): void {
  const hasMigrationTable = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .all().length

  if (!hasMigrationTable) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(foundationMigration.sql)
      database
        .prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(foundationMigration.version, foundationMigration.name, foundationMigration.checksum, appliedAt)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return
  }

  const rows = database
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as Array<{ checksum: string; name: string; version: number }>

  if (rows.length !== 1) {
    throw new Error(`Unsupported schema migration count: ${rows.length}`)
  }
  const [applied] = rows
  if (
    applied?.version !== foundationMigration.version ||
    applied.name !== foundationMigration.name ||
    applied.checksum !== foundationMigration.checksum
  ) {
    throw new Error('Foundation migration identity does not match the executable schema')
  }
}
