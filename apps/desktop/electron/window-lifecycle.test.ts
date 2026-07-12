import { describe, expect, it, vi } from 'vitest'

import { sendToLiveWindow } from './window-lifecycle.js'

describe('Desktop window lifecycle fence', () => {
  it('never sends through a destroyed BrowserWindow or webContents', () => {
    const send = vi.fn()
    const window = {
      isDestroyed: vi.fn(() => false),
      webContents: { isDestroyed: vi.fn(() => false), send }
    }
    expect(sendToLiveWindow(window, 'nox:event', { value: 1 })).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)

    window.isDestroyed.mockReturnValue(true)
    expect(sendToLiveWindow(window, 'nox:event', { value: 2 })).toBe(false)
    window.isDestroyed.mockReturnValue(false)
    window.webContents.isDestroyed.mockReturnValue(true)
    expect(sendToLiveWindow(window, 'nox:event', { value: 3 })).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
