import { NoxRpcServer } from '@nox/interface-rpc'
import type { RpcRuntimePort } from '@nox/interface-rpc'

export interface ProcessHostOptions {
  interfaceOwnerId: string
  launchToken: string
  runtime: RpcRuntimePort
}

export interface ProcessHost {
  close(): Promise<void>
  port: number
}

export async function createProcessHost(options: ProcessHostOptions): Promise<ProcessHost> {
  const server = new NoxRpcServer(options)
  const port = await server.ready()
  return { close: () => server.close(), port }
}
