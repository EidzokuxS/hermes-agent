import { actCancelResultSchema, eventAppendResultSchema, interfaceEventSchema, viewSnapshotSchema } from '@nox/protocol'
import type { InterfaceEvent, ViewSnapshot } from '@nox/protocol'

export interface NoxDesktopBridge {
  appendEvent(request: { clientEventId: string; content: string; format: 'markdown' | 'text' }): Promise<unknown>
  cancelAct(request: { actId: string; reason: string }): Promise<unknown>
  snapshot(): Promise<ViewSnapshot>
  subscribe(listener: (event: InterfaceEvent) => void): () => void
  subscribeHealth(listener: (event: unknown) => void): () => void
}

export interface RuntimeHealthEvent {
  message: string
  status: 'unhealthy'
}

declare global {
  interface Window {
    nox?: NoxDesktopBridge
  }
}

function bridge(): NoxDesktopBridge {
  if (window.nox === undefined) {
    throw new Error('Nox preload bridge is unavailable')
  }
  return window.nox
}

export async function connectNox(
  onSnapshot: (view: ViewSnapshot) => void,
  onEvent: (event: InterfaceEvent) => void,
  onHealth: (event: RuntimeHealthEvent) => void
): Promise<() => void> {
  const queued: InterfaceEvent[] = []
  let hydrated = false
  const stop = bridge().subscribe(event => {
    const parsed = interfaceEventSchema.parse(event)
    if (hydrated) {
      onEvent(parsed)
    } else {
      queued.push(parsed)
    }
  })
  const stopHealth = bridge().subscribeHealth(event => {
    if (
      typeof event === 'object' &&
      event !== null &&
      'status' in event &&
      event.status === 'unhealthy' &&
      'message' in event &&
      typeof event.message === 'string'
    ) {
      onHealth({ message: event.message, status: 'unhealthy' })
    }
  })
  try {
    onSnapshot(viewSnapshotSchema.parse(await bridge().snapshot()))
    for (const event of queued.sort((left, right) => left.journalSequence - right.journalSequence)) {
      onEvent(event)
    }
    hydrated = true
    return () => {
      stop()
      stopHealth()
    }
  } catch (error) {
    stop()
    stopHealth()
    throw error
  }
}

export async function appendNoxRequest(clientEventId: string, content: string) {
  return eventAppendResultSchema.parse(await bridge().appendEvent({ clientEventId, content, format: 'text' }))
}

export async function cancelNoxAct(actId: string) {
  return actCancelResultSchema.parse(await bridge().cancelAct({ actId, reason: 'Cancelled from Nox Desktop' }))
}
