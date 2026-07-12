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

  const recentItems = view.items
    .map((item, index) => ({ index, item }))
    .slice(-6)
    .reverse()

  return (
    <div className="nox-shell">
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <span aria-hidden="true" className="identity-mark">
            N
          </span>
          <div>
            <h1>Nox</h1>
            <p>Local system</p>
          </div>
        </div>

        <button
          className="new-message-button"
          onClick={() => document.querySelector('textarea')?.focus()}
          type="button"
        >
          <span aria-hidden="true" className="codicon codicon-add" />
          New message
        </button>

        <nav aria-label="Nox navigation" className="sidebar-navigation">
          <a aria-current="page" href="#activity">
            <span aria-hidden="true" className="codicon codicon-comment-discussion" />
            Activity
          </a>
        </nav>

        <div className="sidebar-section sidebar-section--recent">
          <h2>Recent</h2>
          {recentItems.length === 0 ? (
            <p className="sidebar-empty">No messages yet</p>
          ) : (
            <ol>
              {recentItems.map(({ index, item }) => (
                <li key={item.eventId ?? item.clientEventId ?? index}>
                  <a href={`#activity-${index}`}>{item.content}</a>
                </li>
              ))}
            </ol>
          )}
        </div>

        <ContinuationList
          continuations={view.continuations}
          onRequestCancel={continuation =>
            submit(`Cancel scheduled follow-up ${continuation.continuationId} (${continuation.seed.label}).`)
          }
        />

        <div className="sidebar-runtime">
          <span className={view.connected ? 'presence-dot presence-dot--live' : 'presence-dot'} />
          <div>
            <strong>{runtimeLabel}</strong>
            <span title={view.modelId}>{view.modelId || 'No model'}</span>
          </div>
        </div>
      </aside>

      <main className="app-main">
        <header className="conversation-header">
          <div>
            <h2>Nox</h2>
            <p>Current activity</p>
          </div>
          <div className={`runtime-presence${view.connected ? ' runtime-presence--live' : ''}`}>
            <span className={view.connected ? 'presence-dot presence-dot--live' : 'presence-dot'} />
            <span>{runtimeLabel}</span>
          </div>
        </header>

        <section className="conversation" id="activity">
          {view.error && (
            <div className="connection-error" role="alert">
              {view.error}
            </div>
          )}
          <div className="conversation-scroll">
            {view.items.length === 0 ? (
              <div className="empty-stage">
                <div className="empty-stage__copy">
                  <span>{view.modelId || 'Nox'}</span>
                  <h2>NOX</h2>
                  <p>Send a message. Nox decides whether and how to respond.</p>
                </div>
              </div>
            ) : (
              <div className="timeline-wrap">
                <NoxTimeline
                  items={view.items}
                  onCancel={async actId => {
                    await cancelNoxAct(actId)
                  }}
                />
              </div>
            )}
          </div>
          <NoxComposer disabled={!view.connected} onSubmit={submit} />
        </section>

        <footer className="statusbar">
          <div>
            <span className={view.connected ? 'presence-dot presence-dot--live' : 'presence-dot'} />
            {runtimeLabel}
          </div>
          <span>{view.modelId || 'No model'}</span>
          <span>{view.journalCursor} journal records</span>
          <StateVersion hash={view.stateHash} version={view.stateVersion} />
        </footer>
      </main>
    </div>
  )
}
