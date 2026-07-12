import { canonicalHash } from '@nox/protocol'
import type { FoundationState, InterfaceEvent, ViewSnapshot } from '@nox/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { NoxDesktopBridge } from '../transport/nox-client.js'

import { NoxShell } from './nox-shell.js'

const now = '2026-07-12T10:00:00.000Z'

function emptySnapshot(): ViewSnapshot {
  const state: FoundationState = {
    cortex: {
      adapter: 'pi',
      configHash: canonicalHash({ config: 'test' }),
      cortexId: 'pi-primary',
      modelId: 'model-1',
      packageVersion: '0.80.6'
    },
    identity: { conceptDocument: 'NOX-CONVERGENCE.md', identityId: 'nox', revision: canonicalHash('concept') },
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
    temporalAnchor: { lastObservedAt: now, logicalTick: 0 },
    workingField: {}
  }
  return {
    actTerminals: [],
    acts: [],
    emissions: [],
    events: [],
    interfaceOwnerId: 'nox-desktop-primary',
    journalCursor: 0,
    openContinuations: [],
    protocolVersion: 1,
    state: { state, stateHash: canonicalHash(state), stateVersion: 0, throughSequence: 0 },
    unresolvedReceipts: []
  }
}

afterEach(() => {
  cleanup()
  delete window.nox
})

describe('Nox shell vertical', () => {
  it('shows durable delivery before the running and silent projections', async () => {
    let health: ((event: unknown) => void) | undefined
    let notify: ((event: InterfaceEvent) => void) | undefined
    const bridge: NoxDesktopBridge = {
      appendEvent: async request => ({
        protocolVersion: 1,
        receipt: {
          clientEventId: request.clientEventId,
          eventId: 'event-1',
          interfaceOwnerId: 'nox-desktop-primary',
          journalSequence: 1,
          protocolVersion: 1,
          recordedAt: now,
          stateVersion: 0
        }
      }),
      cancelAct: async request => ({ actId: request.actId, protocolVersion: 1, requested: true }),
      runtimeHealth: async () => undefined,
      snapshot: async () => emptySnapshot(),
      subscribeHealth: listener => {
        health = listener
        return () => undefined
      },
      subscribe: listener => {
        notify = listener
        return () => undefined
      }
    }
    window.nox = bridge
    render(<NoxShell />)
    await screen.findByText('runtime present')
    fireEvent.change(screen.getByLabelText('Offer Nox a request'), { target: { value: 'Consider this request.' } })
    fireEvent.click(screen.getByRole('button', { name: /Deliver/ }))
    await waitFor(() => expect(screen.getAllByText('delivered').length).toBeGreaterThan(1))

    notify?.({
      eventId: 'event-1',
      interfaceEventId: 'interface-admitted',
      journalSequence: 2,
      kind: 'event.admitted',
      observedAt: now,
      protocolVersion: 1
    })
    notify?.({
      act: {
        actId: 'act-1',
        cortexId: 'pi-primary',
        input: {
          blobHash: canonicalHash('input'),
          builderVersion: 1,
          stateHash: emptySnapshot().state.stateHash,
          stateVersion: 0,
          triggerEventId: 'event-1'
        },
        kind: 'started',
        modelId: 'model-1',
        protocolVersion: 1,
        startedAt: now
      },
      interfaceEventId: 'interface-started',
      journalSequence: 3,
      kind: 'act.started',
      observedAt: now,
      protocolVersion: 1
    })
    await screen.findByText('thinking')
    notify?.({
      act: { actId: 'act-1', completedAt: now, protocolVersion: 1, stateVersion: 0, status: 'completed-silent' },
      interfaceEventId: 'interface-terminal',
      journalSequence: 4,
      kind: 'act.terminal',
      observedAt: now,
      protocolVersion: 1
    })
    await waitFor(() => expect(screen.getByText('Act settled without an emission.')).toBeTruthy())
    health?.({ message: 'Continuation loop failed', status: 'unhealthy' })
    await screen.findByText('runtime unhealthy')
    expect(screen.getByRole('alert').textContent).toContain('Continuation loop failed')
  })

  it('preserves unhealthy state reported before snapshot hydration', async () => {
    let health: ((event: unknown) => void) | undefined
    let resolveSnapshot: ((snapshot: ViewSnapshot) => void) | undefined
    const snapshot = new Promise<ViewSnapshot>(resolve => {
      resolveSnapshot = resolve
    })
    window.nox = {
      appendEvent: async () => undefined,
      cancelAct: async request => ({ actId: request.actId, protocolVersion: 1, requested: true }),
      runtimeHealth: async () => undefined,
      snapshot: () => snapshot,
      subscribe: () => () => undefined,
      subscribeHealth: listener => {
        health = listener
        return () => undefined
      }
    }

    render(<NoxShell />)
    health?.({ message: 'Runtime exited before hydration', status: 'unhealthy' })
    resolveSnapshot?.(emptySnapshot())

    await screen.findByText('runtime unhealthy')
    expect(screen.getByRole('alert').textContent).toContain('Runtime exited before hydration')
  })

  it('loads persistent unhealthy state when a new window connects', async () => {
    window.nox = {
      appendEvent: async () => undefined,
      cancelAct: async request => ({ actId: request.actId, protocolVersion: 1, requested: true }),
      runtimeHealth: async () => ({ message: 'Runtime exited while windowless', status: 'unhealthy' }),
      snapshot: async () => emptySnapshot(),
      subscribe: () => () => undefined,
      subscribeHealth: () => () => undefined
    }

    render(<NoxShell />)

    await screen.findByText('runtime unhealthy')
    expect(screen.getByRole('alert').textContent).toContain('Runtime exited while windowless')
  })
})
