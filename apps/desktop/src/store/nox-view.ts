import type {
  ActStarted,
  ActTerminal,
  Event,
  EventReceipt,
  InterfaceEmission,
  InterfaceEvent,
  OpenContinuation,
  ViewSnapshot
} from '@nox/protocol'
import { atom } from 'nanostores'

export type DeliveryState = 'admitted' | 'delivered' | 'failed' | 'recording'

export interface NoxTimelineItem {
  act?: ActStarted
  clientEventId?: string
  content: string
  delivery: DeliveryState
  emissions: InterfaceEmission[]
  eventId?: string
  kind: Event['kind'] | 'pending'
  occurredAt: string
  terminal?: ActTerminal
}

export interface NoxViewState {
  connected: boolean
  connecting: boolean
  continuations: OpenContinuation[]
  error?: string
  items: NoxTimelineItem[]
  journalCursor: number
  modelId: string
  runtimeUnhealthy: boolean
  stateHash: string
  stateVersion: number
}

const initialState: NoxViewState = {
  connected: false,
  connecting: true,
  continuations: [],
  items: [],
  journalCursor: 0,
  modelId: '',
  runtimeUnhealthy: false,
  stateHash: '',
  stateVersion: 0
}

export const $noxView = atom<NoxViewState>(initialState)

function eventContent(event: Event): string {
  if (event.kind === 'external') {
    return event.content.content
  }
  if (event.kind === 'continuation') {
    return event.content.label
  }
  return `Continuity restored · ${event.content.reason}`
}

function itemForEvent(event: Event): NoxTimelineItem {
  return {
    ...(event.kind === 'external' ? { clientEventId: event.clientEventId } : {}),
    content: eventContent(event),
    delivery: event.kind === 'external' && event.admission === 'recorded' ? 'delivered' : 'admitted',
    emissions: [],
    eventId: event.eventId,
    kind: event.kind,
    occurredAt: event.occurredAt
  }
}

function attachActs(items: NoxTimelineItem[], starts: ActStarted[], terminals: ActTerminal[]): NoxTimelineItem[] {
  const startByEvent = new Map(starts.map(act => [act.input.triggerEventId, act]))
  const terminalByAct = new Map(terminals.map(terminal => [terminal.actId, terminal]))
  return items.map(item => {
    if (item.eventId === undefined) {
      return item
    }
    const act = startByEvent.get(item.eventId)
    if (act === undefined) {
      return item
    }
    const terminal = terminalByAct.get(act.actId)
    return { ...item, act, ...(terminal === undefined ? {} : { terminal }) }
  })
}

function attachEmissions(items: NoxTimelineItem[], emissions: InterfaceEmission[]): NoxTimelineItem[] {
  const byAct = new Map<string, InterfaceEmission[]>()
  for (const emission of emissions) {
    const list = byAct.get(emission.actId) ?? []
    list.push(emission)
    byAct.set(emission.actId, list)
  }
  return items.map(item => ({ ...item, emissions: item.act === undefined ? [] : (byAct.get(item.act.actId) ?? []) }))
}

function applyReceipt(items: NoxTimelineItem[], receipt: EventReceipt): NoxTimelineItem[] {
  const index = items.findIndex(
    item => item.clientEventId === receipt.clientEventId || item.eventId === receipt.eventId
  )
  if (index < 0) {
    return items
  }
  return items.map((item, itemIndex) =>
    itemIndex === index ? { ...item, delivery: 'delivered', eventId: receipt.eventId } : item
  )
}

export function hydrateNoxView(view: ViewSnapshot): void {
  let items = attachActs(view.events.map(itemForEvent), view.acts, view.actTerminals)
  items = attachEmissions(items, view.emissions)
  for (const receipt of view.unresolvedReceipts) {
    items = applyReceipt(items, receipt)
  }
  $noxView.set({
    connected: true,
    connecting: false,
    continuations: view.openContinuations,
    items,
    journalCursor: view.journalCursor,
    modelId: view.state.state.cortex.modelId,
    runtimeUnhealthy: false,
    stateHash: view.state.stateHash,
    stateVersion: view.state.stateVersion
  })
}

export function recordPendingRequest(clientEventId: string, content: string): void {
  const state = $noxView.get()
  $noxView.set({
    ...state,
    items: [
      ...state.items,
      {
        clientEventId,
        content,
        delivery: 'recording',
        emissions: [],
        kind: 'pending',
        occurredAt: new Date().toISOString()
      }
    ]
  })
}

export function recordDelivery(receipt: EventReceipt): void {
  const state = $noxView.get()
  $noxView.set({
    ...state,
    items: applyReceipt(state.items, receipt),
    journalCursor: Math.max(state.journalCursor, receipt.journalSequence)
  })
}

export function recordRequestFailure(clientEventId: string, message: string): void {
  const state = $noxView.get()
  $noxView.set({
    ...state,
    error: message,
    items: state.items.map(item => (item.clientEventId === clientEventId ? { ...item, delivery: 'failed' } : item))
  })
}

export function reduceInterfaceEvent(event: InterfaceEvent): void {
  const state = $noxView.get()
  let items = state.items
  let continuations = state.continuations
  let stateHash = state.stateHash
  let stateVersion = state.stateVersion
  if (event.kind === 'event.receipt') {
    items = applyReceipt(items, event.receipt)
  }
  if (event.kind === 'event.admitted') {
    items = items.map(item => (item.eventId === event.eventId ? { ...item, delivery: 'admitted' } : item))
  }
  if (event.kind === 'act.started') {
    items = items.map(item => (item.eventId === event.act.input.triggerEventId ? { ...item, act: event.act } : item))
  }
  if (event.kind === 'act.terminal') {
    items = items.map(item => (item.act?.actId === event.act.actId ? { ...item, terminal: event.act } : item))
  }
  if (event.kind === 'emission.appended') {
    items = items.map(item =>
      item.act?.actId === event.emission.actId ? { ...item, emissions: [...item.emissions, event.emission] } : item
    )
  }
  if (event.kind === 'continuation.changed') {
    continuations =
      event.continuation.status === 'open'
        ? [
            ...continuations.filter(item => item.continuationId !== event.continuation.continuationId),
            event.continuation
          ]
        : continuations.filter(item => item.continuationId !== event.continuation.continuationId)
  }
  if (event.kind === 'state.advanced') {
    stateHash = event.stateHash
    stateVersion = event.stateVersion
  }
  $noxView.set({
    ...state,
    continuations,
    items,
    journalCursor: Math.max(state.journalCursor, event.journalSequence),
    stateHash,
    stateVersion
  })
}

export function setConnectionError(error: unknown): void {
  const state = $noxView.get()
  $noxView.set({
    ...state,
    connected: false,
    connecting: false,
    error: error instanceof Error ? error.message : String(error)
  })
}

export function setRuntimeUnhealthy(message: string): void {
  const state = $noxView.get()
  $noxView.set({
    ...state,
    connected: false,
    connecting: false,
    error: message,
    runtimeUnhealthy: true
  })
}

export function loadFixtureView(outcome = 'emitted'): void {
  const now = Date.now()
  $noxView.set({
    connected: true,
    connecting: false,
    continuations: [],
    items: [
      {
        clientEventId: 'fixture-request',
        content: 'Посмотри на то, что изменилось с прошлого раза. Если сочтёшь нужным — ответь.',
        delivery: 'admitted',
        emissions: [
          {
            actId: 'fixture-act',
            content:
              'Я вижу изменение в самой формулировке: это просьба, а не назначенная задача. Продолжу от этого различия.',
            effectId: 'fixture-effect',
            emissionId: 'fixture-emission',
            format: 'text',
            journalSequence: 44,
            occurredAt: new Date(now - 28_000).toISOString()
          }
        ],
        eventId: 'fixture-event',
        kind: 'external',
        occurredAt: new Date(now - 31_000).toISOString(),
        terminal: {
          actId: 'fixture-act',
          completedAt: new Date(now - 27_000).toISOString(),
          effectDecisionIds: ['fixture-decision'],
          protocolVersion: 1,
          stateVersion: 12,
          status: 'completed-effects'
        },
        act: {
          actId: 'fixture-act',
          cortexId: 'pi-primary',
          input: {
            blobHash: `sha256:${'1'.repeat(64)}`,
            builderVersion: 1,
            stateHash: `sha256:${'2'.repeat(64)}`,
            stateVersion: 11,
            triggerEventId: 'fixture-event'
          },
          kind: 'started',
          modelId: 'gpt-5.4-mini',
          protocolVersion: 1,
          startedAt: new Date(now - 30_000).toISOString()
        }
      }
    ],
    journalCursor: 47,
    modelId: 'gpt-5.4-mini',
    runtimeUnhealthy: false,
    stateHash: `sha256:${'a'.repeat(64)}`,
    stateVersion: 12
  })
  if (outcome === 'emitted' || outcome === 'restored') {
    return
  }
  const state = $noxView.get()
  const item = state.items[0]
  if (item === undefined) {
    return
  }
  if (outcome === 'delivered') {
    $noxView.set({
      ...state,
      items: [
        {
          ...(item.clientEventId === undefined ? {} : { clientEventId: item.clientEventId }),
          content: item.content,
          delivery: 'delivered',
          emissions: [],
          ...(item.eventId === undefined ? {} : { eventId: item.eventId }),
          kind: item.kind,
          occurredAt: item.occurredAt
        }
      ]
    })
    return
  }
  if (outcome === 'running') {
    const { terminal: _terminal, ...running } = item
    $noxView.set({ ...state, items: [{ ...running, emissions: [] }] })
    return
  }
  if (item.act === undefined) {
    return
  }
  if (outcome === 'silent') {
    $noxView.set({
      ...state,
      items: [
        {
          ...item,
          emissions: [],
          terminal: {
            actId: item.act.actId,
            completedAt: item.occurredAt,
            protocolVersion: 1,
            stateVersion: 12,
            status: 'completed-silent'
          }
        }
      ]
    })
  } else if (outcome === 'cancelled') {
    $noxView.set({
      ...state,
      items: [
        {
          ...item,
          emissions: [],
          terminal: {
            actId: item.act.actId,
            completedAt: item.occurredAt,
            protocolVersion: 1,
            reason: 'Cancelled from Nox Desktop',
            stateVersion: 11,
            status: 'cancelled'
          }
        }
      ]
    })
  } else if (outcome === 'failed') {
    $noxView.set({
      ...state,
      items: [
        {
          ...item,
          emissions: [],
          terminal: {
            actId: item.act.actId,
            code: 'provider-unavailable',
            completedAt: item.occurredAt,
            message: 'The Cortex provider did not complete this Act.',
            protocolVersion: 1,
            retryable: true,
            stateVersion: 11,
            status: 'failed'
          }
        }
      ]
    })
  }
}
