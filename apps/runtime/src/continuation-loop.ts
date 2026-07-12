export interface ContinuationLoopRuntime {
  fireDueContinuations(): Promise<unknown>
}

export interface ContinuationLoop {
  stop(): Promise<void>
}

export interface ContinuationLoopOptions {
  failureCooldownMilliseconds?: number
  intervalMilliseconds?: number
  onError?: (error: unknown) => Promise<void> | void
}

export function startContinuationLoop(
  runtime: ContinuationLoopRuntime,
  options: ContinuationLoopOptions = {}
): ContinuationLoop {
  const intervalMilliseconds = options.intervalMilliseconds ?? 250
  const failureCooldownMilliseconds = options.failureCooldownMilliseconds ?? 5_000
  if (!Number.isInteger(intervalMilliseconds) || intervalMilliseconds < 1) {
    throw new Error('Continuation loop interval must be a positive integer')
  }

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> = Promise.resolve()
  let lastFailure = ''
  let lastFailureAt = Number.NEGATIVE_INFINITY

  const schedule = (): void => {
    if (stopped) {
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      inFlight = pump()
    }, intervalMilliseconds)
  }

  const pump = async (): Promise<void> => {
    if (stopped) {
      return
    }
    try {
      await runtime.fireDueContinuations()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const observedAt = Date.now()
      if (message !== lastFailure || observedAt - lastFailureAt >= failureCooldownMilliseconds) {
        lastFailure = message
        lastFailureAt = observedAt
        await options.onError?.(error)
      }
    } finally {
      schedule()
    }
  }

  inFlight = pump()

  return {
    stop: async () => {
      stopped = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      await inFlight
    }
  }
}
