// Sandboxed Electron preloads execute in a CommonJS-like isolated context.
// The .cts source compiles to .cjs while the main process remains native ESM.
const { contextBridge, ipcRenderer } = require('electron')

const api = {
  appendEvent: (request: { clientEventId: string; content: string; format: 'markdown' | 'text' }) =>
    ipcRenderer.invoke('nox:event-append', request) as Promise<unknown>,
  cancelAct: (request: { actId: string; reason: string }) =>
    ipcRenderer.invoke('nox:act-cancel', request) as Promise<unknown>,
  snapshot: () => ipcRenderer.invoke('nox:view-snapshot') as Promise<unknown>,
  subscribe: (listener: (event: unknown) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on('nox:interface-event', wrapped)
    return () => ipcRenderer.removeListener('nox:interface-event', wrapped)
  }
}

contextBridge.exposeInMainWorld('nox', api)
