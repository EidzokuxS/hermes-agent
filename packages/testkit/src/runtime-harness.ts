/// <reference types="node" />

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NoxRpcClient } from '@nox/interface-rpc'
import { eventAppendResultSchema, PROTOCOL_VERSION, viewSnapshotSchema } from '@nox/protocol'
import type { EventReceipt, ViewSnapshot } from '@nox/protocol'

import type { CrashBoundary } from './runtime-child-main.js'
import type { ScriptedScenario } from './scripted-cortex.js'

export interface StartRuntimeChildOptions {
  crashBoundary?: CrashBoundary
  dataDirectory: string
  delayMilliseconds?: number
  fireDue?: boolean
  now: string
  phase: string
  scenario?: ScriptedScenario
}

export interface RuntimeChild {
  append(clientEventId: string, content?: string): Promise<EventReceipt>
  client: NoxRpcClient
  close(): Promise<void>
  forceTerminate(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  pid: number
  snapshot(): Promise<ViewSnapshot>
  waitForSnapshot(predicate: (view: ViewSnapshot) => boolean, timeoutMilliseconds?: number): Promise<ViewSnapshot>
}

interface Announcement {
  pid: number
  port: number
  protocolVersion: 1
}

function parseAnnouncement(line: string): Announcement {
  const value = JSON.parse(line) as Partial<Announcement>
  if (value.protocolVersion !== 1 || typeof value.pid !== 'number' || typeof value.port !== 'number') {
    throw new Error('Test runtime child emitted an invalid announcement')
  }
  return { pid: value.pid, port: value.port, protocolVersion: value.protocolVersion }
}

export async function startRuntimeChild(options: StartRuntimeChildOptions): Promise<RuntimeChild> {
  const launchToken = randomUUID()
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
  const entry = join(repositoryRoot, 'packages/testkit/src/runtime-child-main.ts')
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      entry,
      '--data-dir',
      options.dataDirectory,
      '--now',
      options.now,
      '--phase',
      options.phase,
      '--scenario',
      options.scenario ?? 'first-loop',
      '--crash',
      options.crashBoundary ?? 'none',
      '--fire-due',
      String(options.fireDue ?? false),
      '--delay-ms',
      String(options.delayMilliseconds ?? 250),
      '--interface-owner',
      'nox-desktop-primary',
      '--launch-token',
      launchToken
    ],
    { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384)
  })
  const announcement = await new Promise<Announcement>((resolve, reject) => {
    let stdout = ''
    const onExit = (code: number | null): void =>
      reject(new Error(`Runtime child exited before ready (${code}): ${stderr}`))
    child.once('exit', onExit)
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      const newline = stdout.indexOf('\n')
      if (newline < 0) {
        return
      }
      child.off('exit', onExit)
      try {
        resolve(parseAnnouncement(stdout.slice(0, newline)))
      } catch (error) {
        reject(error)
      }
    })
    child.once('error', reject)
  })
  const client = new NoxRpcClient({ launchToken, url: `ws://127.0.0.1:${announcement.port}` })
  await client.ready()

  const waitForExit = (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
    new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode })
        return
      }
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })

  const snapshot = async (): Promise<ViewSnapshot> =>
    viewSnapshotSchema.parse(
      await client.call({ method: 'view.snapshot', params: { protocolVersion: PROTOCOL_VERSION } })
    )

  return {
    append: async (clientEventId, content = 'Begin the deterministic causal loop.') => {
      const result = eventAppendResultSchema.parse(
        await client.call({
          method: 'event.append',
          params: { clientEventId, content: { content, format: 'text', kind: 'message' }, protocolVersion: 1 }
        })
      )
      return result.receipt
    },
    client,
    close: async () => {
      await client.close().catch(() => undefined)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
      }
      await waitForExit()
    },
    forceTerminate: async () => {
      await client.close().catch(() => undefined)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
      return waitForExit()
    },
    pid: announcement.pid,
    snapshot,
    waitForSnapshot: async (predicate, timeoutMilliseconds = 10_000) => {
      const deadline = Date.now() + timeoutMilliseconds
      while (Date.now() < deadline) {
        const view = await snapshot()
        if (predicate(view)) {
          return view
        }
        await new Promise<void>(resolve => setTimeout(resolve, 20))
      }
      throw new Error(`Timed out waiting for runtime child snapshot: ${stderr}`)
    }
  }
}
