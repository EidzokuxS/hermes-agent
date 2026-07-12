import type { OpenContinuation } from '@nox/protocol'

import { relativeTime } from '../../lib/time.js'
import { Button } from '../ui/button.js'

export function ContinuationList({
  continuations,
  onRequestCancel
}: {
  continuations: OpenContinuation[]
  onRequestCancel: (continuation: OpenContinuation) => Promise<void>
}) {
  return (
    <section aria-labelledby="continuations-title" className="continuations">
      <div className="rail-heading">
        <h2 id="continuations-title">Scheduled follow-ups</h2>
        <span>{continuations.length}</span>
      </div>
      {continuations.length === 0 ? (
        <p className="rail-empty">No follow-ups are scheduled.</p>
      ) : (
        <ol>
          {continuations.map(continuation => (
            <li key={continuation.continuationId}>
              <span className="continuation-mark" />
              <div>
                <strong>{continuation.seed.label}</strong>
                <time dateTime={continuation.seed.due.at}>
                  {relativeTime(new Date(continuation.seed.due.at).getTime())}
                </time>
                <Button onClick={() => void onRequestCancel(continuation)} size="inline" variant="text">
                  Cancel follow-up
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
