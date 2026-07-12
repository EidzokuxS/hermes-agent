import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface RuntimeAnnouncement {
  port: number
  protocolVersion: 1
}

export interface NoxRuntimeProcess {
  port: number
  stop(): Promise<void>
}

export interface RuntimeProcessDiagnostic {
  message: string
}

export interface RuntimeProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface LaunchNoxRuntimeOptions {
  dataDirectory: string
  interfaceOwnerId: string
  launchToken: string
  model?: string
  onDiagnostic?: (diagnostic: RuntimeProcessDiagnostic) => void
  onExit?: (result: RuntimeProcessExit) => void
  provider?: string
  runtimeEntry?: string
}

function parseAnnouncement(line: string): RuntimeAnnouncement {
  const value: unknown = JSON.parse(line)
  if (
    typeof value !== 'object' ||
    value === null ||
    !('port' in value) ||
    typeof value.port !== 'number' ||
    !Number.isInteger(value.port) ||
    value.port <= 0 ||
    !('protocolVersion' in value) ||
    value.protocolVersion !== 1
  ) {
    throw new Error('Nox runtime produced an invalid launch announcement')
  }
  return { port: value.port, protocolVersion: value.protocolVersion }
}

export async function launchNoxRuntime(options: LaunchNoxRuntimeOptions): Promise<NoxRuntimeProcess> {
  await mkdir(options.dataDirectory, { recursive: true })
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const runtimeEntry = options.runtimeEntry ?? path.resolve(moduleDirectory, '../../../runtime/dist/main.js')
  const repositoryRoot = path.resolve(moduleDirectory, '../../../..')
  const child = spawn(
    process.execPath,
    [
      runtimeEntry,
      '--data-dir',
      options.dataDirectory,
      '--interface-owner',
      options.interfaceOwnerId,
      '--provider',
      options.provider ?? 'openai-codex',
      '--model',
      options.model ?? 'gpt-5.4-mini'
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NOX_LAUNCH_TOKEN: options.launchToken },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let announced = false
  let stopping = false
  if (process.env.NOX_DESKTOP_RUNTIME_PID_FILE !== undefined) {
    if (child.pid === undefined) {
      throw new Error('Nox runtime process has no PID')
    }
    await writeFile(process.env.NOX_DESKTOP_RUNTIME_PID_FILE, String(child.pid), 'utf8')
  }

  const announcement = await new Promise<RuntimeAnnouncement>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const onExit = (code: number | null): void =>
      reject(new Error(`Nox runtime exited before ready (${code}): ${stderr}`))
    child.once('exit', onExit)
    child.stderr.on('data', chunk => {
      const message = String(chunk).slice(-2_048)
      stderr = `${stderr}${message}`.slice(-8_192)
      if (announced && !stopping) {
        options.onDiagnostic?.({ message })
      }
    })
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
      if (stdout.length > 8_192) {
        reject(new Error('Nox runtime launch announcement exceeded 8 KiB'))
        return
      }
      const newline = stdout.indexOf('\n')
      if (newline < 0) {
        return
      }
      child.off('exit', onExit)
      try {
        const parsed = parseAnnouncement(stdout.slice(0, newline))
        announced = true
        resolve(parsed)
      } catch (error) {
        reject(error)
      }
    })
    child.once('error', reject)
  })
  child.on('exit', (code, signal) => {
    if (announced && !stopping) {
      options.onExit?.({ code, signal })
    }
  })

  return {
    port: announcement.port,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return
      }
      stopping = true
      await new Promise<void>(resolve => {
        child.once('exit', () => resolve())
        child.kill()
      })
    }
  }
}
