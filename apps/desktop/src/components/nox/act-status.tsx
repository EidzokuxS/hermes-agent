import type { ActStarted, ActTerminal } from '@nox/protocol'

import { Badge } from '../ui/badge.js'

const terminalLabels: Record<ActTerminal['status'], string> = {
  cancelled: 'cancelled',
  'completed-effects': 'settled',
  'completed-silent': 'silent',
  failed: 'failed',
  interrupted: 'interrupted',
  rejected: 'rejected'
}

export function ActStatus({ act, terminal }: { act: ActStarted | undefined; terminal: ActTerminal | undefined }) {
  if (act === undefined) {
    return <Badge variant="muted">awaiting act</Badge>
  }
  if (terminal === undefined) {
    return <Badge>thinking</Badge>
  }
  const variant =
    terminal.status === 'failed' || terminal.status === 'rejected'
      ? 'destructive'
      : terminal.status === 'interrupted'
        ? 'warn'
        : 'muted'
  return <Badge variant={variant}>{terminalLabels[terminal.status]}</Badge>
}
