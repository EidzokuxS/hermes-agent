export interface SendableWindow {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: string, payload: unknown): void
  }
}

export function sendToLiveWindow(window: SendableWindow | undefined, channel: string, payload: unknown): boolean {
  if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed()) {
    return false
  }
  window.webContents.send(channel, payload)
  return true
}
