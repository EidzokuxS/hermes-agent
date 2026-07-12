/// <reference types="node" />

import type { DomainCall, InterfaceEvent, JsonValue } from '@nox/protocol'
import WebSocket from 'ws'

import { parseRpcResponse, RpcFault } from './frames.js'
import type { RpcId } from './frames.js'

export interface NoxRpcClientOptions {
  launchToken: string
  url: string
}

export class NoxRpcClient {
  readonly #listeners = new Set<(event: InterfaceEvent) => void>()
  readonly #pending = new Map<RpcId, { reject: (error: Error) => void; resolve: (value: JsonValue) => void }>()
  readonly #socket: WebSocket
  #nextId = 0

  constructor(options: NoxRpcClientOptions) {
    this.#socket = new WebSocket(options.url, {
      headers: { Authorization: `Bearer ${options.launchToken}` }
    })
    this.#socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.#socket.close(1003, 'Binary frame rejected')
        return
      }
      const frame = parseRpcResponse(data.toString())
      if ('method' in frame) {
        for (const listener of this.#listeners) {
          listener(frame.params)
        }
        return
      }
      if (frame.id === null) {
        return
      }
      const pending = this.#pending.get(frame.id)
      if (pending === undefined) {
        return
      }
      this.#pending.delete(frame.id)
      if (frame.error !== undefined) {
        pending.reject(new RpcFault(frame.error.code, frame.error.message, frame.error.data))
      } else {
        pending.resolve(frame.result ?? null)
      }
    })
    this.#socket.on('close', () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error('Nox RPC connection closed'))
      }
      this.#pending.clear()
    })
  }

  async ready(): Promise<void> {
    if (this.#socket.readyState === WebSocket.OPEN) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.#socket.once('open', resolve)
      this.#socket.once('error', reject)
    })
  }

  async call(call: DomainCall): Promise<JsonValue> {
    await this.ready()
    const id = `rpc-${(this.#nextId += 1)}`
    const result = new Promise<JsonValue>((resolve, reject) => {
      this.#pending.set(id, { reject, resolve })
    })
    await new Promise<void>((resolve, reject) => {
      this.#socket.send(JSON.stringify({ id, jsonrpc: '2.0', method: call.method, params: call.params }), error =>
        error === undefined || error === null ? resolve() : reject(error)
      )
    })
    return result
  }

  subscribe(listener: (event: InterfaceEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) {
      return
    }
    await new Promise<void>(resolve => {
      this.#socket.once('close', () => resolve())
      this.#socket.close(1000, 'Nox RPC client closed')
    })
  }
}
