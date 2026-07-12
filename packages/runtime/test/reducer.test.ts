import { describe, expect, it } from 'vitest'

import { reduceAcceptedEffects } from '../src/index.js'

import {
  acceptedDecision,
  createFoundationState,
  createSnapshot,
  fixtureObservedAt,
  runtimeProvenance
} from './support/fixtures.js'

const statePatch = (ordinal: number, path: `/picture/${string}` | `/workingField/${string}`, value: string) =>
  acceptedDecision({ kind: 'state.patch', operation: 'add', path, protocolVersion: 1, value }, ordinal)

describe('pure State reducer', () => {
  it('applies accepted State Effects in ordinal order and advances once', () => {
    const result = reduceAcceptedEffects({
      decisions: [statePatch(1, '/picture/relation', 'partner'), statePatch(0, '/workingField/focus', 'Nox')],
      observedAt: fixtureObservedAt,
      snapshot: createSnapshot()
    })

    expect(result).toMatchObject({ acceptedStateChanges: 2, stateChanged: true })
    expect(result.nextSnapshot?.stateVersion).toBe(1)
    expect(result.state.picture.relation).toBe('partner')
    expect(result.state.workingField.focus).toBe('Nox')
    expect(result.state.temporalAnchor).toEqual({
      lastObservedAt: fixtureObservedAt,
      logicalTick: 1
    })
  })

  it('is invariant to decision-array order for fixed ordinals', () => {
    const decisions = [
      statePatch(0, '/workingField/a', 'one'),
      statePatch(1, '/picture/b', 'two'),
      acceptedDecision(
        {
          kind: 'continuation.schedule',
          protocolVersion: 1,
          seed: {
            due: { at: '2026-07-12T09:00:00.000Z', kind: 'at-time' },
            instruction: 'Return to this.',
            label: 'return',
            maxFireCount: 1,
            protocolVersion: 1
          }
        },
        2
      )
    ]
    const permutations = [
      decisions,
      [decisions[0]!, decisions[2]!, decisions[1]!],
      [decisions[1]!, decisions[0]!, decisions[2]!],
      [decisions[1]!, decisions[2]!, decisions[0]!],
      [decisions[2]!, decisions[0]!, decisions[1]!],
      [decisions[2]!, decisions[1]!, decisions[0]!]
    ]
    const hashes = permutations.map(
      ordered =>
        reduceAcceptedEffects({
          decisions: ordered,
          observedAt: fixtureObservedAt,
          snapshot: createSnapshot()
        }).nextSnapshot?.stateHash
    )
    expect(new Set(hashes).size).toBe(1)
  })

  it('keeps State and version unchanged for emission-only and rejected decisions', () => {
    const snapshot = createSnapshot()
    const emission = acceptedDecision(
      {
        content: 'Visible without State mutation',
        format: 'text',
        kind: 'emission.append',
        protocolVersion: 1
      },
      0
    )
    const rejected = {
      actId: 'act-001',
      code: 'policy-denied',
      decidedAt: fixtureObservedAt,
      decision: 'rejected',
      effect: {
        kind: 'state.patch',
        operation: 'replace',
        path: '/picture/name',
        protocolVersion: 1,
        value: 'not-authorized'
      },
      effectId: 'effect-rejected',
      message: 'Rejected by runtime policy',
      ordinal: 1,
      provenance: runtimeProvenance,
      stateChanging: false
    } as const
    const result = reduceAcceptedEffects({
      decisions: [rejected, emission],
      observedAt: fixtureObservedAt,
      snapshot
    })

    expect(result).toEqual({
      acceptedStateChanges: 0,
      state: snapshot.state,
      stateChanged: false
    })
  })

  it('schedules and then cancels a bounded Continuation through State', () => {
    const scheduled = reduceAcceptedEffects({
      decisions: [
        acceptedDecision(
          {
            kind: 'continuation.schedule',
            protocolVersion: 1,
            seed: {
              due: { at: '2026-07-12T09:00:00.000Z', kind: 'at-time' },
              instruction: 'Return to this.',
              label: 'return',
              maxFireCount: 1,
              protocolVersion: 1
            }
          },
          0
        )
      ],
      observedAt: fixtureObservedAt,
      snapshot: createSnapshot()
    })
    const continuationId = scheduled.state.openContinuations[0]?.continuationId
    expect(continuationId).toMatch(/^continuation:sha256:/)

    const cancelled = reduceAcceptedEffects({
      decisions: [
        acceptedDecision(
          { continuationId: continuationId!, kind: 'continuation.cancel', protocolVersion: 1 },
          0,
          'effect-cancel'
        )
      ],
      observedAt: '2026-07-12T08:02:00.000Z',
      snapshot: {
        ...scheduled.nextSnapshot!,
        throughSequence: 10
      }
    })
    expect(cancelled.nextSnapshot?.stateVersion).toBe(2)
    expect(cancelled.state.openContinuations).toEqual([])
  })

  it('supports nested object and array patches without mutating the input snapshot', () => {
    const originalState = createFoundationState()
    originalState.workingField = { list: ['a', 'c'], nested: { present: true } }
    const snapshot = createSnapshot(originalState)
    const result = reduceAcceptedEffects({
      decisions: [
        acceptedDecision(
          {
            kind: 'state.patch',
            operation: 'add',
            path: '/workingField/list/1',
            protocolVersion: 1,
            value: 'b'
          },
          0
        ),
        acceptedDecision(
          {
            kind: 'state.patch',
            operation: 'remove',
            path: '/workingField/nested/present',
            protocolVersion: 1
          },
          1
        )
      ],
      observedAt: fixtureObservedAt,
      snapshot
    })
    expect(result.state.workingField).toEqual({ list: ['a', 'b', 'c'], nested: {} })
    expect(snapshot.state.workingField).toEqual({ list: ['a', 'c'], nested: { present: true } })
  })

  it('rejects unsafe object keys and nonexistent replace targets', () => {
    expect(() =>
      reduceAcceptedEffects({
        decisions: [statePatch(0, '/workingField/__proto__', 'bad')],
        observedAt: fixtureObservedAt,
        snapshot: createSnapshot()
      })
    ).toThrow()
    expect(() =>
      reduceAcceptedEffects({
        decisions: [
          acceptedDecision(
            {
              kind: 'state.patch',
              operation: 'replace',
              path: '/workingField/missing',
              protocolVersion: 1,
              value: 'bad'
            },
            0
          )
        ],
        observedAt: fixtureObservedAt,
        snapshot: createSnapshot()
      })
    ).toThrow('does not exist')
  })
})
