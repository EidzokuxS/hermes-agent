import type { ClockPort } from '../../src/index.js'

export class DeterministicClock implements ClockPort {
  #current: string

  constructor(initial: string) {
    this.#current = initial
  }

  advanceTo(next: string): void {
    this.#current = next
  }

  now(): string {
    return this.#current
  }
}
