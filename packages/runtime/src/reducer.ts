import {
  canonicalHash,
  canonicalize,
  effectDecisionSchema,
  foundationStateSchema,
  instantSchema,
  pendingStateSnapshotSchema,
  statePathSchema,
  stateSnapshotSchema
} from '@nox/protocol'
import type { EffectDecision, FoundationState, JsonValue, PendingStateSnapshot, StateSnapshot } from '@nox/protocol'

export interface ReduceEffectsOptions {
  decisions: EffectDecision[]
  observedAt: string
  snapshot: StateSnapshot
}

export interface ReductionResult {
  acceptedStateChanges: number
  nextSnapshot?: PendingStateSnapshot
  state: FoundationState
  stateChanged: boolean
}

function decodePointer(path: string): string[] {
  return statePathSchema
    .parse(path)
    .split('/')
    .slice(1)
    .map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseArrayIndex(token: string, length: number, allowEnd: boolean): number {
  if (allowEnd && token === '-') {
    return length
  }
  if (!/^(0|[1-9]\d*)$/.test(token)) {
    throw new Error(`Invalid JSON array index: ${token}`)
  }
  const index = Number(token)
  const upperBound = allowEnd ? length : length - 1
  if (!Number.isSafeInteger(index) || index < 0 || index > upperBound) {
    throw new Error(`JSON array index is out of bounds: ${token}`)
  }
  return index
}

function applyNestedPatch(
  root: JsonValue,
  tokens: string[],
  operation: 'add' | 'remove' | 'replace',
  value?: JsonValue
): JsonValue {
  if (tokens.length === 0) {
    if (operation === 'remove' || value === undefined) {
      throw new Error('Foundation State roots cannot be removed or made undefined')
    }
    return canonicalize(value)
  }

  const clone = canonicalize(root)
  let cursor: JsonValue = clone
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      cursor = cursor[parseArrayIndex(token, cursor.length, false)] as JsonValue
    } else if (isJsonObject(cursor)) {
      if (!(token in cursor)) {
        throw new Error(`State patch parent does not exist: ${token}`)
      }
      cursor = cursor[token] as JsonValue
    } else {
      throw new Error('State patch cannot traverse a scalar value')
    }
  }

  const leaf = tokens.at(-1)
  if (leaf === undefined) {
    throw new Error('State patch has no leaf token')
  }
  if (Array.isArray(cursor)) {
    const index = parseArrayIndex(leaf, cursor.length, operation === 'add')
    if (operation === 'add') {
      if (value === undefined) {
        throw new Error('Add operation requires a value')
      }
      cursor.splice(index, 0, canonicalize(value))
    } else if (operation === 'remove') {
      cursor.splice(index, 1)
    } else {
      if (value === undefined) {
        throw new Error('Replace operation requires a value')
      }
      cursor[index] = canonicalize(value)
    }
  } else if (isJsonObject(cursor)) {
    const exists = Object.hasOwn(cursor, leaf)
    if (operation !== 'add' && !exists) {
      throw new Error(`State patch target does not exist: ${leaf}`)
    }
    if (operation === 'remove') {
      delete cursor[leaf]
    } else {
      if (value === undefined) {
        throw new Error(`${operation} operation requires a value`)
      }
      cursor[leaf] = canonicalize(value)
    }
  } else {
    throw new Error('State patch parent is a scalar value')
  }
  return clone
}

function requireStateRecord(value: JsonValue, root: string): Record<string, JsonValue> {
  if (!isJsonObject(value)) {
    throw new Error(`${root} must remain a JSON object`)
  }
  return value
}

function applyStatePatch(state: FoundationState, decision: EffectDecision): FoundationState {
  if (decision.effect.kind !== 'state.patch') {
    return state
  }
  const [root, ...tokens] = decodePointer(decision.effect.path)
  if (root !== 'picture' && root !== 'workingField') {
    throw new Error(`Unsupported State root: ${root ?? 'missing'}`)
  }
  const patched = applyNestedPatch(state[root], tokens, decision.effect.operation, decision.effect.value)
  return foundationStateSchema.parse({ ...state, [root]: requireStateRecord(patched, root) })
}

function applyContinuation(state: FoundationState, decision: EffectDecision): FoundationState {
  if (decision.effect.kind === 'continuation.schedule') {
    const continuationId = `continuation:${canonicalHash({
      actId: decision.actId,
      effectId: decision.effectId
    })}`
    if (state.openContinuations.some(item => item.continuationId === continuationId)) {
      throw new Error(`Continuation already exists: ${continuationId}`)
    }
    return foundationStateSchema.parse({
      ...state,
      openContinuations: [
        ...state.openContinuations,
        {
          continuationId,
          createdAt: decision.decidedAt,
          fireCount: 0,
          originActId: decision.actId,
          seed: decision.effect.seed,
          status: 'open'
        }
      ]
    })
  }
  if (decision.effect.kind === 'continuation.cancel' || decision.effect.kind === 'continuation.fire') {
    const targetContinuationId = decision.effect.continuationId
    const remaining = state.openContinuations.filter(({ continuationId }) => continuationId !== targetContinuationId)
    if (remaining.length === state.openContinuations.length) {
      throw new Error(`Continuation is not open: ${targetContinuationId}`)
    }
    return foundationStateSchema.parse({ ...state, openContinuations: remaining })
  }
  return state
}

export function reduceAcceptedEffects(options: ReduceEffectsOptions): ReductionResult {
  const snapshot = stateSnapshotSchema.parse(options.snapshot)
  const observedAt = instantSchema.parse(options.observedAt)
  const decisions = options.decisions
    .map(decision => effectDecisionSchema.parse(decision))
    .sort(
      (left, right) =>
        left.ordinal - right.ordinal || (left.effectId < right.effectId ? -1 : left.effectId > right.effectId ? 1 : 0)
    )
  if (new Set(decisions.map(({ effectId }) => effectId)).size !== decisions.length) {
    throw new Error('Effect decisions must have unique IDs')
  }
  if (new Set(decisions.map(({ ordinal }) => ordinal)).size !== decisions.length) {
    throw new Error('Effect decisions must have unique ordinals')
  }

  let state = snapshot.state
  let acceptedStateChanges = 0
  for (const decision of decisions) {
    if (decision.decision !== 'accepted' || !decision.stateChanging) {
      continue
    }
    state = applyStatePatch(state, decision)
    state = applyContinuation(state, decision)
    acceptedStateChanges += 1
  }
  if (acceptedStateChanges === 0) {
    return { acceptedStateChanges, state: snapshot.state, stateChanged: false }
  }

  state = foundationStateSchema.parse({
    ...state,
    temporalAnchor: {
      lastObservedAt: observedAt,
      logicalTick: state.temporalAnchor.logicalTick + 1
    }
  })
  const nextSnapshot = pendingStateSnapshotSchema.parse({
    state,
    stateHash: canonicalHash(state),
    stateVersion: snapshot.stateVersion + 1
  })
  return { acceptedStateChanges, nextSnapshot, state, stateChanged: true }
}
