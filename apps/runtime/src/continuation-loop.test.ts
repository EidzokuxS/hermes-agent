import { describe, expect, it, vi } from 'vitest'

import { startContinuationLoop } from './continuation-loop.js'

describe('production Continuation loop', () => {
  it('fires immediately, repeats while running, and cancels its timer on shutdown', async () => {
    vi.useFakeTimers()
    try {
      const fireDueContinuations = vi.fn(async () => [])
      const loop = startContinuationLoop({ fireDueContinuations }, { intervalMilliseconds: 25 })
      await vi.advanceTimersByTimeAsync(0)
      expect(fireDueContinuations).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(75)
      expect(fireDueContinuations).toHaveBeenCalledTimes(4)

      await loop.stop()
      await vi.advanceTimersByTimeAsync(100)
      expect(fireDueContinuations).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rate-limits repeated failure diagnostics while continuing to poll', async () => {
    vi.useFakeTimers()
    try {
      const onError = vi.fn()
      const loop = startContinuationLoop(
        { fireDueContinuations: vi.fn(async () => Promise.reject(new Error('store unavailable'))) },
        { failureCooldownMilliseconds: 100, intervalMilliseconds: 25, onError }
      )
      await vi.advanceTimersByTimeAsync(75)
      expect(onError).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(50)
      expect(onError).toHaveBeenCalledTimes(2)
      await loop.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
