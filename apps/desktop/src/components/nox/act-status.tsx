import type { ActStarted, ActTerminal } from '@nox/protocol'

import { Badge } from '../ui/badge.js'

const terminalLabels: Record<ActTerminal['status'], string> = {
  cancelled: 'Cancelled',
  'completed-effects': 'Done',
  'completed-silent': 'Done · no reply',
  failed: 'Failed',
  interrupted: 'Interrupted',
  rejected: 'Not accepted'
}

const terminalStates: Record<ActTerminal['status'], string> = {
  cancelled: 'cancelled',
  'completed-effects': 'settled',
  'completed-silent': 'silent',
  failed: 'failed',
  interrupted: 'interrupted',
  rejected: 'rejected'
}

export function ActStatus({ act, terminal }: { act: ActStarted | undefined; terminal: ActTerminal | undefined }) {
  if (act === undefined) {
    return (
      <Badge data-act-state="awaiting act" variant="muted">
        Waiting
      </Badge>
    )
  }
  if (terminal === undefined) {
    return <Badge data-act-state="thinking">Working</Badge>
  }
  const variant =
    terminal.status === 'failed' || terminal.status === 'rejected'
      ? 'destructive'
      : terminal.status === 'interrupted'
        ? 'warn'
        : 'muted'
  return (
    <Badge data-act-state={terminalStates[terminal.status]} variant={variant}>
      {terminalLabels[terminal.status]}
    </Badge>
  )
}
