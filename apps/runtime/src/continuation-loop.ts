export interface ContinuationLoopRuntime {
  fireDueContinuations(): Promise<unknown>
}

export interface ContinuationLoop {
  stop(): Promise<void>
}

export interface ContinuationLoopOptions {
  intervalMilliseconds?: number
  onError?: (error: unknown) => void
}

export function startContinuationLoop(
  runtime: ContinuationLoopRuntime,
  options: ContinuationLoopOptions = {}
): ContinuationLoop {
  const intervalMilliseconds = options.intervalMilliseconds ?? 250
  if (!Number.isInteger(intervalMilliseconds) || intervalMilliseconds < 1) {
    throw new Error('Continuation loop interval must be a positive integer')
  }

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> = Promise.resolve()

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
      options.onError?.(error)
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
