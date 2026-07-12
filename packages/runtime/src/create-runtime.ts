import { NoxRuntime } from './nox-runtime.js'
import type { NoxRuntimeOptions } from './nox-runtime.js'

export function createRuntime(options: NoxRuntimeOptions): NoxRuntime {
  return new NoxRuntime(options)
}
