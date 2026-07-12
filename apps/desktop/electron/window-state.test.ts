import { describe, expect, it, vi } from 'vitest'

import { computeWindowOptions, debounce, sanitizeWindowState } from './window-state.js'

describe('Hermes-derived window geometry', () => {
  it('drops off-screen coordinates while retaining a bounded size', () => {
    const state = sanitizeWindowState({ height: 900, isMaximized: false, width: 1400, x: 9000, y: 9000 })
    expect(computeWindowOptions(state, [{ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }])).toEqual({
      height: 900,
      width: 1400
    })
  })

  it('cancels trailing window-state work when its BrowserWindow lifecycle ends', () => {
    vi.useFakeTimers()
    try {
      const write = vi.fn()
      const save = debounce(write, 250)
      save()
      save.cancel()
      vi.advanceTimersByTime(250)
      expect(write).not.toHaveBeenCalled()

      save()
      save.flush()
      vi.advanceTimersByTime(250)
      expect(write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
