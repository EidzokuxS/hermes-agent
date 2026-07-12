import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  actProposalSchema,
  actStartedSchema,
  actTerminalSchema,
  canonicalHash,
  canonicalStringify,
  commitCommandSchema,
  continuationSchema,
  effectDecisionSchema,
  eventSchema,
  foundationStateSchema,
  journalRecordInputSchema,
  PROTOCOL_VERSION,
  statePathSchema
} from '../src/index.js'

const fixtureUrl = (name: string): URL => new URL(`fixtures/${name}`, import.meta.url)
const readFixture = (name: string): unknown => JSON.parse(readFileSync(fixtureUrl(name), 'utf8')) as unknown

const recordedAt = '2026-07-12T08:00:01.000Z'
const runtimeProvenance = { component: 'protocol-test', kind: 'runtime' } as const
const causal = { causeSequences: [1], eventId: 'event-001' }

function journalRecord(entry: unknown): unknown {
  return {
    causal,
    entry,
    journalSchemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    provenance: runtimeProvenance,
    recordedAt
  }
}

describe('protocol v1 golden fixtures', () => {
  it('round-trips every foundation primitive through canonical JSON', () => {
    const event = eventSchema.parse(readFixture('external-event-recorded.json'))
    const act = actStartedSchema.parse(readFixture('act-started.json'))
    const proposal = actProposalSchema.parse(readFixture('act-proposal.json'))
    const continuation = continuationSchema.parse(readFixture('open-continuation.json'))
    const state = foundationStateSchema.parse(readFixture('foundation-state.json'))
    const journal = journalRecordInputSchema.parse(readFixture('journal-record-input.json'))

    expect(eventSchema.parse(JSON.parse(canonicalStringify(event)))).toEqual(event)
    expect(actStartedSchema.parse(JSON.parse(canonicalStringify(act)))).toEqual(act)
    expect(actProposalSchema.parse(JSON.parse(canonicalStringify(proposal)))).toEqual(proposal)
    expect(continuationSchema.parse(JSON.parse(canonicalStringify(continuation)))).toEqual(continuation)
    expect(foundationStateSchema.parse(JSON.parse(canonicalStringify(state)))).toEqual(state)
    expect(journalRecordInputSchema.parse(JSON.parse(canonicalStringify(journal)))).toEqual(journal)
  })

  it('rejects an unversioned Event', () => {
    const event = readFixture('external-event-recorded.json') as Record<string, unknown>
    delete event.protocolVersion
    expect(eventSchema.safeParse(event).success).toBe(false)
  })

  it('rejects State paths outside picture and workingField', () => {
    expect(statePathSchema.safeParse('/identity/revision').success).toBe(false)
    expect(statePathSchema.safeParse('/workingField/focus').success).toBe(true)
  })

  it('rejects silent proposals that contain Effects', () => {
    const proposal = readFixture('act-proposal.json') as Record<string, unknown>
    proposal.settlement = 'silent'
    expect(actProposalSchema.safeParse(proposal).success).toBe(false)
  })

  it('rejects ambiguous Act terminal states', () => {
    expect(
      actTerminalSchema.safeParse({
        actId: 'act-001',
        completedAt: recordedAt,
        protocolVersion: 1,
        stateVersion: 0,
        status: 'completed'
      }).success
    ).toBe(false)
  })

  it('rejects unbounded Continuation proposals', () => {
    expect(
      actProposalSchema.safeParse({
        effects: [
          {
            kind: 'continuation.schedule',
            protocolVersion: 1,
            seed: {
              due: { at: '2026-07-12T09:00:00.000Z', kind: 'at-time' },
              instruction: 'x'.repeat(4097),
              label: 'too large',
              maxFireCount: 2,
              protocolVersion: 1
            }
          }
        ],
        protocolVersion: 1,
        settlement: 'effects'
      }).success
    ).toBe(false)
  })
})

describe('State-version and Effect authority', () => {
  it('rejects an incorrect stateChanging classification', () => {
    expect(
      effectDecisionSchema.safeParse({
        actId: 'act-001',
        decidedAt: recordedAt,
        decision: 'accepted',
        effect: {
          content: 'visible only',
          format: 'text',
          kind: 'emission.append',
          protocolVersion: 1
        },
        effectId: 'effect-001',
        ordinal: 0,
        provenance: runtimeProvenance,
        stateChanging: true
      }).success
    ).toBe(false)
  })

  it('rejects State advancement without an accepted State-changing Effect', () => {
    const state = foundationStateSchema.parse(readFixture('foundation-state.json'))
    const nextSnapshot = { state, stateHash: canonicalHash(state), stateVersion: 1 }
    const command = {
      commandId: 'command-invalid-state-write',
      expectedStateVersion: 0,
      nextSnapshot,
      protocolVersion: 1,
      records: [
        journalRecord({
          kind: 'state.advanced',
          stateHash: nextSnapshot.stateHash,
          stateVersion: 1
        })
      ]
    }
    expect(commitCommandSchema.safeParse(command).success).toBe(false)
  })

  it('accepts one atomic State advance backed by an accepted Effect', () => {
    const state = foundationStateSchema.parse(readFixture('foundation-state.json'))
    const nextState = { ...state, workingField: { focus: 'first-loop' } }
    const nextSnapshot = { state: nextState, stateHash: canonicalHash(nextState), stateVersion: 1 }
    const decision = {
      actId: 'act-001',
      decidedAt: recordedAt,
      decision: 'accepted',
      effect: {
        kind: 'state.patch',
        operation: 'add',
        path: '/workingField/focus',
        protocolVersion: 1,
        value: 'first-loop'
      },
      effectId: 'effect-001',
      ordinal: 0,
      provenance: runtimeProvenance,
      stateChanging: true
    }
    const command = {
      commandId: 'command-valid-state-write',
      expectedStateVersion: 0,
      nextSnapshot,
      protocolVersion: 1,
      records: [
        journalRecord({ decision, kind: 'effect.decision' }),
        journalRecord({
          kind: 'state.advanced',
          stateHash: nextSnapshot.stateHash,
          stateVersion: 1
        }),
        journalRecord({
          kind: 'act.terminal',
          terminal: {
            actId: 'act-001',
            completedAt: recordedAt,
            effectDecisionIds: ['effect-001'],
            protocolVersion: 1,
            stateVersion: 1,
            status: 'completed-effects'
          }
        })
      ]
    }

    expect(commitCommandSchema.parse(command).nextSnapshot?.stateVersion).toBe(1)
    expect(journalRecordInputSchema.safeParse(command.records[0]).success).toBe(true)
  })

  it('keeps a silent terminal outcome on the current State version', () => {
    const command = {
      commandId: 'command-silent',
      expectedStateVersion: 4,
      protocolVersion: 1,
      records: [
        journalRecord({
          kind: 'act.terminal',
          terminal: {
            actId: 'act-silent',
            completedAt: recordedAt,
            protocolVersion: 1,
            stateVersion: 4,
            status: 'completed-silent'
          }
        })
      ]
    }
    expect(commitCommandSchema.parse(command).nextSnapshot).toBeUndefined()
  })
})

describe('canonical hash', () => {
  it('is stable across key order and matches the SHA-256 algorithm', () => {
    expect(canonicalHash({ b: 2, a: 1 })).toBe(canonicalHash({ a: 1, b: 2 }))
    expect(canonicalHash('abc')).toBe('sha256:6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25')
  })

  it('is identical in two fresh processes', () => {
    const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'))
    const child = fileURLToPath(new URL('hash-child.ts', import.meta.url))
    const fixture = fileURLToPath(fixtureUrl('canonical-value.json'))
    const run = (): string => execFileSync(process.execPath, [tsxCli, child, fixture], { encoding: 'utf8' }).trim()

    const first = run()
    const second = run()
    expect(first).toBe(second)
    expect(first).toBe(canonicalHash(readFixture('canonical-value.json')))
  })
})
