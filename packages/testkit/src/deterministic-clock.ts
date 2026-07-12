import type { ClockPort } from '@nox/runtime'

export class DeterministicClock implements ClockPort {
  #current: string

  constructor(initial: string) {
    this.#current = new Date(initial).toISOString()
  }

  advanceTo(value: string): void {
    const next = new Date(value).toISOString()
    if (next < this.#current) {
      throw new Error(`Deterministic clock cannot regress from ${this.#current} to ${next}`)
    }
    this.#current = next
  }

  now(): string {
    return this.#current
  }
}
