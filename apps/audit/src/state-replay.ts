import { canonicalHash, canonicalize, foundationStateSchema, stateSnapshotSchema } from '@nox/protocol'
import type { EffectDecision, FoundationState, JsonValue, StateSnapshot } from '@nox/protocol'

import type { RawAuditExport } from './raw-reader.js'

export interface ReplayStep {
  acceptedDecisionIds: string[]
  journalSequence: number
  stateHash: string
  stateVersion: number
}

export interface StateReplayReport {
  acceptedStateEffects: number
  finalStateHash: string
  finalStateVersion: number
  journalRecords: number
  rejectedEffects: number
  status: 'pass'
  steps: ReplayStep[]
}

function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pointerTokens(pointer: string): string[] {
  return pointer
    .split('/')
    .slice(1)
    .map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function arrayIndex(token: string, length: number, allowEnd: boolean): number {
  if (allowEnd && token === '-') {
    return length
  }
  if (!/^(0|[1-9]\d*)$/.test(token)) {
    throw new Error(`Replay rejected invalid array index ${token}`)
  }
  const index = Number(token)
  const maximum = allowEnd ? length : length - 1
  if (!Number.isSafeInteger(index) || index < 0 || index > maximum) {
    throw new Error(`Replay array index out of bounds: ${token}`)
  }
  return index
}

function patchJson(
  root: JsonValue,
  tokens: string[],
  operation: 'add' | 'remove' | 'replace',
  value?: JsonValue
): JsonValue {
  if (tokens.length === 0) {
    if (operation === 'remove' || value === undefined) {
      throw new Error('Replay cannot remove a State root')
    }
    return canonicalize(value)
  }
  const clone = canonicalize(root)
  let cursor: JsonValue = clone
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      cursor = cursor[arrayIndex(token, cursor.length, false)] as JsonValue
    } else if (isObject(cursor) && Object.hasOwn(cursor, token)) {
      cursor = cursor[token] as JsonValue
    } else {
      throw new Error(`Replay cannot traverse State token ${token}`)
    }
  }
  const leaf = tokens.at(-1)
  if (leaf === undefined) {
    throw new Error('Replay State patch has no leaf')
  }
  if (Array.isArray(cursor)) {
    const index = arrayIndex(leaf, cursor.length, operation === 'add')
    if (operation === 'remove') {
      cursor.splice(index, 1)
    } else {
      if (value === undefined) {
        throw new Error(`Replay ${operation} requires a value`)
      }
      if (operation === 'add') {
        cursor.splice(index, 0, canonicalize(value))
      } else {
        cursor[index] = canonicalize(value)
      }
    }
  } else if (isObject(cursor)) {
    const exists = Object.hasOwn(cursor, leaf)
    if (operation !== 'add' && !exists) {
      throw new Error(`Replay State target does not exist: ${leaf}`)
    }
    if (operation === 'remove') {
      delete cursor[leaf]
    } else {
      if (value === undefined) {
        throw new Error(`Replay ${operation} requires a value`)
      }
      cursor[leaf] = canonicalize(value)
    }
  } else {
    throw new Error('Replay State parent is scalar')
  }
  return clone
}

function applyDecision(
  state: FoundationState,
  decision: Extract<EffectDecision, { decision: 'accepted' }>
): FoundationState {
  const effect = decision.effect
  if (effect.kind === 'state.patch') {
    const [root, ...tokens] = pointerTokens(effect.path)
    if (root !== 'picture' && root !== 'workingField') {
      throw new Error(`Replay encountered unsupported State root: ${root ?? 'missing'}`)
    }
    const patched = patchJson(state[root], tokens, effect.operation, effect.value)
    if (!isObject(patched)) {
      throw new Error(`Replay State root ${root} ceased to be an object`)
    }
    return foundationStateSchema.parse({ ...state, [root]: patched })
  }
  if (effect.kind === 'continuation.schedule') {
    const continuationId = `continuation:${canonicalHash({ actId: decision.actId, effectId: decision.effectId })}`
    return foundationStateSchema.parse({
      ...state,
      openContinuations: [
        ...state.openContinuations,
        {
          continuationId,
          createdAt: decision.decidedAt,
          fireCount: 0,
          originActId: decision.actId,
          seed: effect.seed,
          status: 'open'
        }
      ]
    })
  }
  if (effect.kind === 'continuation.cancel' || effect.kind === 'continuation.fire') {
    const remaining = state.openContinuations.filter(item => item.continuationId !== effect.continuationId)
    if (remaining.length === state.openContinuations.length) {
      throw new Error(`Replay could not find Continuation ${effect.continuationId}`)
    }
    return foundationStateSchema.parse({ ...state, openContinuations: remaining })
  }
  throw new Error(`Replay received non-State Effect ${effect.kind}`)
}

function verifySnapshot(expected: StateSnapshot | undefined, state: FoundationState, version: number): StateSnapshot {
  if (expected === undefined) {
    throw new Error(`Replay has no stored snapshot for State version ${version}`)
  }
  const parsed = stateSnapshotSchema.parse(expected)
  const hash = canonicalHash(state)
  if (parsed.stateVersion !== version || parsed.stateHash !== hash || canonicalHash(parsed.state) !== hash) {
    throw new Error(`Replay mismatch at State version ${version}`)
  }
  return parsed
}

export function replayState(raw: RawAuditExport, desktopRestoredVersion?: number): StateReplayReport {
  if (raw.integrity !== 'ok') {
    throw new Error(`SQLite integrity check failed: ${raw.integrity}`)
  }
  const genesis = verifySnapshot(raw.snapshots[0], raw.snapshots[0]?.state ?? ({} as FoundationState), 0)
  let state = genesis.state
  let version = 0
  let rejectedEffects = 0
  let acceptedStateEffects = 0
  let pending: Array<Extract<EffectDecision, { decision: 'accepted' }>> = []
  const steps: ReplayStep[] = []

  for (const [index, record] of raw.journal.entries()) {
    if (record.sequence !== index + 1) {
      throw new Error(`Replay Journal sequence gap at ${index + 1}`)
    }
    if (record.causal.causeSequences.some(sequence => sequence >= record.sequence)) {
      throw new Error(`Replay found a non-prior causal sequence at ${record.sequence}`)
    }
    if (record.entry.kind === 'effect.decision') {
      const decision = record.entry.decision
      if (decision.decision === 'rejected') {
        rejectedEffects += 1
      } else if (decision.stateChanging) {
        pending.push(decision)
      }
    }
    if (record.entry.kind !== 'state.advanced') {
      continue
    }
    if (pending.length === 0) {
      throw new Error(`State advanced at ${record.sequence} without accepted State Effects`)
    }
    for (const decision of pending) {
      state = applyDecision(state, decision)
    }
    const observedAt = pending.at(-1)?.decidedAt
    if (observedAt === undefined) {
      throw new Error('Replay State batch has no observed time')
    }
    state = foundationStateSchema.parse({
      ...state,
      temporalAnchor: { lastObservedAt: observedAt, logicalTick: state.temporalAnchor.logicalTick + 1 }
    })
    version += 1
    const stateHash = canonicalHash(state)
    if (record.entry.stateVersion !== version || record.entry.stateHash !== stateHash) {
      throw new Error(`Journal State advancement mismatch at sequence ${record.sequence}`)
    }
    verifySnapshot(raw.snapshots[version], state, version)
    acceptedStateEffects += pending.length
    steps.push({
      acceptedDecisionIds: pending.map(decision => decision.effectId),
      journalSequence: record.sequence,
      stateHash,
      stateVersion: version
    })
    pending = []
  }
  if (pending.length !== 0) {
    throw new Error('Replay ended with uncommitted State Effects')
  }
  const latest = raw.snapshots.at(-1)
  if (latest === undefined || latest.stateVersion !== version || latest.stateHash !== canonicalHash(state)) {
    throw new Error('Replay final State does not match the stored head')
  }
  if (desktopRestoredVersion !== undefined && desktopRestoredVersion !== version) {
    throw new Error(`Desktop restored v${desktopRestoredVersion}, replay produced v${version}`)
  }
  return {
    acceptedStateEffects,
    finalStateHash: latest.stateHash,
    finalStateVersion: version,
    journalRecords: raw.journal.length,
    rejectedEffects,
    status: 'pass',
    steps
  }
}
