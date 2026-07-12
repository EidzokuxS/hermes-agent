/// <reference types="node" />

import { readFileSync } from 'node:fs'

import { canonicalHash } from '@nox/protocol'

import {
  FOUNDATION_MIGRATION_NAME,
  FOUNDATION_SCHEMA_VERSION,
  RUNTIME_LOOKUP_MIGRATION_NAME,
  RUNTIME_LOOKUP_SCHEMA_VERSION
} from './schema.js'

interface MigrationDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    all(...anonymousParameters: unknown[]): unknown[]
    run(...anonymousParameters: unknown[]): unknown
  }
}

const foundationSql = readFileSync(new URL('../migrations/001_foundation.sql', import.meta.url), 'utf8')
const runtimeLookupSql = readFileSync(new URL('../migrations/002_runtime_lookups.sql', import.meta.url), 'utf8')

export const foundationMigration = {
  checksum: canonicalHash(foundationSql),
  name: FOUNDATION_MIGRATION_NAME,
  sql: foundationSql,
  version: FOUNDATION_SCHEMA_VERSION
} as const

export const runtimeLookupMigration = {
  checksum: canonicalHash(runtimeLookupSql),
  name: RUNTIME_LOOKUP_MIGRATION_NAME,
  sql: runtimeLookupSql,
  version: RUNTIME_LOOKUP_SCHEMA_VERSION
} as const

export const migrations = [foundationMigration, runtimeLookupMigration] as const

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
  }

  const rows = database
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as Array<{ checksum: string; name: string; version: number }>

  if (rows.length > migrations.length) {
    throw new Error(`Unsupported schema migration count: ${rows.length}`)
  }
  for (const [index, applied] of rows.entries()) {
    const expected = migrations[index]
    if (
      expected === undefined ||
      applied.version !== expected.version ||
      applied.name !== expected.name ||
      applied.checksum !== expected.checksum
    ) {
      throw new Error(`Migration ${applied.version} identity does not match the executable schema`)
    }
  }

  for (const migration of migrations.slice(rows.length)) {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(migration.sql)
      database
        .prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, migration.checksum, appliedAt)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
}
