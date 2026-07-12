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
        <h2>No messages yet</h2>
        <p>Send a message to begin.</p>
      </div>
    )
  }
  return (
    <ol aria-label="Nox activity" className="timeline">
      {items.map((item, index) => (
        <li className="activity-turn" id={`activity-${index}`} key={item.eventId ?? item.clientEventId ?? index}>
          <article className="message message--user">
            <span aria-hidden="true" className="message-avatar">
              Y
            </span>
            <div className="message-content">
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
                <ActStatus act={item.act} terminal={item.terminal} />
                {item.act !== undefined && item.terminal === undefined && (
                  <Button onClick={() => void onCancel(item.act!.actId)} size="inline" variant="text">
                    Stop
                  </Button>
                )}
              </div>
            </div>
          </article>
          {item.emissions.map(emission => (
            <article className="message message--nox" key={emission.emissionId}>
              <span aria-hidden="true" className="message-avatar message-avatar--nox">
                N
              </span>
              <div className="message-content">
                <header className="entry-header">
                  <span className="entry-kind">Nox</span>
                  <time dateTime={emission.occurredAt}>
                    {formatMessageTimestamp(emission.occurredAt, {
                      today: time => time,
                      yesterday: time => `Yesterday ${time}`
                    })}
                  </time>
                </header>
                <p>{emission.content}</p>
              </div>
            </article>
          ))}
          {item.terminal?.status === 'completed-silent' && (
            <div className="silent-settlement">
              <span aria-hidden="true" className="codicon codicon-check" /> Completed.
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
        </li>
      ))}
    </ol>
  )
}
