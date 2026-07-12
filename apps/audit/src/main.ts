/// <reference types="node" />

import { canonicalStringify } from '@nox/protocol'

import { verifyAuditDatabase } from './verify.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

const databasePath = argument('database')
if (databasePath === undefined) {
  throw new Error('Usage: @nox/audit --database <nox.sqlite> [--desktop-state-version <number>]')
}
const desktopVersionValue = argument('desktop-state-version')
const desktopVersion = desktopVersionValue === undefined ? undefined : Number(desktopVersionValue)
const report = verifyAuditDatabase(databasePath, desktopVersion)
process.stdout.write(`${canonicalStringify(report)}\n`)
