import { canonicalHash, effectDecisionSchema, eventSchema, PROTOCOL_VERSION } from '@nox/protocol'
import type { EffectDecision, Event, JournalRecordInput } from '@nox/protocol'

import type { ClockPort, StorePort } from './ports.js'
import { reduceAcceptedEffects } from './reducer.js'

export interface ContinuationSchedulerOptions {
  clock: ClockPort
  onEvent: (event: Event) => void
  serialize: <T>(operation: () => Promise<T>) => Promise<T>
  store: StorePort
}

function runtimeRecord(entry: JournalRecordInput['entry'], recordedAt: string, eventId: string): JournalRecordInput {
  return {
    causal: { causeSequences: [], eventId },
    entry,
    journalSchemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    provenance: { component: 'continuation-scheduler', kind: 'runtime' },
    recordedAt
  }
}

export class ContinuationScheduler {
  readonly #options: ContinuationSchedulerOptions

  constructor(options: ContinuationSchedulerOptions) {
    this.#options = options
  }

  async fireDue(): Promise<Event[]> {
    const fired: Event[] = []
    while (true) {
      const event = await this.#options.serialize(async () => {
        const snapshot = await this.#options.store.loadSnapshot()
        const now = this.#options.clock.now()
        const continuation = [...snapshot.state.openContinuations]
          .filter(({ seed }) => seed.due.at <= now)
          .sort((left, right) =>
            left.seed.due.at < right.seed.due.at
              ? -1
              : left.seed.due.at > right.seed.due.at
                ? 1
                : left.continuationId < right.continuationId
                  ? -1
                  : 1
          )[0]
        if (continuation === undefined) {
          return undefined
        }

        const eventId = `event:${canonicalHash({
          continuationId: continuation.continuationId,
          fireCount: 1
        })}`
        const actId = `runtime:${canonicalHash({
          continuationId: continuation.continuationId,
          operation: 'fire'
        })}`
        const decision: EffectDecision = effectDecisionSchema.parse({
          actId,
          decidedAt: now,
          decision: 'accepted',
          effect: {
            continuationId: continuation.continuationId,
            firedAt: now,
            kind: 'continuation.fire',
            protocolVersion: PROTOCOL_VERSION
          },
          effectId: `effect:${canonicalHash({ continuationId: continuation.continuationId, fireCount: 1 })}`,
          ordinal: 0,
          provenance: { component: 'continuation-scheduler', kind: 'runtime' },
          stateChanging: true
        })
        const reduction = reduceAcceptedEffects({ decisions: [decision], observedAt: now, snapshot })
        if (reduction.nextSnapshot === undefined) {
          throw new Error('Continuation fire did not advance State')
        }
        const continuationEvent = eventSchema.parse({
          admission: 'admitted',
          content: {
            ...(continuation.seed.context === undefined ? {} : { context: continuation.seed.context }),
            instruction: continuation.seed.instruction,
            kind: 'continuation-fired',
            label: continuation.seed.label
          },
          continuationId: continuation.continuationId,
          eventId,
          kind: 'continuation',
          occurredAt: now,
          protocolVersion: PROTOCOL_VERSION,
          provenance: {
            continuationId: continuation.continuationId,
            kind: 'continuation',
            scheduledByActId: continuation.originActId
          }
        })
        await this.#options.store.transact({
          commandId: `fire:${continuation.continuationId}`,
          expectedStateVersion: snapshot.stateVersion,
          nextSnapshot: reduction.nextSnapshot,
          protocolVersion: PROTOCOL_VERSION,
          records: [
            runtimeRecord({ event: continuationEvent, kind: 'event.recorded' }, now, eventId),
            runtimeRecord({ decision, kind: 'effect.decision' }, now, eventId),
            runtimeRecord(
              {
                kind: 'state.advanced',
                stateHash: reduction.nextSnapshot.stateHash,
                stateVersion: reduction.nextSnapshot.stateVersion
              },
              now,
              eventId
            )
          ]
        })
        return continuationEvent
      })
      if (event === undefined) {
        break
      }
      fired.push(event)
      this.#options.onEvent(event)
    }
    return fired
  }
}
