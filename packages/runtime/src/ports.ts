/// <reference types="node" />

import type {
  ActProposalResult,
  CommitCommand,
  CommitReceipt,
  CortexInput,
  EventReceipt,
  ExternalEvent,
  JournalRecord,
  StateSnapshot
} from '@nox/protocol'

export interface CortexPort {
  runAct(input: CortexInput, signal: AbortSignal): Promise<ActProposalResult>
}

export interface ClockPort {
  now(): string
}

export interface JournalQuery {
  afterSequence?: number
  kinds?: string[]
  limit?: number
  order?: 'ascending' | 'descending'
}

export interface AuditBlobInput {
  bytes: Uint8Array
  createdAt: string
  mediaType: string
  provenance: JournalRecord['provenance']
}

export interface AuditBlobReceipt {
  contentHash: string
}

export interface EventReleaseState {
  admitted: boolean
  event: ExternalEvent
  hasAct: boolean
}

export interface StorePort {
  getEventReleaseState(eventId: string): Promise<EventReleaseState | undefined>
  getUnresolvedReceipts(interfaceOwnerId: string): Promise<EventReceipt[]>
  loadSnapshot(): Promise<StateSnapshot>
  putAuditBlob(input: AuditBlobInput): Promise<AuditBlobReceipt>
  readJournal(query?: JournalQuery): AsyncIterable<JournalRecord>
  recordExternalEvent(event: ExternalEvent): Promise<EventReceipt>
  transact(command: CommitCommand): Promise<CommitReceipt>
}
