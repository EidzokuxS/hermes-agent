import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { NoxRpcClient } from '@nox/interface-rpc'
import {
  actCancelResultSchema,
  domainCallSchema,
  eventAppendResultSchema,
  interfaceEventSchema,
  PROTOCOL_VERSION,
  viewSnapshotSchema
} from '@nox/protocol'
import { app, BrowserWindow, ipcMain, screen, session } from 'electron'

import { launchNoxRuntime } from './nox-runtime-process.js'
import type { NoxRuntimeProcess } from './nox-runtime-process.js'
import { isTrustedRendererUrl, resolveDevelopmentUrl } from './renderer-origin.js'
import { computeWindowOptions, debounce, sanitizeWindowState } from './window-state.js'

const INTERFACE_OWNER_ID = 'nox-desktop-primary'
const RENDERER_FILE = path.resolve(import.meta.dirname, '../renderer/index.html')

const DEVELOPMENT_URL = resolveDevelopmentUrl(process.env.NOX_DESKTOP_DEV_URL)
if (process.env.NOX_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.NOX_DESKTOP_USER_DATA)
}
let mainWindow: BrowserWindow | undefined
let runtimeProcess: NoxRuntimeProcess | undefined
let rpcClient: NoxRpcClient | undefined
let subscriptionCursor = 0
let subscriptionInFlight = false
let subscriptionTimer: ReturnType<typeof setInterval> | undefined

async function readWindowState(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const statePath = path.join(app.getPath('userData'), 'window-state.json')
  const saved = sanitizeWindowState(await readWindowState(statePath))
  const options = computeWindowOptions(saved, screen.getAllDisplays())
  const window = new BrowserWindow({
    ...options,
    backgroundColor: '#0b0d10',
    minHeight: 620,
    minWidth: 400,
    show: false,
    title: 'Nox',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      sandbox: true
    }
  })
  if (saved?.isMaximized) {
    window.maximize()
  }
  const saveState = debounce(() => {
    if (window.isDestroyed()) {
      return
    }
    const bounds = window.getNormalBounds()
    void writeFile(statePath, JSON.stringify({ ...bounds, isMaximized: window.isMaximized() }), 'utf8')
  }, 250)
  window.on('move', saveState)
  window.on('resize', saveState)
  window.once('close', () => {
    window.off('move', saveState)
    window.off('resize', saveState)
    saveState.flush()
  })
  window.once('closed', saveState.cancel)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  if (DEVELOPMENT_URL !== undefined) {
    await window.loadURL(DEVELOPMENT_URL)
  } else {
    await window.loadFile(RENDERER_FILE)
  }
  return window
}

function requireClient(): NoxRpcClient {
  if (rpcClient === undefined) {
    throw new Error('Nox runtime is not connected')
  }
  return rpcClient
}

function requireTrustedRenderer(event: Electron.IpcMainInvokeEvent): void {
  if (mainWindow === undefined || event.sender !== mainWindow.webContents) {
    throw new Error('Nox domain call came from an untrusted webContents')
  }
  if (event.senderFrame === null || !isTrustedRendererUrl(event.senderFrame.url, DEVELOPMENT_URL, RENDERER_FILE)) {
    throw new Error('Nox domain call came from an untrusted renderer origin')
  }
}

function installDomainHandlers(): void {
  ipcMain.handle('nox:view-snapshot', async event => {
    requireTrustedRenderer(event)
    const client = requireClient()
    const view = viewSnapshotSchema.parse(
      await client.call({ method: 'view.snapshot', params: { protocolVersion: PROTOCOL_VERSION } })
    )
    subscriptionCursor = Math.max(subscriptionCursor, view.journalCursor)
    startSubscriptionPump()
    return view
  })
  ipcMain.handle('nox:event-append', async (event, input: unknown) => {
    requireTrustedRenderer(event)
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid Nox request')
    }
    const value = input as Record<string, unknown>
    const call = domainCallSchema.parse({
      method: 'event.append',
      params: {
        clientEventId: value.clientEventId,
        content: { content: value.content, format: value.format, kind: 'message' },
        protocolVersion: PROTOCOL_VERSION
      }
    })
    if (call.method !== 'event.append') {
      throw new Error('Invalid Nox append call')
    }
    return eventAppendResultSchema.parse(await requireClient().call(call))
  })
  ipcMain.handle('nox:act-cancel', async (event, input: unknown) => {
    requireTrustedRenderer(event)
    if (typeof input !== 'object' || input === null) {
      throw new Error('Invalid Nox cancellation')
    }
    const value = input as Record<string, unknown>
    const call = domainCallSchema.parse({
      method: 'act.cancel',
      params: { actId: value.actId, protocolVersion: PROTOCOL_VERSION, reason: value.reason }
    })
    if (call.method !== 'act.cancel') {
      throw new Error('Invalid Nox cancel call')
    }
    return actCancelResultSchema.parse(await requireClient().call(call))
  })
}

function startSubscriptionPump(): void {
  if (subscriptionTimer !== undefined) {
    return
  }
  const poll = async (): Promise<void> => {
    if (subscriptionInFlight || rpcClient === undefined) {
      return
    }
    subscriptionInFlight = true
    try {
      await rpcClient.call({
        method: 'journal.subscribe',
        params: { afterSequence: subscriptionCursor, protocolVersion: PROTOCOL_VERSION }
      })
    } finally {
      subscriptionInFlight = false
    }
  }
  void poll()
  subscriptionTimer = setInterval(
    () => void poll().catch(error => console.error('Nox subscription failed', error)),
    200
  )
}

async function startRuntime(): Promise<void> {
  const launchToken = randomBytes(32).toString('base64url')
  runtimeProcess = await launchNoxRuntime({
    dataDirectory: path.join(app.getPath('userData'), 'runtime'),
    interfaceOwnerId: INTERFACE_OWNER_ID,
    launchToken,
    ...(process.env.NOX_PI_MODEL ? { model: process.env.NOX_PI_MODEL } : {}),
    ...(process.env.NOX_PI_PROVIDER ? { provider: process.env.NOX_PI_PROVIDER } : {}),
    ...(process.env.NOX_RUNTIME_ENTRY ? { runtimeEntry: process.env.NOX_RUNTIME_ENTRY } : {})
  })
  rpcClient = new NoxRpcClient({ launchToken, url: `ws://127.0.0.1:${runtimeProcess.port}` })
  rpcClient.subscribe(event => {
    const parsed = interfaceEventSchema.parse(event)
    subscriptionCursor = Math.max(subscriptionCursor, parsed.journalSequence)
    mainWindow?.webContents.send('nox:interface-event', parsed)
  })
  await rpcClient.ready()
}

installDomainHandlers()

void app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const development = DEVELOPMENT_URL !== undefined
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:; connect-src ${development ? "'self' ws://127.0.0.1:5174" : "'none'"}`
        ]
      }
    })
  })
  await startRuntime()
  mainWindow = await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().then(window => (mainWindow = window))
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', event => {
  if (rpcClient === undefined && runtimeProcess === undefined) {
    return
  }
  event.preventDefault()
  const client = rpcClient
  const processHandle = runtimeProcess
  if (subscriptionTimer !== undefined) {
    clearInterval(subscriptionTimer)
  }
  subscriptionTimer = undefined
  rpcClient = undefined
  runtimeProcess = undefined
  void client
    ?.close()
    .finally(() => processHandle?.stop())
    .finally(() => app.exit())
})
