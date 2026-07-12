import { domainCallSchema, interfaceEventSchema, PROTOCOL_VERSION } from '@nox/protocol'
import type { DomainCall, InterfaceEvent, JsonValue } from '@nox/protocol'

export type RpcId = number | string

export interface RpcRequest {
  call: DomainCall
  id: RpcId
  jsonrpc: '2.0'
}

export interface RpcErrorData {
  code: number
  data?: JsonValue
  message: string
}

export interface RpcResponse {
  error?: RpcErrorData
  id: RpcId | null
  jsonrpc: '2.0'
  result?: JsonValue
}

export interface RpcNotification {
  jsonrpc: '2.0'
  method: 'nox.event'
  params: InterfaceEvent
}

export class RpcFault extends Error {
  readonly code: number
  readonly data?: JsonValue

  constructor(code: number, message: string, data?: JsonValue) {
    super(message)
    this.code = code
    if (data !== undefined) {
      this.data = data
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRpcRequest(text: string): RpcRequest {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new RpcFault(-32700, 'Invalid JSON')
  }
  if (!isObject(value) || value.jsonrpc !== '2.0' || !('id' in value)) {
    throw new RpcFault(-32600, 'Invalid JSON-RPC request')
  }
  if (typeof value.id !== 'string' && typeof value.id !== 'number') {
    throw new RpcFault(-32600, 'JSON-RPC id must be a string or number')
  }
  if (typeof value.method !== 'string' || !isObject(value.params)) {
    throw new RpcFault(-32600, 'JSON-RPC method and params are required')
  }
  if (value.params.protocolVersion !== PROTOCOL_VERSION) {
    throw new RpcFault(-32_001, 'Incompatible Nox protocol version', {
      expected: PROTOCOL_VERSION,
      received: typeof value.params.protocolVersion === 'number' ? value.params.protocolVersion : null
    })
  }
  const parsed = domainCallSchema.safeParse({ method: value.method, params: value.params })
  if (!parsed.success) {
    throw new RpcFault(-32602, 'Invalid Nox domain parameters', {
      issues: parsed.error.issues.map(({ message, path }) => ({ message, path }))
    } as JsonValue)
  }
  return { call: parsed.data, id: value.id, jsonrpc: '2.0' }
}

export function parseRpcResponse(text: string): RpcResponse | RpcNotification {
  const value = JSON.parse(text) as unknown
  if (!isObject(value) || value.jsonrpc !== '2.0') {
    throw new RpcFault(-32600, 'Invalid JSON-RPC frame')
  }
  if (value.method === 'nox.event') {
    return {
      jsonrpc: '2.0',
      method: 'nox.event',
      params: interfaceEventSchema.parse(value.params)
    }
  }
  if (
    (value.id !== null && typeof value.id !== 'string' && typeof value.id !== 'number') ||
    (!('result' in value) && !('error' in value))
  ) {
    throw new RpcFault(-32600, 'Invalid JSON-RPC response')
  }
  return value as unknown as RpcResponse
}

export function successResponse(id: RpcId, result: JsonValue): RpcResponse {
  return { id, jsonrpc: '2.0', result }
}

export function errorResponse(id: RpcId | null, error: RpcFault): RpcResponse {
  return {
    error: {
      code: error.code,
      ...(error.data === undefined ? {} : { data: error.data }),
      message: error.message
    },
    id,
    jsonrpc: '2.0'
  }
}

export function eventNotification(event: InterfaceEvent): RpcNotification {
  return { jsonrpc: '2.0', method: 'nox.event', params: event }
}

export function encodeFrame(frame: RpcResponse | RpcNotification): string {
  return JSON.stringify(frame)
}
