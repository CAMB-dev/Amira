import type { PendingNotice, UserMessage } from "@amira/api"

const COMPLETION_BATCH_MS = 100

interface Batch<T> {
  items: T[]
  notices: PendingNotice[]
  timer: ReturnType<typeof setTimeout>
}

/** Fixed per-owner completion windows, shared by ordinary jobs and monitors. */
export class CompletionBatches<T> {
  #batches = new Map<object | string, Batch<T>>()
  #render: (items: T[]) => UserMessage

  constructor(render: (items: T[]) => UserMessage) {
    this.#render = render
  }

  /** A lazy reservation is made once per batch; existing monitor leases are all retained. */
  add(owner: object | string, item: T, reservation: PendingNotice | (() => PendingNotice | undefined)): void {
    const batch = this.#batches.get(owner)
    const notice = typeof reservation === "function" ? (batch ? undefined : reservation()) : reservation
    if (batch) {
      batch.items.push(item)
      if (notice) batch.notices.push(notice)
      return
    }
    if (!notice) return
    const next: Batch<T> = {
      items: [item],
      notices: [notice],
      timer: setTimeout(() => this.#flush(owner), COMPLETION_BATCH_MS),
    }
    this.#batches.set(owner, next)
  }

  #flush(owner: object | string) {
    const batch = this.#batches.get(owner)
    if (!batch) return
    this.#batches.delete(owner)
    const [first, ...rest] = batch.notices
    try {
      const message = this.#render(batch.items)
      // Leave exactly the delivering lease outstanding before waking an idle owner.
      for (const notice of rest) notice.cancel()
      first!.deliver(message, { wake: true })
    } finally {
      for (const notice of batch.notices) notice.cancel()
    }
  }

  dispose(): void {
    for (const { timer, notices } of this.#batches.values()) {
      clearTimeout(timer)
      for (const notice of notices) notice.cancel()
    }
    this.#batches.clear()
  }
}
