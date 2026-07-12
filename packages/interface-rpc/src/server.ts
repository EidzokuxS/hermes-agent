/// <reference types="node" />

import { timingSafeEqual } from 'node:crypto'

import { interfaceEmissionSchema, interfaceEventSchema, PROTOCOL_VERSION, viewSnapshotSchema } from '@nox/protocol'
import type {
  Event,
  EventReceipt,
  InterfaceEmission,
  InterfaceEvent,
  JournalRecord,
  JsonValue,
  StateSnapshot,
  ViewSnapshot
} from '@nox/protocol'
import { WebSocketServer } from 'ws'
import type { RawData, VerifyClientCallbackSync, WebSocket } from 'ws'

import { encodeFrame, errorResponse, eventNotification, parseRpcRequest, RpcFault, successResponse } from './frames.js'

export interface RpcRuntimePort {
  appendEvent(input: {
    clientEventId: string
    content: string
    format: 'markdown' | 'text'
    interfaceOwnerId: string
  }): Promise<EventReceipt>
  cancelAct(actId: string, reason: string): Promise<boolean>
  journal(afterSequence?: number): Promise<JournalRecord[]>
  releaseEvent(eventId: string): Promise<void>
  snapshot(): Promise<StateSnapshot>
  unresolvedReceipts(interfaceOwnerId: string): Promise<EventReceipt[]>
}

export interface OrderedConnection {
  close(code: number, reason: string): void
  sendText(text: string): Promise<void>
}

export interface RpcSessionOptions {
  connection: OrderedConnection
  interfaceOwnerId: string
  maxPendingFrames?: number
  runtime: RpcRuntimePort
}

function projectEvents(records: JournalRecord[]): Event[] {
  const events = new Map<string, Event>()
  for (const record of records) {
    if (record.entry.kind === 'event.recorded') {
      events.set(record.entry.event.eventId, record.entry.event)
    } else if (record.entry.kind === 'event.admitted') {
      const event = events.get(record.entry.eventId)
      if (event?.kind === 'external') {
        events.set(event.eventId, { ...event, admission: 'admitted' })
      }
    }
  }
  return [...events.values()]
}

function emissionFromRecord(record: JournalRecord): InterfaceEmission | undefined {
  if (
    record.entry.kind !== 'effect.decision' ||
    record.entry.decision.decision !== 'accepted' ||
    record.entry.decision.effect.kind !== 'emission.append'
  ) {
    return undefined
  }
  const decision = record.entry.decision
  const effect = decision.effect
  if (effect.kind !== 'emission.append') {
    return undefined
  }
  return interfaceEmissionSchema.parse({
    actId: decision.actId,
    content: effect.content,
    effectId: decision.effectId,
    emissionId: `emission:${decision.effectId}`,
    format: effect.format,
    journalSequence: record.sequence,
    occurredAt: record.recordedAt
  })
}

export function projectInterfaceEvents(records: JournalRecord[]): InterfaceEvent[] {
  const events: InterfaceEvent[] = []
  for (const record of records) {
    const envelope = {
      interfaceEventId: `interface:${record.recordId}`,
      journalSequence: record.sequence,
      observedAt: record.recordedAt,
      protocolVersion: PROTOCOL_VERSION
    }
    if (record.entry.kind === 'event.admitted') {
      events.push(interfaceEventSchema.parse({ ...envelope, eventId: record.entry.eventId, kind: 'event.admitted' }))
    } else if (record.entry.kind === 'act.started') {
      events.push(interfaceEventSchema.parse({ ...envelope, act: record.entry.act, kind: 'act.started' }))
    } else if (record.entry.kind === 'act.terminal') {
      events.push(interfaceEventSchema.parse({ ...envelope, act: record.entry.terminal, kind: 'act.terminal' }))
    } else if (record.entry.kind === 'state.advanced') {
      events.push(
        interfaceEventSchema.parse({
          ...envelope,
          kind: 'state.advanced',
          stateHash: record.entry.stateHash,
          stateVersion: record.entry.stateVersion
        })
      )
    } else {
      const emission = emissionFromRecord(record)
      if (emission !== undefined) {
        events.push(interfaceEventSchema.parse({ ...envelope, emission, kind: 'emission.appended' }))
      }
    }
  }
  return events
}

async function buildView(runtime: RpcRuntimePort, interfaceOwnerId: string): Promise<ViewSnapshot> {
  const [state, records, unresolvedReceipts] = await Promise.all([
    runtime.snapshot(),
    runtime.journal(),
    runtime.unresolvedReceipts(interfaceOwnerId)
  ])
  const running = new Map<string, Extract<InterfaceEvent, { kind: 'act.started' }>['act']>()
  for (const record of records) {
    if (record.entry.kind === 'act.started') {
      running.set(record.entry.act.actId, record.entry.act)
    } else if (record.entry.kind === 'act.terminal') {
      running.delete(record.entry.terminal.actId)
    }
  }
  return viewSnapshotSchema.parse({
    ...([...running.values()][0] === undefined ? {} : { currentAct: [...running.values()][0] }),
    emissions: records
      .flatMap(record => {
        const emission = emissionFromRecord(record)
        return emission === undefined ? [] : [emission]
      })
      .slice(-512),
    events: projectEvents(records).slice(-512),
    interfaceOwnerId,
    journalCursor: records.at(-1)?.sequence ?? 0,
    openContinuations: state.state.openContinuations,
    protocolVersion: PROTOCOL_VERSION,
    state,
    unresolvedReceipts
  })
}

export class RpcSession {
  readonly #connection: OrderedConnection
  readonly #interfaceOwnerId: string
  readonly #maxPendingFrames: number
  readonly #runtime: RpcRuntimePort
  #pending = 0
  #tail: Promise<void> = Promise.resolve()

  constructor(options: RpcSessionOptions) {
    this.#connection = options.connection
    this.#interfaceOwnerId = options.interfaceOwnerId
    this.#maxPendingFrames = options.maxPendingFrames ?? 256
    this.#runtime = options.runtime
  }

  handleText(text: string): Promise<void> {
    if (this.#pending >= this.#maxPendingFrames) {
      this.#connection.close(1013, 'Nox subscription buffer exceeded')
      return Promise.reject(new Error('Nox RPC pending-frame bound exceeded'))
    }
    this.#pending += 1
    const run = this.#tail.then(() => this.#process(text))
    this.#tail = run.then(
      () => undefined,
      () => undefined
    )
    return run.finally(() => {
      this.#pending -= 1
    })
  }

  async #process(text: string): Promise<void> {
    let request
    let responseFlushed = false
    try {
      request = parseRpcRequest(text)
    } catch (error) {
      const fault = error instanceof RpcFault ? error : new RpcFault(-32600, String(error))
      await this.#connection.sendText(encodeFrame(errorResponse(null, fault)))
      return
    }

    try {
      if (request.call.method === 'event.append') {
        const receipt = await this.#runtime.appendEvent({
          clientEventId: request.call.params.clientEventId,
          content: request.call.params.content.content,
          format: request.call.params.content.format,
          interfaceOwnerId: this.#interfaceOwnerId
        })
        await this.#connection.sendText(
          encodeFrame(
            successResponse(request.id, {
              protocolVersion: PROTOCOL_VERSION,
              receipt
            } as unknown as JsonValue)
          )
        )
        responseFlushed = true
        await this.#runtime.releaseEvent(receipt.eventId)
        return
      }
      if (request.call.method === 'view.snapshot') {
        const view = await buildView(this.#runtime, this.#interfaceOwnerId)
        await this.#connection.sendText(encodeFrame(successResponse(request.id, view as unknown as JsonValue)))
        responseFlushed = true
        for (const receipt of view.unresolvedReceipts) {
          await this.#runtime.releaseEvent(receipt.eventId)
        }
        return
      }
      if (request.call.method === 'journal.subscribe') {
        const records = await this.#runtime.journal(request.call.params.afterSequence)
        await this.#connection.sendText(
          encodeFrame(
            successResponse(request.id, {
              journalCursor: records.at(-1)?.sequence ?? request.call.params.afterSequence,
              protocolVersion: PROTOCOL_VERSION,
              subscribed: true
            })
          )
        )
        responseFlushed = true
        for (const event of projectInterfaceEvents(records)) {
          await this.#connection.sendText(encodeFrame(eventNotification(event)))
        }
        return
      }
      const cancelled = await this.#runtime.cancelAct(request.call.params.actId, request.call.params.reason)
      await this.#connection.sendText(
        encodeFrame(
          successResponse(request.id, {
            actId: request.call.params.actId,
            protocolVersion: PROTOCOL_VERSION,
            requested: cancelled
          })
        )
      )
      responseFlushed = true
    } catch (error) {
      if (responseFlushed) {
        throw error
      }
      const fault = new RpcFault(-32_000, error instanceof Error ? error.message : String(error))
      await this.#connection.sendText(encodeFrame(errorResponse(request.id, fault)))
    }
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : ''
  const left = Buffer.from(supplied)
  const right = Buffer.from(token)
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

export interface NoxRpcServerOptions {
  interfaceOwnerId: string
  launchToken: string
  port?: number
  runtime: RpcRuntimePort
}

export class NoxRpcServer {
  readonly #server: WebSocketServer

  constructor(options: NoxRpcServerOptions) {
    const verifyClient: VerifyClientCallbackSync = ({ req }) =>
      tokenMatches(req.headers.authorization, options.launchToken)
    this.#server = new WebSocketServer({
      host: '127.0.0.1',
      port: options.port ?? 0,
      verifyClient
    })
    this.#server.on('connection', socket => {
      const connection: OrderedConnection = {
        close: (code, reason) => socket.close(code, reason),
        sendText: text =>
          new Promise<void>((resolve, reject) => {
            socket.send(text, error => (error === undefined || error === null ? resolve() : reject(error)))
          })
      }
      const session = new RpcSession({
        connection,
        interfaceOwnerId: options.interfaceOwnerId,
        runtime: options.runtime
      })
      socket.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          socket.close(1003, 'Binary frames are not supported')
          return
        }
        void session.handleText(data.toString()).catch(() => socket.close(1011, 'RPC failure'))
      })
    })
  }

  async ready(): Promise<number> {
    if (this.#server.address() === null) {
      await new Promise<void>((resolve, reject) => {
        this.#server.once('listening', resolve)
        this.#server.once('error', reject)
      })
    }
    const address = this.#server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('Nox RPC server has no TCP address')
    }
    return address.port
  }

  async close(): Promise<void> {
    for (const client of this.#server.clients as Set<WebSocket>) {
      client.close(1001, 'Nox runtime shutting down')
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.close(error => (error === undefined || error === null ? resolve() : reject(error)))
    })
  }
}
