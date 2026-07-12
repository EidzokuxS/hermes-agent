/// <reference types="node" />

import { actProposalResultSchema, canonicalStringify, effectDecisionSchema, PROTOCOL_VERSION } from '@nox/protocol'
import type {
  ActProposalResult,
  ActTerminal,
  EffectDecision,
  Event,
  JournalRecord,
  JournalRecordInput,
  StateSnapshot
} from '@nox/protocol'

import { buildCortexInput } from './input-builder.js'
import type { ClockPort, CortexPort, StorePort } from './ports.js'
import { reduceAcceptedEffects } from './reducer.js'

export interface ActiveActControl {
  actId: string
  cancelReason?: string
  cancelRequested: boolean
  controller: AbortController
  eventId: string
  settled: boolean
}

export interface ActRunnerOptions {
  clock: ClockPort
  cortex: CortexPort
  idFactory: () => string
  serialize: <T>(operation: () => Promise<T>) => Promise<T>
  store: StorePort
}

function utf8(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'utf8'))
}

function causalSequences(records: JournalRecord[], eventId: string): number[] {
  return records
    .filter(record => record.causal.eventId === eventId)
    .map(({ sequence }) => sequence)
    .slice(-32)
}

function runtimeRecord(
  entry: JournalRecordInput['entry'],
  recordedAt: string,
  eventId: string,
  causeSequences: number[],
  actId?: string
): JournalRecordInput {
  return {
    causal: { ...(actId === undefined ? {} : { actId }), causeSequences, eventId },
    entry,
    journalSchemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    provenance: { component: 'act-runner', kind: 'runtime' },
    recordedAt
  }
}

function rejectedDecision(accepted: Extract<EffectDecision, { decision: 'accepted' }>, error: unknown): EffectDecision {
  const message = error instanceof Error ? error.message : String(error)
  return effectDecisionSchema.parse({
    actId: accepted.actId,
    code: message.startsWith('Continuation is not open') ? 'continuation-not-found' : 'invalid-transition',
    decidedAt: accepted.decidedAt,
    decision: 'rejected',
    effect: accepted.effect,
    effectId: accepted.effectId,
    message,
    ordinal: accepted.ordinal,
    provenance: accepted.provenance,
    stateChanging: false
  })
}

function decideEffects(
  result: Extract<ActProposalResult, { kind: 'proposed' }>,
  snapshot: StateSnapshot,
  actId: string,
  decidedAt: string,
  idFactory: () => string
): EffectDecision[] {
  const decisions: EffectDecision[] = []
  let simulated = snapshot
  for (const [ordinal, effect] of result.proposal.effects.entries()) {
    const effectId = idFactory()
    const provenance = {
      actId,
      cortexId: snapshot.state.cortex.cortexId,
      kind: 'cortex' as const,
      modelId: snapshot.state.cortex.modelId
    }
    const accepted = effectDecisionSchema.parse({
      actId,
      decidedAt,
      decision: 'accepted',
      effect,
      effectId,
      ordinal,
      provenance,
      stateChanging: effect.kind !== 'emission.append'
    })
    if (accepted.decision !== 'accepted') {
      throw new Error('Internal accepted Effect construction failed')
    }
    if (effect.kind === 'continuation.schedule' && simulated.state.openContinuations.length >= 128) {
      decisions.push(
        effectDecisionSchema.parse({
          ...accepted,
          code: 'policy-denied',
          decision: 'rejected',
          message: 'Foundation Continuation bound is 128',
          stateChanging: false
        })
      )
      continue
    }
    try {
      const reduction = reduceAcceptedEffects({ decisions: [accepted], observedAt: decidedAt, snapshot: simulated })
      if (reduction.nextSnapshot !== undefined) {
        simulated = { ...reduction.nextSnapshot, throughSequence: simulated.throughSequence }
      }
      decisions.push(accepted)
    } catch (error) {
      decisions.push(rejectedDecision(accepted, error))
    }
  }
  return decisions
}

function terminalForNonProposal(
  actId: string,
  result: Exclude<ActProposalResult, { kind: 'proposed' }>,
  completedAt: string,
  stateVersion: number,
  cancelled: boolean,
  cancelReason?: string
): ActTerminal {
  if (cancelled) {
    return {
      actId,
      completedAt,
      protocolVersion: PROTOCOL_VERSION,
      reason: cancelReason ?? 'Act cancelled',
      stateVersion,
      status: 'cancelled'
    }
  }
  if (result.kind === 'provider-error') {
    return {
      actId,
      code: result.code,
      completedAt,
      message: result.message,
      protocolVersion: PROTOCOL_VERSION,
      retryable: result.retryable,
      stateVersion,
      status: 'failed'
    }
  }
  if (result.kind === 'aborted') {
    return {
      actId,
      code: 'cortex-aborted',
      completedAt,
      message: result.reason,
      protocolVersion: PROTOCOL_VERSION,
      retryable: false,
      stateVersion,
      status: 'failed'
    }
  }
  const code = result.kind === 'duplicate-proposal' ? 'duplicate-proposal' : result.kind
  return {
    actId,
    code,
    completedAt,
    message: `Cortex proposal outcome: ${result.kind}`,
    protocolVersion: PROTOCOL_VERSION,
    stateVersion,
    status: 'rejected'
  }
}

export class ActRunner {
  readonly #options: ActRunnerOptions

  constructor(options: ActRunnerOptions) {
    this.#options = options
  }

  async run(event: Event, control: ActiveActControl): Promise<ActTerminal> {
    const prepared = await this.#prepare(event, control)
    let result: ActProposalResult
    try {
      result = actProposalResultSchema.parse(
        await this.#options.cortex.runAct(prepared.input, control.controller.signal)
      )
    } catch (error) {
      result = {
        code: 'cortex-port-error',
        kind: 'provider-error',
        message: error instanceof Error ? error.message : String(error),
        retryable: false
      }
    }
    return this.#finalize(event, control, prepared.causes, result)
  }

  async #prepare(event: Event, control: ActiveActControl) {
    return this.#options.serialize(async () => {
      const snapshot = await this.#options.store.loadSnapshot()
      const journal: JournalRecord[] = []
      for await (const record of this.#options.store.readJournal({ limit: 64 })) {
        journal.push(record)
      }
      const observedAt = this.#options.clock.now()
      const built = buildCortexInput({
        actId: control.actId,
        bounds: {
          allowedEffectKinds: ['continuation.cancel', 'continuation.schedule', 'emission.append', 'state.patch'],
          allowedStateRoots: ['/picture', '/workingField'],
          maxEffects: 16,
          maxJournalRecords: 64,
          maxOutputTokens: 4096,
          timeoutMilliseconds: 120_000
        },
        journal,
        observedAt,
        state: snapshot,
        triggerEvent: event
      })
      const inputBlob = await this.#options.store.putAuditBlob({
        bytes: utf8(built.serialized),
        createdAt: observedAt,
        mediaType: 'application/vnd.nox.cortex-input+json',
        provenance: { component: 'input-builder', kind: 'runtime' }
      })
      if (inputBlob.contentHash !== built.inputHash) {
        throw new Error('Persisted CortexInput hash does not match the canonical input')
      }
      const causes = causalSequences(journal, event.eventId)
      await this.#options.store.transact({
        commandId: `act-start:${control.actId}`,
        expectedStateVersion: snapshot.stateVersion,
        protocolVersion: PROTOCOL_VERSION,
        records: [
          runtimeRecord(
            {
              actId: control.actId,
              blobHash: built.inputHash,
              builderVersion: built.input.builderVersion,
              kind: 'cortex.input-recorded'
            },
            observedAt,
            event.eventId,
            causes,
            control.actId
          ),
          runtimeRecord(
            {
              act: {
                actId: control.actId,
                cortexId: snapshot.state.cortex.cortexId,
                input: {
                  blobHash: built.inputHash,
                  builderVersion: built.input.builderVersion,
                  stateHash: snapshot.stateHash,
                  stateVersion: snapshot.stateVersion,
                  triggerEventId: event.eventId
                },
                kind: 'started',
                modelId: snapshot.state.cortex.modelId,
                protocolVersion: PROTOCOL_VERSION,
                startedAt: observedAt
              },
              kind: 'act.started'
            },
            observedAt,
            event.eventId,
            causes,
            control.actId
          )
        ]
      })
      return { causes, input: built.input }
    })
  }

  async #finalize(
    event: Event,
    control: ActiveActControl,
    causes: number[],
    result: ActProposalResult
  ): Promise<ActTerminal> {
    return this.#options.serialize(async () => {
      const completedAt = this.#options.clock.now()
      const current = await this.#options.store.loadSnapshot()
      const resultBlob = await this.#options.store.putAuditBlob({
        bytes: utf8(canonicalStringify(result)),
        createdAt: completedAt,
        mediaType: 'application/vnd.nox.act-proposal-result+json',
        provenance: {
          actId: control.actId,
          cortexId: current.state.cortex.cortexId,
          kind: 'cortex',
          modelId: current.state.cortex.modelId
        }
      })
      const records: JournalRecordInput[] = [
        runtimeRecord(
          {
            actId: control.actId,
            kind: 'act.proposal-observed',
            result,
            resultBlobHash: resultBlob.contentHash
          },
          completedAt,
          event.eventId,
          causes,
          control.actId
        )
      ]

      if (control.cancelRequested) {
        records.push(
          runtimeRecord(
            {
              actId: control.actId,
              kind: 'act.late-output-diagnostic',
              outputHash: resultBlob.contentHash
            },
            completedAt,
            event.eventId,
            causes,
            control.actId
          )
        )
        const terminal = terminalForNonProposal(
          control.actId,
          result.kind === 'proposed' ? { kind: 'aborted', reason: control.cancelReason ?? 'Act cancelled' } : result,
          completedAt,
          current.stateVersion,
          true,
          control.cancelReason
        )
        return this.#commitTerminal(control, event, current, records, terminal)
      }

      if (result.kind !== 'proposed') {
        const terminal = terminalForNonProposal(control.actId, result, completedAt, current.stateVersion, false)
        return this.#commitTerminal(control, event, current, records, terminal)
      }
      if (result.proposal.settlement === 'silent') {
        const terminal: ActTerminal = {
          actId: control.actId,
          completedAt,
          protocolVersion: PROTOCOL_VERSION,
          stateVersion: current.stateVersion,
          status: 'completed-silent'
        }
        return this.#commitTerminal(control, event, current, records, terminal)
      }

      const decisions = decideEffects(result, current, control.actId, completedAt, this.#options.idFactory)
      const reduction = reduceAcceptedEffects({ decisions, observedAt: completedAt, snapshot: current })
      for (const decision of decisions) {
        records.push(
          runtimeRecord({ decision, kind: 'effect.decision' }, completedAt, event.eventId, causes, control.actId)
        )
      }
      if (reduction.nextSnapshot !== undefined) {
        records.push(
          runtimeRecord(
            {
              kind: 'state.advanced',
              stateHash: reduction.nextSnapshot.stateHash,
              stateVersion: reduction.nextSnapshot.stateVersion
            },
            completedAt,
            event.eventId,
            causes,
            control.actId
          )
        )
      }
      const terminal: ActTerminal = {
        actId: control.actId,
        completedAt,
        effectDecisionIds: decisions.map(({ effectId }) => effectId),
        protocolVersion: PROTOCOL_VERSION,
        stateVersion: reduction.nextSnapshot?.stateVersion ?? current.stateVersion,
        status: 'completed-effects'
      }
      records.push(runtimeRecord({ kind: 'act.terminal', terminal }, completedAt, event.eventId, causes, control.actId))
      await this.#options.store.transact({
        commandId: `act-terminal:${control.actId}`,
        expectedStateVersion: current.stateVersion,
        ...(reduction.nextSnapshot === undefined ? {} : { nextSnapshot: reduction.nextSnapshot }),
        protocolVersion: PROTOCOL_VERSION,
        records
      })
      control.settled = true
      return terminal
    })
  }

  async #commitTerminal(
    control: ActiveActControl,
    event: Event,
    snapshot: StateSnapshot,
    records: JournalRecordInput[],
    terminal: ActTerminal
  ): Promise<ActTerminal> {
    records.push(
      runtimeRecord({ kind: 'act.terminal', terminal }, terminal.completedAt, event.eventId, [], control.actId)
    )
    await this.#options.store.transact({
      commandId: `act-terminal:${control.actId}`,
      expectedStateVersion: snapshot.stateVersion,
      protocolVersion: PROTOCOL_VERSION,
      records
    })
    control.settled = true
    return terminal
  }
}
