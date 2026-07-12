import { describe, expect, it } from 'vitest'

import { computeWindowOptions, sanitizeWindowState } from './window-state.js'

describe('Hermes-derived window geometry', () => {
  it('drops off-screen coordinates while retaining a bounded size', () => {
    const state = sanitizeWindowState({ height: 900, isMaximized: false, width: 1400, x: 9000, y: 9000 })
    expect(computeWindowOptions(state, [{ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }])).toEqual({
      height: 900,
      width: 1400
    })
  })
})
