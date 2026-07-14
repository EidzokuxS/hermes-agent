#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

const DEFAULT_TIMEOUT_MS = 120_000

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}

function writeJson(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`)
}

function parseArgs(argv) {
  const values = {}

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`)
    }

    const key = argument.slice(2)
    const value = argv[index + 1]

    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }

    values[key] = value
    index += 1
  }

  return values
}

function requiredPath(value, name, kind = 'directory') {
  if (!value) {
    throw new Error(`--${name} is required`)
  }

  const resolved = path.resolve(value)

  if (!fs.existsSync(resolved)) {
    throw new Error(`${name} does not exist: ${resolved}`)
  }

  const stat = fs.statSync(resolved)

  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`${name} is not a ${kind}: ${resolved}`)
  }

  return resolved
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close(error => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitForJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let lastError = null

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)

      if (response.ok) {
        return await response.json()
      }

      lastError = new Error(`${response.status} ${response.statusText}`)
    } catch (error) {
      lastError = error
    }

    await delay(250)
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'no response'}`)
}

class CdpClient {
  constructor(url) {
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.socket = new WebSocket(url)
  }

  async connect(timeoutMs = 15_000) {
    await Promise.race([
      new Promise((resolve, reject) => {
        this.socket.addEventListener('open', resolve, { once: true })
        this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed to open')), { once: true })
      }),
      delay(timeoutMs).then(() => {
        throw new Error('Timed out opening CDP WebSocket')
      })
    ])

    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))

      if (message.id) {
        const pending = this.pending.get(message.id)

        if (!pending) {
          return
        }

        this.pending.delete(message.id)

        if (message.error) {
          pending.reject(new Error(`${pending.method}: ${message.error.message}`))
        } else {
          pending.resolve(message.result || {})
        }

        return
      }

      for (const listener of this.listeners.get(message.method) || []) {
        listener(message.params || {})
      }
    })
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`${pending.method}: CDP WebSocket closed`))
      }
      this.pending.clear()
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || []
    listeners.push(listener)
    this.listeners.set(method, listeners)
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId
    this.nextId += 1

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: CDP command timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
        resolve: result => {
          clearTimeout(timer)
          resolve(result)
        }
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, options = {}) {
    const result = await this.send('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
      userGesture: true,
      ...options
    })

    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text
      throw new Error(`Renderer evaluation failed: ${detail}`)
    }

    return result.result?.value
  }

  close() {
    this.socket.close()
  }
}

async function waitFor(client, expression, label, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let lastValue = null

  while (Date.now() < deadline) {
    try {
      lastValue = await client.evaluate(expression)

      if (lastValue) {
        return lastValue
      }
    } catch {
      // The renderer may be between reloads while the product capture hook
      // skips onboarding. Retry against the same target.
    }

    await delay(300)
  }

  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`)
}

async function connectRenderer(port) {
  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`)
  const target = targets.find(candidate => candidate.type === 'page' && candidate.webSocketDebuggerUrl)

  if (!target) {
    throw new Error('Electron renderer target was not exposed over CDP')
  }

  const client = new CdpClient(target.webSocketDebuggerUrl)
  await client.connect()
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  await client.send('Network.enable')

  return { client, target }
}

function captureWebSocketMetadata(client, trace) {
  for (const [method, direction] of [
    ['Network.webSocketFrameReceived', 'received'],
    ['Network.webSocketFrameSent', 'sent']
  ]) {
    client.on(method, params => {
      const payload = String(params.response?.payloadData || '')
      trace.push({
        bytes: Buffer.byteLength(payload),
        direction,
        opcode: params.response?.opcode ?? null,
        payload_sha256: sha256Text(payload),
        timestamp: params.timestamp ?? null
      })
    })
  }
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }

  spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true
  })
}

function launchDesktop({ executable, noxHome, sourceOverride, userData, workDirectory }) {
  const portPromise = freePort()

  return portPromise.then(port => {
    const autoCapture = path.join(workDirectory, 'automatic-empty-capture')
    fs.mkdirSync(autoCapture, { recursive: true })
    fs.mkdirSync(userData, { recursive: true })

    const env = {
      ...process.env,
      HERMES_DESKTOP_CWD: workDirectory,
      NOX_DESKTOP_CAPTURE_DELAY_MS: '3600000',
      NOX_DESKTOP_CAPTURE_DIR: autoCapture,
      NOX_DESKTOP_USER_DATA_DIR: userData,
      NOX_HOME: noxHome
    }
    delete env.HERMES_DESKTOP_HERMES_ROOT
    delete env.PYTHONPATH

    if (sourceOverride) {
      env.HERMES_DESKTOP_HERMES_ROOT = sourceOverride
    }

    const child = spawn(executable, [`--remote-debugging-port=${port}`], {
      cwd: workDirectory,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })

    return { child, logs: () => ({ stderr, stdout }), port }
  })
}

async function capture(client, outputPath) {
  const result = await client.send('Page.captureScreenshot', {
    captureBeyondViewport: false,
    format: 'png',
    fromSurface: true
  })
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, Buffer.from(result.data, 'base64'))
}

async function captureAt(client, outputPath, width, height) {
  await client.send('Emulation.clearDeviceMetricsOverride')
  await client.send('Emulation.setDeviceMetricsOverride', {
    deviceScaleFactor: 1,
    height,
    mobile: false,
    width
  })
  await delay(500)
  await capture(client, outputPath)
}

async function messageCounts(client) {
  return await client.evaluate(`(() => ({
    assistants: document.querySelectorAll('[data-role="assistant"]').length,
    completedAssistants: [...document.querySelectorAll('[data-role="assistant"]')]
      .filter(node => node.getAttribute('data-streaming') !== 'true' && node.innerText.trim().length > 0).length,
    streamingAssistants: [...document.querySelectorAll('[data-role="assistant"]')]
      .filter(node => node.getAttribute('data-streaming') === 'true').length,
    toolBlocks: document.querySelectorAll('[data-slot="tool-block"]').length,
    users: document.querySelectorAll('[data-role="user"]').length
  }))()`)
}

async function setComposerText(client, text, { append = false } = {}) {
  const serialized = JSON.stringify(text)
  const result = await client.evaluate(`(() => {
    const editor = document.querySelector('[data-slot="composer-rich-input"]')
    if (!editor) return { ok: false, reason: 'missing-editor' }
    editor.focus()
    ${append ? `editor.append(document.createTextNode(${serialized}))` : `editor.textContent = ${serialized}`}
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: ${serialized},
      inputType: 'insertText'
    }))
    return { ok: true, text: editor.innerText }
  })()`)

  if (!result?.ok) {
    throw new Error(`Could not set composer text: ${JSON.stringify(result)}`)
  }

  await delay(500)
}

async function clickComposerAction(client, expectedAction = 'send') {
  return await client.evaluate(`(() => {
    const editor = document.querySelector('[data-slot="composer-rich-input"]')
    const form = editor?.closest('form')
    const buttons = [...(form?.querySelectorAll('button') || [])]
    const button = buttons.find(candidate => {
      if (candidate.disabled) return false
      const label = (candidate.getAttribute('aria-label') || '').toLowerCase()
      return ${JSON.stringify(expectedAction)} === 'stop'
        ? label.includes('stop')
        : candidate.type === 'submit' || label === 'send' || label.includes('send message')
    })
    if (!button) return { ok: false, labels: buttons.map(node => node.getAttribute('aria-label')) }
    button.click()
    return { label: button.getAttribute('aria-label'), ok: true }
  })()`)
}

async function clickPendingToolApproval(client) {
  return await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(candidate =>
      !candidate.disabled && candidate.innerText.trim().startsWith('Run')
    )
    if (!button) return { ok: false }
    button.click()
    return { ok: true }
  })()`)
}

async function submitCurrentComposer(client, label, timeoutMs = 360_000, { approveTools = false } = {}) {
  const before = await messageCounts(client)
  const startedAt = Date.now()
  await waitFor(
    client,
    `Boolean([...document.querySelectorAll('[data-slot="composer-root"] button')].find(node => {
      const label = (node.getAttribute('aria-label') || '').toLowerCase()
      return !node.disabled && (node.type === 'submit' || label === 'send' || label.includes('send message'))
    }))`,
    `${label} send action`,
    180_000
  )
  const firstClick = await clickComposerAction(client)

  if (!firstClick?.ok) {
    throw new Error(`${label}: send action unavailable: ${JSON.stringify(firstClick)}`)
  }

  // A fresh-chat submit first materializes and warms the session. Chromium's
  // synthetic click is intentionally retried only when no user turn was
  // admitted and the draft remains present after that hand-off.
  await delay(8_000)
  const afterFirstClick = await messageCounts(client)
  let retriedFreshSession = false

  if (afterFirstClick.users === before.users) {
    const draftStillPresent = await client.evaluate(`Boolean(
      document.querySelector('[data-slot="composer-rich-input"]')?.innerText.trim()
    )`)

    if (draftStillPresent) {
      const retry = await clickComposerAction(client)
      if (!retry?.ok) {
        throw new Error(`${label}: fresh-session retry unavailable: ${JSON.stringify(retry)}`)
      }
      retriedFreshSession = true
    }
  }

  await waitFor(
    client,
    `document.querySelectorAll('[data-role="user"]').length > ${before.users}`,
    `${label} user admission`,
    timeoutMs
  )

  let observedStreaming = false
  let approvedToolCalls = 0
  const completionDeadline = Date.now() + timeoutMs

  while (Date.now() < completionDeadline) {
    const current = await messageCounts(client)
    observedStreaming ||= current.streamingAssistants > 0

    if (approveTools) {
      const approval = await clickPendingToolApproval(client)
      approvedToolCalls += approval?.ok ? 1 : 0
    }

    if (current.completedAssistants > before.completedAssistants) {
      return {
        after: current,
        approved_tool_calls: approvedToolCalls,
        before,
        duration_ms: Date.now() - startedAt,
        observed_streaming: observedStreaming,
        retried_fresh_session: retriedFreshSession,
        status: 'completed'
      }
    }
    await delay(250)
  }

  throw new Error(`${label}: assistant response did not complete in ${timeoutMs}ms`)
}

async function submitText(client, text, label, timeoutMs = 360_000) {
  await setComposerText(client, text)
  return await submitCurrentComposer(client, label, timeoutMs)
}

async function dropInternalFile(client, filePath) {
  const serializedPath = JSON.stringify(filePath)
  const result = await client.evaluate(`(() => {
    const target = document.querySelector('[data-slot="composer-root"]')
    if (!target) return { ok: false, reason: 'missing-composer-root' }
    const transfer = new DataTransfer()
    transfer.setData('application/x-hermes-paths', JSON.stringify([{
      isDirectory: false,
      path: ${serializedPath}
    }]))
    transfer.setData('text/plain', ${serializedPath})
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
    return { ok: true }
  })()`)

  if (!result?.ok) {
    throw new Error(`Could not drop evidence attachment: ${JSON.stringify(result)}`)
  }

  return await waitFor(
    client,
    `Boolean(document.querySelector('[data-slot="composer-rich-input"] [data-ref-text]'))`,
    'attachment reference chip'
  )
}

async function interruptActiveTurn(client, text) {
  const before = await messageCounts(client)
  await setComposerText(client, text)
  const submittedAt = Date.now()
  const submitted = await clickComposerAction(client)

  if (!submitted?.ok) {
    throw new Error(`Interrupt turn could not be submitted: ${JSON.stringify(submitted)}`)
  }

  await waitFor(
    client,
    `document.querySelectorAll('[data-role="user"]').length > ${before.users}`,
    'interrupt turn admission',
    180_000
  )
  await waitFor(
    client,
    `Boolean([...document.querySelectorAll('button')].find(node =>
      (node.getAttribute('aria-label') || '').toLowerCase().includes('stop')
    ))`,
    'stop action',
    180_000
  )
  await delay(2_000)
  const stopped = await clickComposerAction(client, 'stop')

  if (!stopped?.ok) {
    throw new Error(`Interrupt action unavailable: ${JSON.stringify(stopped)}`)
  }

  await waitFor(
    client,
    `!Boolean([...document.querySelectorAll('button')].find(node =>
      (node.getAttribute('aria-label') || '').toLowerCase().includes('stop')
    ))`,
    'interrupted turn settlement',
    180_000
  )

  return {
    before,
    duration_ms: Date.now() - submittedAt,
    status: 'interrupted',
    stop_label: stopped.label
  }
}

function processRows() {
  const script = [
    "Get-CimInstance Win32_Process |",
    "Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath,Name |",
    "ConvertTo-Json -Compress"
  ].join(' ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true
  })

  if (result.status !== 0) {
    throw new Error(`Could not enumerate Nox process tree: ${result.stderr.trim()}`)
  }

  const parsed = JSON.parse(result.stdout || '[]')
  return Array.isArray(parsed) ? parsed : [parsed]
}

function findBackendProcess(rootPid) {
  const rows = processRows()
  const descendants = new Set([rootPid])
  let changed = true

  while (changed) {
    changed = false
    for (const row of rows) {
      if (descendants.has(Number(row.ParentProcessId)) && !descendants.has(Number(row.ProcessId))) {
        descendants.add(Number(row.ProcessId))
        changed = true
      }
    }
  }

  return rows.find(row => {
    const command = String(row.CommandLine || '').toLowerCase()
    return descendants.has(Number(row.ProcessId)) && command.includes('hermes_cli.main') && command.includes('serve')
  }) || null
}

function pathIsInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertBackendProvenance(context, rootPid, phase) {
  const backend = findBackendProcess(rootPid)

  if (!backend) {
    throw new Error(`Packaged Nox backend process was not found during ${phase}`)
  }

  const executablePath = path.resolve(String(backend.ExecutablePath || ''))
  const expectedRoot = context.sourceOverride
    ? path.resolve(context.sourceOverride)
    : path.join(path.resolve(context.noxHome), 'hermes-agent')

  if (!executablePath || !pathIsInside(executablePath, expectedRoot)) {
    throw new Error(
      `Packaged Nox selected backend outside its accepted root during ${phase}: ` +
        `${executablePath || '<missing>'} is not below ${expectedRoot}`
    )
  }

  return {
    executable_path: executablePath,
    expected_root: expectedRoot,
    parent_pid: Number(backend.ParentProcessId),
    phase,
    pid: Number(backend.ProcessId),
    source_override: Boolean(context.sourceOverride),
    status: 'pass'
  }
}

function readIdentityBinding(context, pythonPath, sessionId = null) {
  const stateDb = path.join(context.noxHome, 'state.db')

  if (!fs.existsSync(stateDb)) {
    throw new Error(`Nox state database is missing after the live journey: ${stateDb}`)
  }

  const code = [
    'import hashlib, json, sqlite3, sys',
    'connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)',
    'session_id = sys.argv[2] or None',
    'row = connection.execute("SELECT id, system_prompt, nox_identity_revision, nox_identity_chars, nox_identity_prompt_sha256 FROM sessions WHERE id = ?", (session_id,)).fetchone() if session_id else connection.execute("SELECT id, system_prompt, nox_identity_revision, nox_identity_chars, nox_identity_prompt_sha256 FROM sessions ORDER BY started_at DESC LIMIT 1").fetchone()',
    'connection.close()',
    'assert row is not None, "no live Nox session was persisted"',
    'persisted_session_id, prompt, revision, chars, prompt_hash = row',
    'assert revision and chars and prompt_hash, "latest session has no Nox identity metadata"',
    'prefix_hash = hashlib.sha256(prompt[:chars].encode("utf-8")).hexdigest()',
    'print(json.dumps({"identity_chars": chars, "identity_revision": revision, "prefix_sha256": prefix_hash, "prefix_matches": prefix_hash == prompt_hash, "session_id": persisted_session_id, "status": "pass" if prefix_hash == prompt_hash else "fail"}))'
  ].join('; ')
  const result = spawnSync(pythonPath, ['-c', code, stateDb, sessionId || ''], {
    cwd: context.workDirectory,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true
  })

  if (result.status !== 0) {
    throw new Error(`Could not verify the live Nox identity binding: ${result.stderr.trim()}`)
  }

  const binding = JSON.parse(result.stdout)
  if (binding.status !== 'pass') {
    throw new Error(`Live Nox identity prefix does not match its persisted hash: ${result.stdout.trim()}`)
  }

  return binding
}

function readResumeContinuity(context, pythonPath, sessionId) {
  const journal = path.join(context.noxHome, 'nox', 'journal.sqlite3')

  if (!fs.existsSync(journal)) {
    throw new Error(`Nox Journal is missing after restart: ${journal}`)
  }

  const code = [
    'import json, sqlite3, sys',
    'connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)',
    'rows = connection.execute("SELECT sequence, kind, process_epoch, terminal, record_json FROM bridge_records WHERE hermes_session_id = ? ORDER BY sequence", (sys.argv[2],)).fetchall()',
    'connection.close()',
    'records = [{"sequence": row[0], "kind": row[1], "process_epoch": row[2], "terminal": bool(row[3]), "reconciled_turn_ids": json.loads(row[4]).get("reconciled_turn_ids", [])} for row in rows]',
    'process_epochs = sorted({record["process_epoch"] for record in records})',
    'resume_records = [record for record in records if record["kind"] == "session.resumed"]',
    'status = "pass" if len(process_epochs) >= 2 and resume_records else "fail"',
    'print(json.dumps({"process_epochs": process_epochs, "records": records, "resume_count": len(resume_records), "session_id": sys.argv[2], "status": status}))'
  ].join('; ')
  const result = spawnSync(pythonPath, ['-c', code, journal, sessionId], {
    cwd: context.workDirectory,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true
  })

  if (result.status !== 0) {
    throw new Error(`Could not verify Nox restart continuity: ${result.stderr.trim()}`)
  }

  const continuity = JSON.parse(result.stdout)
  if (continuity.status !== 'pass') {
    throw new Error(`Nox restart did not resume the expected causal session: ${result.stdout.trim()}`)
  }

  return continuity
}

function sessionIdFromRendererUrl(value) {
  const hash = new URL(value).hash

  if (!hash.startsWith('#/')) {
    return null
  }

  return decodeURIComponent(hash.slice(2).split('/')[0].split('?')[0]) || null
}

function killProcess(pid) {
  const result = spawnSync('taskkill.exe', ['/pid', String(pid), '/f'], {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true
  })

  if (result.status !== 0) {
    throw new Error(`Could not terminate process ${pid}: ${result.stderr.trim()}`)
  }
}

function sqliteBackup(source, destination, repoRoot) {
  const code = [
    'import sqlite3, sys',
    'source = sqlite3.connect(sys.argv[1])',
    'target = sqlite3.connect(sys.argv[2])',
    'source.backup(target)',
    'target.close()',
    'source.close()'
  ].join('; ')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const result = spawnSync('uv', ['run', 'python', '-c', code, source, destination], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true
  })

  if (result.status !== 0) {
    throw new Error(`Could not back up Nox Journal: ${result.stderr.trim()}`)
  }
}

function causalAudit(journalPath, repoRoot) {
  const code = [
    'from dataclasses import asdict',
    'from pathlib import Path',
    'import json, sqlite3, sys',
    'from nox.causal_bridge import CausalJournalReader',
    'path = Path(sys.argv[1])',
    'audit = CausalJournalReader(path).verify()',
    'connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)',
    'connection.execute("PRAGMA query_only = ON")',
    'kind_counts = dict(connection.execute("SELECT kind, COUNT(*) FROM bridge_records GROUP BY kind"))',
    'process_epochs = connection.execute("SELECT COUNT(DISTINCT process_epoch) FROM bridge_records").fetchone()[0]',
    'connection.close()',
    'value = asdict(audit)',
    'value["kind_counts"] = kind_counts',
    'value["process_epoch_count"] = process_epochs',
    'terminals = {turn["terminal_status"] for turn in value["turns"]}',
    'value["acceptance"] = {"completed": "complete" in terminals, "interrupted": "interrupted" in terminals, "abandoned_after_process_loss": "abandoned" in terminals, "session_resumed": kind_counts.get("session.resumed", 0) > 0}',
    'value["status"] = "pass" if all(value["acceptance"].values()) else "fail"',
    'print(json.dumps(value, ensure_ascii=False))'
  ].join('; ')
  const result = spawnSync('uv', ['run', 'python', '-c', code, journalPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true
  })

  if (result.status !== 0) {
    throw new Error(`Independent causal audit failed: ${result.stderr.trim()}`)
  }

  const audit = JSON.parse(result.stdout)
  if (audit.status !== 'pass') {
    throw new Error(`Causal acceptance is incomplete: ${JSON.stringify(audit.acceptance)}`)
  }

  return audit
}

async function bodySnapshot(client) {
  return await client.evaluate(`(() => ({
    ariaLabels: [...document.querySelectorAll('[aria-label]')]
      .map(node => node.getAttribute('aria-label'))
      .filter(Boolean)
      .slice(0, 200),
    buttons: [...document.querySelectorAll('button')]
      .map(node => ({ aria: node.getAttribute('aria-label'), disabled: node.disabled, text: node.innerText.trim() }))
      .slice(0, 100),
    dataSlots: [...new Set([...document.querySelectorAll('[data-slot]')]
      .map(node => node.getAttribute('data-slot'))
      .filter(Boolean))].slice(0, 200),
    inputs: [...document.querySelectorAll('input')]
      .map(node => ({ accept: node.accept, aria: node.getAttribute('aria-label'), type: node.type }))
      .slice(0, 50),
    composer: document.querySelector('[data-slot="composer-rich-input"]')?.parentElement?.parentElement?.outerHTML
      .slice(0, 20000) || null,
    text: document.body.innerText.slice(0, 12000),
    title: document.title,
    url: location.href
  }))()`)
}

async function runProbe(context) {
  const launched = await launchDesktop(context)
  let client = null

  try {
    // The packaged capture hook performs one onboarding-skip reload on first
    // paint. Connect after that hand-off so CDP is bound to the live renderer
    // context rather than the short-lived pre-reload target.
    await delay(20_000)
    const connected = await connectRenderer(launched.port)
    client = connected.client
    await waitFor(client, `document.body && document.body.innerText.length > 0`, 'initial product paint')
    await waitFor(
      client,
      `Boolean(document.querySelector('[data-slot="composer-rich-input"]'))`,
      'composer',
      180_000
    )
    await waitFor(
      client,
      `document.body.innerText.includes('Gateway\\nready') || document.body.innerText.includes('GPT-5.6-sol')`,
      'gateway and model readiness',
      180_000
    )
    const provenance = assertBackendProvenance(context, launched.child.pid, 'probe')

    if (context.prompt) {
      writeJson(
        path.join(context.workDirectory, 'submission.json'),
        await submitText(client, context.prompt, 'probe turn')
      )
    } else {
      await waitFor(
        client,
        `Boolean(document.querySelector('button[aria-label="Send message"]')) ||
          document.body.innerText.includes('Gateway\\nready') ||
          document.body.innerText.includes('Gateway\\nconnected')`,
        'connected composer',
        180_000
      )
    }
    const snapshot = await bodySnapshot(client)
    const rendererSessionId = sessionIdFromRendererUrl(snapshot.url)
    const identity =
      context.expectedSessionId || context.prompt
        ? readIdentityBinding(context, provenance.executable_path, context.expectedSessionId)
        : null

    if (context.expectedSessionId) {
      if (rendererSessionId !== context.expectedSessionId) {
        throw new Error(`Renderer resumed ${rendererSessionId || 'no session'} instead of ${context.expectedSessionId}`)
      }
      if (identity?.session_id !== context.expectedSessionId) {
        throw new Error(
          `Persisted session ${identity?.session_id || 'is missing'} instead of ${context.expectedSessionId}`
        )
      }
      writeJson(path.join(context.workDirectory, 'session-resume.json'), {
        expected_session_id: context.expectedSessionId,
        identity,
        journal: readResumeContinuity(context, provenance.executable_path, context.expectedSessionId),
        renderer_session_id: rendererSessionId,
        status: 'pass'
      })
    }
    fs.writeFileSync(path.join(context.workDirectory, 'renderer-probe.json'), `${JSON.stringify(snapshot, null, 2)}\n`)
    writeJson(path.join(context.workDirectory, 'backend-provenance.json'), {
      identity,
      runtime: provenance
    })
    await capture(client, path.join(context.workDirectory, 'renderer-probe.png'))
    console.log(`renderer probe written to ${context.workDirectory}`)
  } catch (error) {
    if (client) {
      try {
        const snapshot = await bodySnapshot(client)
        fs.writeFileSync(path.join(context.workDirectory, 'renderer-failure.json'), `${JSON.stringify(snapshot, null, 2)}\n`)
        await capture(client, path.join(context.workDirectory, 'renderer-failure.png'))
      } catch {
        // Preserve the original failure below.
      }
    }
    const logs = launched.logs()
    fs.writeFileSync(path.join(context.workDirectory, 'desktop-stdout.log'), logs.stdout)
    fs.writeFileSync(path.join(context.workDirectory, 'desktop-stderr.log'), logs.stderr)
    throw error
  } finally {
    client?.close()
    killTree(launched.child.pid)
  }
}

async function runJourney(context) {
  if (!context.bundle) {
    throw new Error('--bundle is required for journey mode')
  }

  const desktopDir = path.join(context.bundle, 'desktop')
  const runtimeDir = path.join(context.bundle, 'runtime')
  const attachmentPath = path.join(context.workDirectory, 'attachment-evidence.txt')
  const wsTrace = []
  const turns = []
  const journey = {
    backend_provenance: [],
    backend_restart: null,
    desktop_restart: null,
    started_at: new Date().toISOString(),
    status: 'running'
  }
  fs.mkdirSync(desktopDir, { recursive: true })
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(
    attachmentPath,
    'NOX-DESKTOP-EVIDENCE\nThe packaged Desktop attached this file through its composer.\n',
    'utf8'
  )

  let launched = await launchDesktop(context)
  let client = null
  let finalizationError = null

  try {
    await delay(20_000)
    let connected = await connectRenderer(launched.port)
    client = connected.client
    captureWebSocketMetadata(client, wsTrace)
    await waitFor(client, `Boolean(document.querySelector('[data-slot="composer-rich-input"]'))`, 'composer', 180_000)
    await waitFor(
      client,
      `document.body.innerText.includes('Gateway\\nconnected') || document.body.innerText.includes('GPT-5.6-sol')`,
      'gateway and model readiness',
      180_000
    )
    journey.backend_provenance.push(assertBackendProvenance(context, launched.child.pid, 'initial'))
    await captureAt(client, path.join(desktopDir, 'empty-1440x900.png'), 1440, 900)

    turns.push(await submitText(client, 'Привет. Ответь одним предложением: кто ты?', 'identity turn'))
    turns.push(
      await submitText(
        client,
        'Продолжи мысль из прошлого ответа: чем для тебя просьба отличается от приказа? Ответь кратко.',
        'multi-turn continuity'
      )
    )
    await captureAt(client, path.join(desktopDir, 'conversation-1440x900.png'), 1440, 900)
    await captureAt(client, path.join(desktopDir, 'conversation-900x700.png'), 900, 700)
    await captureAt(client, path.join(desktopDir, 'conversation-400x620.png'), 400, 620)

    await setComposerText(
      client,
      '/evidence-check Проверь приложенный файл штатным terminal tool и заверши ответ маркером EVIDENCE_SKILL_USED. '
    )
    await dropInternalFile(client, attachmentPath)
    const toolBefore = await messageCounts(client)
    const toolTurn = await submitCurrentComposer(client, 'skill, tool and attachment turn', 360_000, {
      approveTools: true
    })
    await waitFor(
      client,
      `document.querySelectorAll('[data-slot="tool-block"]').length > ${toolBefore.toolBlocks}`,
      'rendered tool call',
      360_000
    )
    await waitFor(
      client,
      `document.body.innerText.includes('EVIDENCE_SKILL_USED')`,
      'skill completion marker',
      360_000
    )
    turns.push({ ...toolTurn, attachment: 'attachment-evidence.txt', skill: 'evidence-check' })
    await captureAt(client, path.join(desktopDir, 'tool-and-skill.png'), 1440, 900)

    const interrupt = await interruptActiveTurn(
      client,
      'Используй terminal tool и выполни PowerShell-команду Start-Sleep -Seconds 60; затем сообщи результат.'
    )
    writeJson(path.join(runtimeDir, 'interrupt-trace.json'), interrupt)

    const beforeRestartTurn = await messageCounts(client)
    await setComposerText(
      client,
      'Для проверки восстановления используй terminal tool: Start-Sleep -Seconds 60; затем ответь BACKEND_RESTART_DONE.'
    )
    await waitFor(
      client,
      `Boolean([...document.querySelectorAll('[data-slot="composer-root"] button')].find(node => {
        const label = (node.getAttribute('aria-label') || '').toLowerCase()
        return !node.disabled && (node.type === 'submit' || label === 'send' || label.includes('send message'))
      }))`,
      'restart turn send action',
      180_000
    )
    const restartSubmitted = await clickComposerAction(client)
    if (!restartSubmitted?.ok) {
      throw new Error(`Restart turn could not be submitted: ${JSON.stringify(restartSubmitted)}`)
    }
    await waitFor(
      client,
      `document.querySelectorAll('[data-role="user"]').length > ${beforeRestartTurn.users}`,
      'restart turn admission',
      180_000
    )
    await waitFor(
      client,
      `Boolean([...document.querySelectorAll('button')].find(node =>
        (node.getAttribute('aria-label') || '').toLowerCase().includes('stop')
      ))`,
      'restart turn active state',
      180_000
    )
    const backend = findBackendProcess(launched.child.pid)
    if (!backend) {
      throw new Error('Packaged Nox backend process was not found under the Desktop process tree')
    }
    const backendKilledAt = Date.now()
    killProcess(Number(backend.ProcessId))
    journey.backend_restart = {
      command_sha256: sha256Text(String(backend.CommandLine || '')),
      killed_pid: Number(backend.ProcessId),
      parent_pid: Number(backend.ParentProcessId),
      status: 'terminated-during-active-turn'
    }

    // The main process owns backend recovery. Give it a bounded opportunity;
    // if it exits with the backend, the following full Desktop restart is the
    // supported recovery path and still exercises the same persisted session.
    let backendRecoveredInPlace = false
    try {
      await waitFor(
        client,
        `document.body.innerText.includes('Gateway\\nconnected') &&
          Boolean(document.querySelector('[data-slot="composer-rich-input"]'))`,
        'in-place backend recovery',
        60_000
      )
      backendRecoveredInPlace = true
    } catch {
      backendRecoveredInPlace = false
    }
    journey.backend_restart.recovered_in_place = backendRecoveredInPlace
    journey.backend_restart.observation_ms = Date.now() - backendKilledAt

    const usersBeforeDesktopRestart = beforeRestartTurn.users + 1
    client.close()
    client = null
    killTree(launched.child.pid)
    const desktopRestartedAt = Date.now()
    launched = await launchDesktop(context)
    await delay(20_000)
    connected = await connectRenderer(launched.port)
    client = connected.client
    captureWebSocketMetadata(client, wsTrace)
    await waitFor(client, `Boolean(document.querySelector('[data-slot="composer-rich-input"]'))`, 'resumed composer', 180_000)
    await waitFor(
      client,
      `document.querySelectorAll('[data-role="user"]').length >= ${usersBeforeDesktopRestart}`,
      'persisted transcript after Desktop restart',
      180_000
    )
    await waitFor(
      client,
      `document.body.innerText.includes('Gateway\\nconnected') || document.body.innerText.includes('GPT-5.6-sol')`,
      'resumed gateway',
      180_000
    )
    journey.backend_provenance.push(assertBackendProvenance(context, launched.child.pid, 'desktop-restart'))
    journey.desktop_restart = {
      duration_ms: Date.now() - desktopRestartedAt,
      persisted_user_turns: (await messageCounts(client)).users,
      status: 'resumed'
    }
    await captureAt(client, path.join(desktopDir, 'resumed-after-restart.png'), 1440, 900)

    const finalSnapshot = await bodySnapshot(client)
    writeJson(path.join(context.workDirectory, 'journey-renderer.json'), finalSnapshot)
    journey.identity_binding = readIdentityBinding(
      context,
      journey.backend_provenance[journey.backend_provenance.length - 1].executable_path
    )
    journey.completed_at = new Date().toISOString()
    journey.status = 'pass'
  } catch (error) {
    journey.completed_at = new Date().toISOString()
    journey.error = error instanceof Error ? error.message : String(error)
    journey.status = 'fail'
    if (client) {
      try {
        writeJson(path.join(context.workDirectory, 'journey-failure.json'), await bodySnapshot(client))
        await capture(client, path.join(context.workDirectory, 'journey-failure.png'))
      } catch {
        // Preserve the primary failure.
      }
    }
    throw error
  } finally {
    client?.close()
    killTree(launched.child.pid)
    writeJson(path.join(context.workDirectory, 'journey.json'), journey)
    writeJson(path.join(runtimeDir, 'gateway-trace.json'), {
      frame_count: wsTrace.length,
      frames: wsTrace,
      payload_policy: 'direction, opcode, byte count and SHA-256 only; no frame bodies',
      status: wsTrace.length > 0 ? 'pass' : 'fail'
    })
    writeJson(path.join(runtimeDir, 'streaming-trace.json'), {
      status: turns.length >= 3 && turns.some(turn => turn.observed_streaming) ? 'pass' : 'fail',
      turns
    })
    writeJson(path.join(runtimeDir, 'restart-report.json'), journey)
    writeJson(path.join(runtimeDir, 'backend-provenance.json'), {
      identity: journey.identity_binding || null,
      runtimes: journey.backend_provenance
    })

    const journal = path.join(context.noxHome, 'nox', 'journal.sqlite3')
    if (fs.existsSync(journal)) {
      const evidenceJournal = path.join(runtimeDir, 'nox-journal.sqlite')
      sqliteBackup(journal, evidenceJournal, context.repoRoot)
      try {
        writeJson(path.join(runtimeDir, 'causal-correlation.json'), causalAudit(evidenceJournal, context.repoRoot))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeJson(path.join(runtimeDir, 'causal-correlation.json'), {
          error: message,
          status: 'fail'
        })
        if (journey.status === 'pass') {
          journey.error = message
          journey.status = 'fail'
          writeJson(path.join(context.workDirectory, 'journey.json'), journey)
          writeJson(path.join(runtimeDir, 'restart-report.json'), journey)
          finalizationError = error
        }
      }
    }
  }

  if (finalizationError) {
    throw finalizationError
  }
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Packaged Desktop evidence currently requires Windows')
  }

  const args = parseArgs(process.argv.slice(2))
  const repoRoot = requiredPath(args.repo, 'repo')
  const packageDirectory = requiredPath(args.package, 'package')
  const noxHome = requiredPath(args.home, 'home')
  const sourceOverride = args['source-override']
    ? requiredPath(args['source-override'], 'source-override')
    : null
  const workDirectory = path.resolve(args.work || path.join(repoRoot, 'artifacts', 'evidence-work', 'desktop'))
  const executable = requiredPath(path.join(packageDirectory, 'Nox.exe'), 'package/Nox.exe', 'file')
  const userData = path.join(workDirectory, 'user-data')
  fs.mkdirSync(workDirectory, { recursive: true })

  const context = {
    executable,
    expectedSessionId: args.session || null,
    noxHome,
    prompt: args.prompt || null,
    repoRoot,
    sourceOverride,
    userData,
    workDirectory
  }
  const mode = args.mode || 'probe'

  if (mode === 'probe') {
    await runProbe(context)
    return
  }


  if (mode === 'journey') {
    context.bundle = requiredPath(args.bundle, 'bundle')
    await runJourney(context)
    return
  }

  throw new Error(`Unsupported mode: ${mode}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
