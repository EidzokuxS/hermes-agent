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
  setConnectionError
} from '../store/nox-view.js'
import { appendNoxRequest, cancelNoxAct, connectNox } from '../transport/nox-client.js'

import { NoxComposer } from './nox-composer.js'
import { NoxTimeline } from './nox-timeline.js'

export function NoxShell() {
  const view = useStore($noxView)
  useEffect(() => {
    if (window.nox === undefined) {
      loadFixtureView(new URLSearchParams(window.location.search).get('fixture') ?? 'emitted')
      return
    }
    let stop: (() => void) | undefined
    void connectNox(hydrateNoxView, reduceInterfaceEvent)
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
          <span className="identity-mark">N</span>
          <div>
            <h1>NOX</h1>
            <p>causal field</p>
          </div>
        </div>
        <div className="runtime-presence">
          <span className={view.connected ? 'presence-dot presence-dot--live' : 'presence-dot'} />
          <span>
            {view.connecting ? 'locating runtime' : view.connected ? 'runtime present' : 'runtime unavailable'}
          </span>
        </div>
        <StateVersion hash={view.stateHash} version={view.stateVersion} />
      </header>
      <main className="workspace">
        <section className="field">
          <div className="field-heading">
            <div>
              <span>JOURNAL / LIVE PROJECTION</span>
              <h2>What entered. What followed.</h2>
            </div>
            <code>cursor {view.journalCursor}</code>
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
            <span>CAUSAL SURFACE</span>
            <p>The interface observes Nox. It does not own State, memory, or the transcript.</p>
          </div>
          <ContinuationList
            continuations={view.continuations}
            onRequestCancel={continuation =>
              submit(
                `Please consider cancelling Continuation ${continuation.continuationId} (${continuation.seed.label}).`
              )
            }
          />
          <div className="rail-legend">
            <div className="rail-heading">
              <h2>Legend</h2>
            </div>
            <dl>
              <div>
                <dt>
                  <i className="legend-dot legend-dot--delivered" />
                  delivered
                </dt>
                <dd>durable receipt</dd>
              </div>
              <div>
                <dt>
                  <i className="legend-dot legend-dot--active" />
                  thinking
                </dt>
                <dd>Act in flight</dd>
              </div>
              <div>
                <dt>
                  <i className="legend-dot" />
                  silent
                </dt>
                <dd>valid settlement</dd>
              </div>
            </dl>
          </div>
        </aside>
      </main>
    </div>
  )
}
