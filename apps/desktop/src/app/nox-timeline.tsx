import { formatMessageTimestamp } from '../components/assistant-ui/thread/timestamp.js'
import { ActStatus } from '../components/nox/act-status.js'
import { Button } from '../components/ui/button.js'
import type { NoxTimelineItem } from '../store/nox-view.js'

function deliveryLabel(delivery: NoxTimelineItem['delivery']): string {
  if (delivery === 'recording') {
    return 'recording'
  }
  if (delivery === 'delivered') {
    return 'delivered'
  }
  if (delivery === 'failed') {
    return 'delivery failed'
  }
  return 'admitted'
}

export function NoxTimeline({
  items,
  onCancel
}: {
  items: NoxTimelineItem[]
  onCancel: (actId: string) => Promise<void>
}) {
  if (items.length === 0) {
    return (
      <div className="timeline-empty">
        <span className="timeline-empty__glyph">N</span>
        <h2>The causal field is quiet.</h2>
        <p>
          A request can enter the Journal below. It may produce an emission, alter State, seed a Continuation, or settle
          silently.
        </p>
      </div>
    )
  }
  return (
    <ol aria-label="Nox causal timeline" className="timeline">
      {items.map((item, index) => (
        <li className="causal-entry" key={item.eventId ?? item.clientEventId ?? index}>
          <div aria-hidden="true" className="causal-spine">
            <span />
          </div>
          <article>
            <header className="entry-header">
              <div>
                <span className="entry-kind">
                  {item.kind === 'external' || item.kind === 'pending' ? 'EXTERNAL REQUEST' : item.kind.toUpperCase()}
                </span>
                <time dateTime={item.occurredAt}>
                  {formatMessageTimestamp(item.occurredAt, {
                    today: time => time,
                    yesterday: time => `Yesterday ${time}`
                  })}
                </time>
              </div>
              <span className={`delivery delivery--${item.delivery}`}>
                <i />
                {deliveryLabel(item.delivery)}
              </span>
            </header>
            <p className="request-content">{item.content}</p>
            <div className="act-line">
              <span aria-hidden="true" className="causal-arrow">
                └─
              </span>
              <ActStatus act={item.act} terminal={item.terminal} />
              {item.act !== undefined && <code>{item.act.actId.slice(0, 14)}</code>}
              {item.act !== undefined && item.terminal === undefined && (
                <Button onClick={() => void onCancel(item.act!.actId)} size="inline" variant="text">
                  cancel
                </Button>
              )}
            </div>
            {item.emissions.map(emission => (
              <section className="emission" key={emission.emissionId}>
                <div className="emission-label">
                  <span>NOX</span>
                  <time dateTime={emission.occurredAt}>
                    {formatMessageTimestamp(emission.occurredAt, {
                      today: time => time,
                      yesterday: time => `Yesterday ${time}`
                    })}
                  </time>
                </div>
                <p>{emission.content}</p>
              </section>
            ))}
            {item.terminal?.status === 'completed-silent' && (
              <div className="silent-settlement">
                <span>∅</span> Act settled without an emission.
              </div>
            )}
            {item.terminal !== undefined &&
              ['failed', 'rejected', 'interrupted', 'cancelled'].includes(item.terminal.status) && (
                <div className="terminal-detail">
                  {'message' in item.terminal
                    ? item.terminal.message
                    : 'reason' in item.terminal
                      ? item.terminal.reason
                      : item.terminal.status}
                </div>
              )}
          </article>
        </li>
      ))}
    </ol>
  )
}
