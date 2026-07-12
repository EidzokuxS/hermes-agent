import { useState } from 'react'

import { Button } from '../components/ui/button.js'
import { Textarea } from '../components/ui/textarea.js'

export function NoxComposer({
  disabled,
  onSubmit,
  variant = 'default'
}: {
  disabled: boolean
  onSubmit: (content: string) => Promise<void>
  variant?: 'default' | 'hero'
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
    <div className={`composer-wrap composer-wrap--${variant}`}>
      <div className="composer-kicker">
        <span>Message</span>
        <span>{content.length.toLocaleString()} / 65,536</span>
      </div>
      <div className="composer">
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
          rows={3}
          spellCheck
          value={content}
        />
        <Button disabled={disabled || submitting || !content.trim()} onClick={() => void send()}>
          {submitting ? 'Sending…' : 'Send'}
          <span aria-hidden="true" className="codicon codicon-send" />
        </Button>
      </div>
      <p className="composer-note">Enter to send · Shift+Enter for a new line</p>
    </div>
  )
}
