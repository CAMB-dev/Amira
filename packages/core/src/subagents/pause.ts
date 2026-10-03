/** A cooperative hold between calls: never interrupts the model or a running tool. */
export class PauseGate {
  #held: { done: Promise<void>; release: () => void } | undefined

  get paused(): boolean {
    return this.#held !== undefined
  }

  pause(): boolean {
    if (this.#held) return false
    const { promise: done, resolve: release } = Promise.withResolvers<void>()
    this.#held = { done, release }
    return true
  }

  resume(): boolean {
    const held = this.#held
    if (!held) return false
    this.#held = undefined
    held.release()
    return true
  }

  async wait(signal: AbortSignal): Promise<void> {
    const { promise: aborted, resolve } = Promise.withResolvers<void>()
    const onAbort = () => resolve()
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      // A resume followed immediately by another pause must not let the waiter through.
      while (this.#held && !signal.aborted) await Promise.race([this.#held.done, aborted])
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }
}
