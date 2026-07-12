import type { ActStarted, EventReceipt, ViewSnapshot } from '@nox/protocol'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  $noxView,
  hydrateNoxView,
  recordDelivery,
  recordPendingRequest,
  reduceInterfaceEvent
} from '../../apps/desktop/src/store/nox-view.js'

const now = '2026-07-12T10:00:00.000Z'
const hash = (character: string): string => `sha256:${character.repeat(64)}`

const receipt: EventReceipt = {
  clientEventId: 'desktop-e1',
  eventId: 'event-e1',
  interfaceOwnerId: 'nox-desktop-primary',
  journalSequence: 1,
  protocolVersion: 1,
  recordedAt: now,
  stateVersion: 0
}

const started: ActStarted = {
  actId: 'act-a1',
  cortexId: 'pi-primary',
  input: {
    blobHash: hash('1'),
    builderVersion: 1,
    stateHash: hash('2'),
    stateVersion: 0,
    triggerEventId: 'event-e1'
  },
  kind: 'started',
  modelId: 'model-1',
  protocolVersion: 1,
  startedAt: now
}

beforeEach(() => {
  $noxView.set({
    connected: false,
    connecting: true,
    continuations: [],
    items: [],
    journalCursor: 0,
    stateHash: '',
    stateVersion: 0
  })
})

describe('Desktop causal projection integration', () => {
  it('keeps the durable receipt ahead of admission and Act start', () => {
    const trace: string[] = []
    recordPendingRequest('desktop-e1', 'Consider this request.')
    trace.push($noxView.get().items[0]?.delivery ?? 'missing')
    recordDelivery(receipt)
    trace.push($noxView.get().items[0]?.delivery ?? 'missing')
    reduceInterfaceEvent({
      eventId: 'event-e1',
      interfaceEventId: 'interface-admitted',
      journalSequence: 2,
      kind: 'event.admitted',
      observedAt: now,
      protocolVersion: 1
    })
    trace.push($noxView.get().items[0]?.delivery ?? 'missing')
    reduceInterfaceEvent({
      act: started,
      interfaceEventId: 'interface-started',
      journalSequence: 3,
      kind: 'act.started',
      observedAt: now,
      protocolVersion: 1
    })
    trace.push($noxView.get().items[0]?.act?.actId ?? 'missing')

    expect(trace).toEqual(['recording', 'delivered', 'admitted', 'act-a1'])
  })

  it('restores the Event-to-Act-to-terminal relation from snapshot', () => {
    hydrateNoxView({
      actTerminals: [
        { actId: 'act-a1', completedAt: now, protocolVersion: 1, stateVersion: 0, status: 'completed-silent' }
      ],
      acts: [started],
      emissions: [],
      events: [
        {
          admission: 'admitted',
          clientEventId: 'desktop-e1',
          content: { content: 'Consider this request.', format: 'text', kind: 'message' },
          eventId: 'event-e1',
          interfaceOwnerId: 'nox-desktop-primary',
          kind: 'external',
          occurredAt: now,
          protocolVersion: 1,
          provenance: {
            clientEventId: 'desktop-e1',
            interfaceOwnerId: 'nox-desktop-primary',
            kind: 'external-interface'
          }
        }
      ],
      interfaceOwnerId: 'nox-desktop-primary',
      journalCursor: 4,
      openContinuations: [],
      protocolVersion: 1,
      state: {
        state: {} as never,
        stateHash: hash('3'),
        stateVersion: 0,
        throughSequence: 4
      },
      unresolvedReceipts: []
    } as ViewSnapshot)

    expect($noxView.get().items[0]).toMatchObject({
      act: { actId: 'act-a1' },
      eventId: 'event-e1',
      terminal: { status: 'completed-silent' }
    })
  })
})
