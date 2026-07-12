import { formatMessageTimestamp } from '../components/assistant-ui/thread/timestamp.js'
import { ActStatus } from '../components/nox/act-status.js'
import { Button } from '../components/ui/button.js'
import type { NoxTimelineItem } from '../store/nox-view.js'

function deliveryLabel(delivery: NoxTimelineItem['delivery'], completed: boolean): string {
  if (delivery === 'recording') {
    return 'Saving…'
  }
  if (delivery === 'delivered') {
    return 'Received'
  }
  if (delivery === 'failed') {
    return 'Not sent'
  }
  return completed ? 'Processed' : 'Processing'
}

function eventLabel(kind: NoxTimelineItem['kind']): string {
  if (kind === 'external' || kind === 'pending') {
    return 'You'
  }
  if (kind === 'continuation') {
    return 'Scheduled follow-up'
  }
  return 'System recovery'
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
        <span aria-hidden="true" className="timeline-empty__glyph codicon codicon-comment-discussion" />
        <h2>No activity yet</h2>
        <p>Send a message below. Nox may reply, update its state, schedule a follow-up, or take no action.</p>
      </div>
    )
  }
  return (
    <ol aria-label="Nox activity" className="timeline">
      {items.map((item, index) => (
        <li className="causal-entry" key={item.eventId ?? item.clientEventId ?? index}>
          <div aria-hidden="true" className="causal-spine">
            <span />
          </div>
          <article>
            <header className="entry-header">
              <div>
                <span className="entry-kind">{eventLabel(item.kind)}</span>
                <time dateTime={item.occurredAt}>
                  {formatMessageTimestamp(item.occurredAt, {
                    today: time => time,
                    yesterday: time => `Yesterday ${time}`
                  })}
                </time>
              </div>
              <span className={`delivery delivery--${item.delivery}`} data-delivery-state={item.delivery}>
                <i />
                {deliveryLabel(item.delivery, item.terminal !== undefined)}
              </span>
            </header>
            <p className="request-content">{item.content}</p>
            <div className="act-line">
              <span aria-hidden="true" className="codicon codicon-chevron-right causal-arrow" />
              <ActStatus act={item.act} terminal={item.terminal} />
              {item.act !== undefined && item.terminal === undefined && (
                <Button onClick={() => void onCancel(item.act!.actId)} size="inline" variant="text">
                  Stop
                </Button>
              )}
            </div>
            {item.emissions.map(emission => (
              <section className="emission" key={emission.emissionId}>
                <div className="emission-label">
                  <span>Nox</span>
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
                <span aria-hidden="true" className="codicon codicon-check" /> Completed without a reply.
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
