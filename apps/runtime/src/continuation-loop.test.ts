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
})
