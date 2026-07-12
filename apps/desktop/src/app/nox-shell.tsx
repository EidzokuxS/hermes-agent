import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { ContinuationList } from '../components/nox/continuation-list.js'
import { StateVersion } from '../components/nox/state-version.js'
import {
  $noxView,
  hydrateNoxView,
  loadFixtureView,
  recordDelivery,
  recordPendingRequest,
  recordRequestFailure,
  reduceInterfaceEvent,
  setConnectionError,
  setRuntimeUnhealthy
} from '../store/nox-view.js'
import { appendNoxRequest, cancelNoxAct, connectNox } from '../transport/nox-client.js'

import { NoxComposer } from './nox-composer.js'
import { NoxTimeline } from './nox-timeline.js'

export function NoxShell() {
  const view = useStore($noxView)
  const runtimeLabel = view.connecting
    ? 'Connecting…'
    : view.connected
      ? 'Online'
      : view.runtimeUnhealthy
        ? 'Needs attention'
        : 'Offline'
  useEffect(() => {
    if (window.nox === undefined) {
      loadFixtureView(new URLSearchParams(window.location.search).get('fixture') ?? 'emitted')
      return
    }
    let stop: (() => void) | undefined
    void connectNox(hydrateNoxView, reduceInterfaceEvent, event => setRuntimeUnhealthy(event.message))
      .then(unsubscribe => (stop = unsubscribe))
      .catch(setConnectionError)
    return () => stop?.()
  }, [])

  const submit = async (content: string): Promise<void> => {
    const clientEventId = crypto.randomUUID()
    recordPendingRequest(clientEventId, content)
    try {
      const result = await appendNoxRequest(clientEventId, content)
      recordDelivery(result.receipt)
    } catch (error) {
      recordRequestFailure(clientEventId, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  return (
    <div className="nox-shell">
      <header className="topbar">
        <div className="identity-lockup">
          <span aria-hidden="true" className="identity-mark">
            N
          </span>
          <div>
            <h1>Nox</h1>
            <p>Local agent</p>
          </div>
        </div>
        <div className={`runtime-presence${view.connected ? ' runtime-presence--live' : ''}`}>
          <span className={view.connected ? 'presence-dot presence-dot--live' : 'presence-dot'} />
          <span>{runtimeLabel}</span>
        </div>
        <StateVersion hash={view.stateHash} version={view.stateVersion} />
      </header>
      <main className="workspace">
        <section className="field">
          <div className="field-heading">
            <div>
              <span>Activity</span>
              <h2>Messages and actions</h2>
              <p>Everything Nox received, considered, and returned.</p>
            </div>
            <div className="activity-meta">
              <span>{view.items.length === 1 ? '1 item' : `${view.items.length} items`}</span>
              <code>Journal {view.journalCursor}</code>
            </div>
          </div>
          {view.error && (
            <div className="connection-error" role="alert">
              {view.error}
            </div>
          )}
          <div className="timeline-scroll">
            <NoxTimeline
              items={view.items}
              onCancel={async actId => {
                await cancelNoxAct(actId)
              }}
            />
          </div>
          <NoxComposer disabled={!view.connected} onSubmit={submit} />
        </section>
        <aside className="causal-rail">
          <div className="rail-intro">
            <span>System</span>
            <h2>{view.connected ? 'Nox is ready' : runtimeLabel}</h2>
            <p>
              {view.connected
                ? 'The local runtime is connected and can receive messages.'
                : 'The local runtime is unavailable.'}
            </p>
          </div>
          <dl className="system-summary">
            <div>
              <dt>Runtime</dt>
              <dd className={view.connected ? 'value-online' : ''}>{runtimeLabel}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd title={view.modelId}>{view.modelId || 'Not available'}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>Version {view.stateVersion}</dd>
            </div>
            <div>
              <dt>Journal</dt>
              <dd>{view.journalCursor} records</dd>
            </div>
          </dl>
          <div className="rail-divider" />
          <ContinuationList
            continuations={view.continuations}
            onRequestCancel={continuation =>
              submit(`Cancel scheduled follow-up ${continuation.continuationId} (${continuation.seed.label}).`)
            }
          />
          <div className="rail-legend">
            <div className="rail-heading">
              <h2>Status guide</h2>
            </div>
            <dl>
              <div>
                <dt>
                  <i className="legend-dot legend-dot--delivered" />
                  Received
                </dt>
                <dd>Saved locally</dd>
              </div>
              <div>
                <dt>
                  <i className="legend-dot legend-dot--active" />
                  Working
                </dt>
                <dd>Nox is processing it</dd>
              </div>
              <div>
                <dt>
                  <i className="legend-dot" />
                  Done · no reply
                </dt>
                <dd>Completed normally</dd>
              </div>
            </dl>
          </div>
        </aside>
      </main>
    </div>
  )
}
