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
            <p>Autonomous local system</p>
          </div>
        </div>
        <div className={`runtime-presence${view.connected ? ' runtime-presence--live' : ''}`}>
          <span className={view.connected ? 'presence-dot presence-dot--live' : 'presence-dot'} />
          <span>{runtimeLabel}</span>
        </div>
        <StateVersion hash={view.stateHash} version={view.stateVersion} />
      </header>
      <main className="workspace">
        <section className={`field${view.items.length === 0 ? ' field--empty' : ''}`}>
          {view.error && (
            <div className="connection-error" role="alert">
              {view.error}
            </div>
          )}
          {view.items.length === 0 ? (
            <div className="empty-stage">
              <span aria-hidden="true" className="empty-stage__icon codicon codicon-comment-discussion-sparkle" />
              <div className="empty-stage__copy">
                <span>{view.modelId || 'Nox'}</span>
                <h2>Message Nox</h2>
                <p>Nox receives your message as input and decides whether to respond or act.</p>
              </div>
              <NoxComposer disabled={!view.connected} onSubmit={submit} variant="hero" />
            </div>
          ) : (
            <>
              <div className="field-heading">
                <div>
                  <span>Activity</span>
                  <h2>Messages and activity</h2>
                  <p>Messages, responses, and background work in one place.</p>
                </div>
                <div className="activity-meta">
                  <span>{view.items.length === 1 ? '1 item' : `${view.items.length} items`}</span>
                  <code>Journal {view.journalCursor}</code>
                </div>
              </div>
              <div className="timeline-scroll">
                <NoxTimeline
                  items={view.items}
                  onCancel={async actId => {
                    await cancelNoxAct(actId)
                  }}
                />
              </div>
              <NoxComposer disabled={!view.connected} onSubmit={submit} />
            </>
          )}
        </section>
        <aside className="causal-rail">
          <div className="rail-intro">
            <span>System status</span>
            <h2>{view.connected ? 'Ready' : runtimeLabel}</h2>
            <p>
              {view.connected
                ? 'The local runtime can receive messages.'
                : 'The local runtime is unavailable. Messages are paused.'}
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
        </aside>
      </main>
    </div>
  )
}
