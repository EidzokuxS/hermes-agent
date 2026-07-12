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
      <div className="composer-surface">
        <Textarea
          aria-label="Message Nox"
          disabled={disabled || submitting}
          maxLength={65_536}
          onChange={event => setContent(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder="Write a message to Nox…"
          rows={2}
          spellCheck
          value={content}
        />
        <div className="composer-footer">
          <span>Enter to send · Shift+Enter for a new line</span>
          <span className="composer-count">{content.length.toLocaleString()} / 65,536</span>
        </div>
        <Button
          aria-label={submitting ? 'Sending' : 'Send'}
          disabled={disabled || submitting || !content.trim()}
          onClick={() => void send()}
          title={submitting ? 'Sending' : 'Send'}
        >
          <span aria-hidden="true" className="codicon codicon-send" />
        </Button>
      </div>
    </div>
  )
}
