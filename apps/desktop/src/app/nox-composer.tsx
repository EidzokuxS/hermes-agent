import { useState } from 'react'

import { Button } from '../components/ui/button.js'
import { Textarea } from '../components/ui/textarea.js'

export function NoxComposer({
  disabled,
  onSubmit
}: {
  disabled: boolean
  onSubmit: (content: string) => Promise<void>
}) {
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const send = async (): Promise<void> => {
    const value = content.trim()
    if (!value || submitting || disabled) {
      return
    }
    setSubmitting(true)
    setContent('')
    try {
      await onSubmit(value)
    } catch {
      setContent(value)
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="composer-wrap">
      <div className="composer-kicker">
        <span>Request channel</span>
        <span>{content.length.toLocaleString()} / 65,536</span>
      </div>
      <div className="composer">
        <Textarea
          aria-label="Offer Nox a request"
          disabled={disabled || submitting}
          maxLength={65_536}
          onChange={event => setContent(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder="Offer a request. Nox decides whether and how to act."
          rows={3}
          spellCheck
          value={content}
        />
        <Button disabled={disabled || submitting || !content.trim()} onClick={() => void send()}>
          {submitting ? 'Delivering…' : 'Deliver'}
          <span aria-hidden="true">↗</span>
        </Button>
      </div>
      <p className="composer-note">Enter to deliver · Shift+Enter for a new line · delivery is not an instruction</p>
    </div>
  )
}
