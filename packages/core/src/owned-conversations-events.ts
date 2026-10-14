import type { AnyEvent } from "@amira/api"
import type { EventBus } from "./event-bus.ts"

/** Each iterator has its own bounded EventBus queue, including subscriber-local loss markers. */
export class ConversationEvents implements AsyncIterable<AnyEvent> {
  #bus: EventBus
  #closed = false
  #iterators = new Set<() => void>()

  constructor(bus: EventBus) {
    this.#bus = bus
  }

  [Symbol.asyncIterator](): AsyncIterator<AnyEvent> {
    let closed = this.#closed
    let pending: { event: AnyEvent; acknowledge: () => void } | undefined
    let wake: (() => void) | undefined
    const off = closed
      ? () => {}
      : this.#bus.subscribe(
          (event) =>
            new Promise<void>((acknowledge) => {
              pending = { event, acknowledge }
              wake?.()
            }),
        )
    const close = () => {
      closed = true
      off()
      pending?.acknowledge()
      pending = undefined
      wake?.()
      this.#iterators.delete(close)
    }
    if (!closed) this.#iterators.add(close)
    return {
      async next() {
        while (!closed) {
          if (pending) {
            const { event, acknowledge } = pending
            pending = undefined
            acknowledge()
            return { value: event, done: false }
          }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          wake = undefined
        }
        return { value: undefined, done: true }
      },
      async return() {
        close()
        return { value: undefined, done: true }
      },
    }
  }

  close(): void {
    this.#closed = true
    for (const close of this.#iterators) close()
  }
}
