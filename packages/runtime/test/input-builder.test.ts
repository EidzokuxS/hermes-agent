import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { cortexInputSchema } from '@nox/protocol'
import { describe, expect, it } from 'vitest'

import { buildCortexInput } from '../src/index.js'

import { createInputOptions, fixtureAt } from './support/fixtures.js'

describe('deterministic CortexInput assembly', () => {
  it('sorts Journal context and produces one canonical input hash', () => {
    const options = createInputOptions()
    const reversed = { ...options, journal: [...options.journal].reverse() }
    const first = buildCortexInput(options)
    const second = buildCortexInput(reversed)

    expect(first).toEqual(second)
    expect(first.input.journalContext.map(({ sequence }) => sequence)).toEqual([1, 2])
    expect(first.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('keeps transcript outside identity and the entire strict input contract', () => {
    const built = buildCortexInput(createInputOptions())
    expect(built.input.identity.identityId).toBe('nox')
    expect(built.serialized).not.toContain('transcript')
    expect(cortexInputSchema.safeParse({ ...built.input, transcript: [] }).success).toBe(false)
  })

  it('represents clock regression as observed data without manufacturing urgency', () => {
    const options = createInputOptions()
    const built = buildCortexInput({ ...options, observedAt: fixtureAt.replace('08:00', '07:59') })

    expect(built.input.temporal).toEqual({
      clockRelation: 'regressed',
      elapsedMilliseconds: 0,
      observedAt: '2026-07-12T07:59:00.000Z',
      rawClockDeltaMilliseconds: -60_000
    })
    expect(built.serialized).not.toContain('urgent')
    expect(built.serialized).not.toContain('overdue')
  })

  it('enforces the configured Journal bound deterministically', () => {
    const options = createInputOptions()
    const built = buildCortexInput({
      ...options,
      bounds: { ...options.bounds, maxJournalRecords: 1 }
    })
    expect(built.input.journalContext.map(({ sequence }) => sequence)).toEqual([2])
  })

  it('emits the same golden hash from two fresh processes', () => {
    const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'))
    const child = fileURLToPath(new URL('input-hash-child.ts', import.meta.url))
    const run = (): string => execFileSync(process.execPath, [tsxCli, child], { encoding: 'utf8' }).trim()

    const first = run()
    const second = run()
    expect(first).toBe(second)
    expect(first).toBe(buildCortexInput(createInputOptions()).inputHash)
    expect(first).toBe('sha256:0379e34b8c58548da7eb1176431bcb0cb1ec4bc2a23471738ceb4ac045c56a19')
  })
})
