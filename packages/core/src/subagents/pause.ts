import type { ModelError } from "@amira/ai"

/** A cooperative hold between calls: never interrupts the model or a running tool. */
export class PauseGate {
  /** Network-failure teardown closes model admission without aborting running tools. */
  modelFailure: ModelError | undefined
  #modelAbort = new AbortController()
  #held: { done: Promise<void>; release: () => void } | undefined
  /** A tree yields only inside tool waits and reacquires before any further model work. */
  onTools:
    | { waiting: () => void; returned: () => void; ready: (signal: AbortSignal) => Promise<void> | undefined }
    | undefined

  failModel(error: ModelError): void {
    this.modelFailure ??= error
    this.#modelAbort.abort()
    this.resume()
  }

  async tools(run: () => Promise<void>): Promise<void> {
    this.onTools?.waiting()
    try {
      await run()
    } finally {
      this.onTools?.returned()
    }
  }

  /** Re-enter before context preparation too: it may call a model for compaction. */
  beforeModel(signal: AbortSignal): Promise<void> | undefined {
    if (this.modelFailure) return
    signal = AbortSignal.any([signal, this.#modelAbort.signal])
    // Preserve synchronous steering preparation unless there is a real pause or admission wait.
    // A user pause keeps its slot until resumed, even when the tools have returned.
    if (this.paused)
      return this.wait(signal).then(() => {
        if (!signal.aborted) return this.onTools?.ready(signal)
      })
    if (!signal.aborted) return this.onTools?.ready(signal)
  }

  get paused(): boolean {
    return this.#held !== undefined
  }

  pause(): boolean {
    if (this.#held || this.modelFailure) return false
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

  /** Waits while paused; true when `signal` aborted (at once when not paused). */
  async wait(signal: AbortSignal): Promise<boolean> {
    if (!this.#held) return signal.aborted
    const { promise: aborted, resolve } = Promise.withResolvers<void>()
    const onAbort = () => resolve()
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      // A resume followed immediately by another pause must not let the waiter through.
      while (this.#held && !signal.aborted) await Promise.race([this.#held.done, aborted])
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
    return signal.aborted
  }
}
