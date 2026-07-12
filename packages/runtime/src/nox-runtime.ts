/// <reference types="node" />

import { canonicalHash, eventSchema, PROTOCOL_VERSION } from '@nox/protocol'
import type { ActTerminal, Event, EventReceipt, JournalRecord, JournalRecordInput, StateSnapshot } from '@nox/protocol'

import { ActRunner } from './act-runner.js'
import type { ActiveActControl } from './act-runner.js'
import { ContinuationScheduler } from './continuation-scheduler.js'
import type { ClockPort, CortexPort, StorePort } from './ports.js'
import { analyzeRecovery } from './recovery.js'

export interface AppendEventInput {
  clientEventId: string
  content: string
  format: 'markdown' | 'text'
  interfaceOwnerId: string
}

export interface NoxRuntimeOptions {
  clock: ClockPort
  cortex: CortexPort
  idFactory: () => string
  store: StorePort
}

function runtimeRecord(
  entry: JournalRecordInput['entry'],
  recordedAt: string,
  eventId: string,
  actId?: string
): JournalRecordInput {
  return {
    causal: { ...(actId === undefined ? {} : { actId }), causeSequences: [], eventId },
    entry,
    journalSchemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    provenance: { component: 'nox-runtime', kind: 'runtime' },
    recordedAt
  }
}

export class NoxRuntime {
  readonly #activeActs = new Map<string, ActiveActControl>()
  readonly #actRunner: ActRunner
  readonly #clock: ClockPort
  readonly #idFactory: () => string
  readonly #queuedEvents = new Set<string>()
  readonly #scheduler: ContinuationScheduler
  readonly #store: StorePort
  #commitTail: Promise<void> = Promise.resolve()
  #workError: unknown
  #workTail: Promise<void> = Promise.resolve()

  constructor(options: NoxRuntimeOptions) {
    this.#clock = options.clock
    this.#idFactory = options.idFactory
    this.#store = options.store
    this.#actRunner = new ActRunner({
      clock: options.clock,
      cortex: options.cortex,
      idFactory: options.idFactory,
      serialize: operation => this.serialize(operation),
      store: options.store
    })
    this.#scheduler = new ContinuationScheduler({
      clock: options.clock,
      onEvent: event => this.#enqueue(event),
      serialize: operation => this.serialize(operation),
      store: options.store
    })
  }

  async appendEvent(input: AppendEventInput): Promise<EventReceipt> {
    const event = eventSchema.parse({
      admission: 'recorded',
      clientEventId: input.clientEventId,
      content: { content: input.content, format: input.format, kind: 'message' },
      eventId: `event:${canonicalHash({
        clientEventId: input.clientEventId,
        interfaceOwnerId: input.interfaceOwnerId
      })}`,
      interfaceOwnerId: input.interfaceOwnerId,
      kind: 'external',
      occurredAt: this.#clock.now(),
      protocolVersion: PROTOCOL_VERSION,
      provenance: {
        clientEventId: input.clientEventId,
        interfaceOwnerId: input.interfaceOwnerId,
        kind: 'external-interface'
      }
    })
    if (event.kind !== 'external') {
      throw new Error('External Event construction failed')
    }
    return this.serialize(() => this.#store.recordExternalEvent(event))
  }

  async releaseEvent(eventId: string): Promise<void> {
    const event = await this.serialize(async () => {
      const release = await this.#store.getEventReleaseState(eventId)
      if (release === undefined) {
        throw new Error(`Cannot release unknown Event: ${eventId}`)
      }
      if (!release.admitted) {
        const snapshot = await this.#store.loadSnapshot()
        await this.#store.transact({
          commandId: `event-admit:${eventId}`,
          expectedStateVersion: snapshot.stateVersion,
          protocolVersion: PROTOCOL_VERSION,
          records: [runtimeRecord({ eventId, kind: 'event.admitted' }, this.#clock.now(), eventId)]
        })
      }
      if (release.hasAct) {
        return undefined
      }
      return { ...release.event, admission: 'admitted' as const }
    })
    if (event !== undefined) {
      this.#enqueue(event)
    }
  }

  async cancelAct(actId: string, reason: string): Promise<boolean> {
    const control = this.#activeActs.get(actId)
    if (control === undefined) {
      return false
    }
    return this.serialize(async () => {
      if (control.settled || control.cancelRequested) {
        return false
      }
      const snapshot = await this.#store.loadSnapshot()
      await this.#store.transact({
        commandId: `act-cancel:${actId}`,
        expectedStateVersion: snapshot.stateVersion,
        protocolVersion: PROTOCOL_VERSION,
        records: [
          runtimeRecord({ actId, kind: 'act.cancel-requested', reason }, this.#clock.now(), control.eventId, actId)
        ]
      })
      control.cancelReason = reason
      control.cancelRequested = true
      control.controller.abort(reason)
      return true
    })
  }

  async recover(): Promise<void> {
    const events = await this.serialize(async () => {
      const analysis = analyzeRecovery(await this.#readAllJournal())
      for (const running of analysis.runningActs) {
        const snapshot = await this.#store.loadSnapshot()
        const completedAt = this.#clock.now()
        const terminal: ActTerminal = {
          actId: running.act.actId,
          completedAt,
          protocolVersion: PROTOCOL_VERSION,
          reason: 'Runtime process ended before terminal settlement',
          stateVersion: snapshot.stateVersion,
          status: 'interrupted'
        }
        await this.#store.transact({
          commandId: `act-recovery-interrupt:${running.act.actId}`,
          expectedStateVersion: snapshot.stateVersion,
          protocolVersion: PROTOCOL_VERSION,
          records: [runtimeRecord({ kind: 'act.terminal', terminal }, completedAt, running.eventId, running.act.actId)]
        })
      }
      return analysis.admittedEventsWithoutAct
    })
    for (const event of events) {
      this.#enqueue(event)
    }
  }

  async fireDueContinuations(): Promise<Event[]> {
    return this.#scheduler.fireDue()
  }

  async unresolvedReceipts(interfaceOwnerId: string): Promise<EventReceipt[]> {
    return this.serialize(() => this.#store.getUnresolvedReceipts(interfaceOwnerId))
  }

  async recordOperationalFailure(code: 'continuation-loop', message: string): Promise<void> {
    const recordedAt = this.#clock.now()
    const boundedMessage = message.slice(0, 1024) || 'Unknown continuation loop failure'
    await this.serialize(async () => {
      const snapshot = await this.#store.loadSnapshot()
      await this.#store.transact({
        commandId: `operational-failure:${canonicalHash({ code, message: boundedMessage, recordedAt })}`,
        expectedStateVersion: snapshot.stateVersion,
        protocolVersion: PROTOCOL_VERSION,
        records: [
          {
            causal: { causeSequences: [] },
            entry: { code, kind: 'runtime.operational-failure', message: boundedMessage },
            journalSchemaVersion: 1,
            protocolVersion: PROTOCOL_VERSION,
            provenance: { component: 'nox-runtime', kind: 'runtime' },
            recordedAt
          }
        ]
      })
    })
  }

  async journal(afterSequence = 0): Promise<JournalRecord[]> {
    return this.serialize(() => this.#readAllJournal(afterSequence))
  }

  async journalTail(limit = 4_096): Promise<JournalRecord[]> {
    return this.serialize(async () => {
      const records: JournalRecord[] = []
      for await (const record of this.#store.readJournal({ limit, order: 'descending' })) {
        records.push(record)
      }
      return records.reverse()
    })
  }

  async snapshot(): Promise<StateSnapshot> {
    return this.serialize(() => this.#store.loadSnapshot())
  }

  async waitForIdle(): Promise<void> {
    await this.#workTail
    await this.#commitTail
    if (this.#workError !== undefined) {
      const error = this.#workError
      this.#workError = undefined
      throw error
    }
  }

  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#commitTail.then(operation, operation)
    this.#commitTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  #enqueue(event: Event): void {
    if (this.#queuedEvents.has(event.eventId)) {
      return
    }
    this.#queuedEvents.add(event.eventId)
    const run = this.#workTail.then(async () => {
      const control: ActiveActControl = {
        actId: this.#idFactory(),
        cancelRequested: false,
        controller: new AbortController(),
        eventId: event.eventId,
        settled: false
      }
      this.#activeActs.set(control.actId, control)
      try {
        await this.#actRunner.run(event, control)
      } finally {
        this.#activeActs.delete(control.actId)
        this.#queuedEvents.delete(event.eventId)
      }
    })
    this.#workTail = run.catch((error: unknown) => {
      this.#workError = error
      this.#queuedEvents.delete(event.eventId)
    })
  }

  async #readAllJournal(afterSequence = 0): Promise<JournalRecord[]> {
    const records: JournalRecord[] = []
    let cursor = afterSequence
    while (true) {
      const page: JournalRecord[] = []
      for await (const record of this.#store.readJournal({ afterSequence: cursor, limit: 10_000 })) {
        page.push(record)
      }
      records.push(...page)
      if (page.length < 10_000) {
        return records
      }
      const last = page.at(-1)
      if (last === undefined || last.sequence <= cursor) {
        throw new Error('Journal pagination did not advance')
      }
      cursor = last.sequence
    }
  }
}
