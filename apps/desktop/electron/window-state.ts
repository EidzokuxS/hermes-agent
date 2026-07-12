/**
 * Pure geometry helpers for window-state.json — restoring the main window's
 * size, position, and maximized flag across launches. Side-effect-free so the
 * part that actually matters (rejecting garbage + off-screen bounds) is
 * unit-testable without booting Electron; main.ts owns the file I/O and the
 * live `screen` displays.
 */

// Defaults mirror the historical hardcoded BrowserWindow size; MIN_* mirror its
// minWidth/minHeight so a restored size never undershoots what the live window
// allows. A fresh install (no saved state) is byte-identical to before.
const DEFAULT_WIDTH = 1220
const DEFAULT_HEIGHT = 800
const MIN_WIDTH = 400
const MIN_HEIGHT = 620

// Keep at least this much of the window over a display work area before we trust
// a saved position, so the title bar stays grabbable after a monitor unplugs.
const MIN_VISIBLE = 48

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const clamp = (value: number, lower: number, upper: number): number => Math.max(lower, Math.min(value, upper))

interface DisplayLike {
  workArea: { height: number; width: number; x: number; y: number }
}

interface SanitizedWindowState {
  width: number
  height: number
  isMaximized: boolean
  x?: number
  y?: number
}

// Parse raw JSON → clean state, or null if garbage. width/height are required
// and floored; x/y survive only as a finite pair; isMaximized is strict.
function sanitizeWindowState(raw?: unknown): SanitizedWindowState | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const value = raw as Record<string, unknown>
  if (!finite(value.width) || !finite(value.height)) {
    return null
  }

  const state: SanitizedWindowState = {
    width: Math.max(MIN_WIDTH, Math.round(value.width)),
    height: Math.max(MIN_HEIGHT, Math.round(value.height)),
    isMaximized: value.isMaximized === true
  }

  if (finite(value.x) && finite(value.y)) {
    state.x = Math.round(value.x)
    state.y = Math.round(value.y)
  }

  return state
}

// True when `bounds` overlaps some display's work area by ≥ MIN_VISIBLE on both
// axes. `displays` is Electron's screen.getAllDisplays() shape.
function onScreen(
  bounds: { height: number; width: number; x: number; y: number },
  displays: readonly DisplayLike[] | unknown
): boolean {
  if (!Array.isArray(displays)) {
    return false
  }

  return displays.some(({ workArea: a }) => {
    const x = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x)
    const y = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y)

    return x >= MIN_VISIBLE && y >= MIN_VISIBLE
  })
}

interface WindowOptions {
  width: number
  height: number
  x?: number
  y?: number
}

// Sanitized state (or null) → BrowserWindow size/position options. Always sets
// width/height, capped to the largest current display so a size saved on a
// since-disconnected bigger monitor can't exceed any screen the user now has.
// Sets x/y only when still on-screen; otherwise Electron centers the window.
function computeWindowOptions(
  state: SanitizedWindowState | null,
  displays: readonly DisplayLike[] | unknown
): WindowOptions {
  const opts: WindowOptions = {
    width: finite(state?.width) ? state.width : DEFAULT_WIDTH,
    height: finite(state?.height) ? state.height : DEFAULT_HEIGHT
  }

  const safeDisplays = Array.isArray(displays) ? (displays as DisplayLike[]) : []
  const cap = safeDisplays.reduce(
    (maximum, { workArea }) =>
      finite(workArea.width) && finite(workArea.height)
        ? { width: Math.max(maximum.width, workArea.width), height: Math.max(maximum.height, workArea.height) }
        : maximum,
    { width: 0, height: 0 }
  )

  if (cap.width && cap.height) {
    opts.width = clamp(opts.width, MIN_WIDTH, cap.width)
    opts.height = clamp(opts.height, MIN_HEIGHT, cap.height)
  }

  if (
    state &&
    finite(state.x) &&
    finite(state.y) &&
    onScreen({ x: state.x, y: state.y, width: opts.width, height: opts.height }, displays)
  ) {
    opts.x = state.x
    opts.y = state.y
  }

  return opts
}

// Trailing debounce: collapse a burst of resize/move events (Linux fires many
// mid-drag) into a single run `delayMs` after the last. `.flush()` runs now and
// cancels the pending timer — used on close, before the window is gone.
function debounce(fn: () => void, delayMs: number): (() => void) & { flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined

  const debounced = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      timer = undefined
      fn()
    }, delayMs)
  }

  debounced.flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    timer = undefined
    fn()
  }

  return debounced
}

export {
  computeWindowOptions,
  debounce,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_VISIBLE,
  MIN_WIDTH,
  onScreen,
  sanitizeWindowState
}
