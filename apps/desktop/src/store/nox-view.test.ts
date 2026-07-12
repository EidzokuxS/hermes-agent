import type { ActStarted, EventReceipt, ViewSnapshot } from '@nox/protocol'
import { beforeEach, describe, expect, it } from 'vitest'

import { $noxView, hydrateNoxView, recordDelivery, recordPendingRequest, reduceInterfaceEvent } from './nox-view.js'

const hash = (value: string): string => `sha256:${value.repeat(64)}`
const now = '2026-07-12T10:00:00.000Z'

const started: ActStarted = {
  actId: 'act-1',
  cortexId: 'pi-primary',
  input: {
    blobHash: hash('1'),
    builderVersion: 1,
    stateHash: hash('2'),
    stateVersion: 3,
    triggerEventId: 'event-1'
  },
  kind: 'started',
  modelId: 'model-1',
  protocolVersion: 1,
  startedAt: now
}

const receipt: EventReceipt = {
  clientEventId: 'client-1',
  eventId: 'event-1',
  interfaceOwnerId: 'nox-desktop-primary',
  journalSequence: 4,
  protocolVersion: 1,
  recordedAt: now,
  stateVersion: 3
}

beforeEach(() => {
  $noxView.set({
    connected: false,
    connecting: true,
    continuations: [],
    items: [],
    journalCursor: 0,
    runtimeUnhealthy: false,
    stateHash: '',
    stateVersion: 0
  })
})

describe('Nox Desktop projection', () => {
  it('rebuilds a silent terminal and unresolved delivery from snapshot', () => {
    hydrateNoxView({
      actTerminals: [
        { actId: 'act-1', completedAt: now, protocolVersion: 1, stateVersion: 3, status: 'completed-silent' }
      ],
      acts: [started],
      emissions: [],
      events: [
        {
          admission: 'recorded',
          clientEventId: 'client-1',
          content: { content: 'A request', format: 'text', kind: 'message' },
          eventId: 'event-1',
          interfaceOwnerId: 'nox-desktop-primary',
          kind: 'external',
          occurredAt: now,
          protocolVersion: 1,
          provenance: { clientEventId: 'client-1', interfaceOwnerId: 'nox-desktop-primary', kind: 'external-interface' }
        }
      ],
      interfaceOwnerId: 'nox-desktop-primary',
      journalCursor: 9,
      openContinuations: [],
      protocolVersion: 1,
      state: {
        state: {
          cortex: {
            adapter: 'pi',
            configHash: hash('3'),
            cortexId: 'pi-primary',
            modelId: 'model-1',
            packageVersion: '0.80.6'
          },
          identity: { conceptDocument: 'NOX-CONVERGENCE.md', identityId: 'nox', revision: hash('4') },
          openContinuations: [],
          picture: {},
          schemaVersions: { journal: 1, protocol: 1, state: 1 },
          standingPolicies: [
            {
              adoptedAt: now,
              kind: 'attention.every-delivered-event',
              policyId: 'attention',
              provenance: { source: 'inherited', sourceDocument: 'NOX-CONVERGENCE.md' },
              status: 'active',
              version: 1
            }
          ],
          temporalAnchor: { lastObservedAt: now, logicalTick: 3 },
          workingField: {}
        },
        stateHash: hash('5'),
        stateVersion: 3,
        throughSequence: 9
      },
      unresolvedReceipts: [receipt]
    } as ViewSnapshot)

    expect($noxView.get().items[0]).toMatchObject({ delivery: 'delivered', terminal: { status: 'completed-silent' } })
  })

  it('projects receipt before admission and Act notifications', () => {
    recordPendingRequest('client-1', 'A request')
    recordDelivery(receipt)
    expect($noxView.get().items[0]?.delivery).toBe('delivered')
    reduceInterfaceEvent({
      eventId: 'event-1',
      interfaceEventId: 'i-1',
      journalSequence: 5,
      kind: 'event.admitted',
      observedAt: now,
      protocolVersion: 1
    })
    reduceInterfaceEvent({
      act: started,
      interfaceEventId: 'i-2',
      journalSequence: 6,
      kind: 'act.started',
      observedAt: now,
      protocolVersion: 1
    })
    expect($noxView.get().items[0]).toMatchObject({ act: { actId: 'act-1' }, delivery: 'admitted' })
  })
})
