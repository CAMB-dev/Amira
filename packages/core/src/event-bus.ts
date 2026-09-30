import type { AnyEvent, EventEnvelope, EventMap } from "@amira/api"

/** Events a lagging subscriber can lose without harm; later events supersede them. */
const isStreaming = (type: string) =>
  type === "message.delta" || type === "tool.execute.update" || type === "ui.render"

export type Subscriber = (event: AnyEvent) => void | Promise<void>

export interface SubscribeOptions {
  /** Maximum queued events before dropping. Default 10_000. */
  maxQueue?: number
  /** Only deliver these event types. */
  types?: (keyof EventMap)[]
  /** Events emitted earlier, delivered to this subscriber first (the types it takes). */
  replay?: AnyEvent[]
}

export interface EmitMeta {
  sessionId: string
  parentSessionId?: string
  turnId?: string
}

interface Sub {
  fn: Subscriber
  queue: AnyEvent[]
  max: number
  types?: Set<string>
  draining: boolean
  /** Pending events.lost marker still sitting in the queue, if any. */
  lost?: EventEnvelope<"events.lost">
}

/**
 * Fire-and-forget event bus. Each subscriber has its own queue and is drained
 * asynchronously, so a slow or failing subscriber never blocks the core.
 */
export class EventBus {
  #seq = 0
  #subs = new Set<Sub>()
  #onError: (err: unknown, event: AnyEvent) => void

  /** onError receives subscriber failures. The default ignores them: the core never prints. */
  constructor(onError?: (err: unknown, event: AnyEvent) => void) {
    this.#onError = onError ?? (() => {})
  }

  subscribe(fn: Subscriber, opts: SubscribeOptions = {}): () => void {
    const sub: Sub = {
      fn,
      queue: [],
      max: opts.maxQueue ?? 10_000,
      draining: false,
      ...(opts.types ? { types: new Set(opts.types as string[]) } : {}),
    }
    this.#subs.add(sub)
    for (const ev of opts.replay ?? []) if (!sub.types || sub.types.has(ev.type)) sub.queue.push(ev)
    if (sub.queue.length) this.#drain(sub)
    return () => this.#subs.delete(sub)
  }

  emit<K extends keyof EventMap>(type: K, data: EventMap[K], meta: EmitMeta): EventEnvelope<K> {
    const ev: EventEnvelope<K> = { seq: ++this.#seq, ts: Date.now(), ...meta, type, data }
    for (const sub of this.#subs) {
      if (sub.types && !sub.types.has(type)) continue
      let keep = true
      if (sub.queue.length >= sub.max) {
        // Drop streaming updates first; clients can resync from the final message.
        if (isStreaming(type)) keep = false
        else {
          const i = sub.queue.findIndex((e) => isStreaming(e.type))
          const j = i !== -1 ? i : sub.queue.findIndex((e) => e !== sub.lost)
          if (j !== -1) sub.queue.splice(j, 1)
        }
        if (keep) sub.queue.push(ev as AnyEvent)
        this.#noteLoss(sub, meta)
      } else {
        sub.queue.push(ev as AnyEvent)
      }
      this.#drain(sub)
    }
    return ev
  }

  /** Resolves once every subscriber has processed everything queued so far. */
  async flush(): Promise<void> {
    while ([...this.#subs].some((s) => s.draining || s.queue.length)) await Bun.sleep(0)
  }

  /**
   * Records a drop as an events.lost marker placed after everything queued so far,
   * so delivery order stays in seq order. Consecutive drops share one marker.
   */
  #noteLoss(sub: Sub, meta: EmitMeta) {
    if (sub.types && !sub.types.has("events.lost")) return
    if (sub.lost) {
      sub.lost.data.dropped++
      return
    }
    const lost: EventEnvelope<"events.lost"> = {
      seq: ++this.#seq,
      ts: Date.now(),
      sessionId: meta.sessionId,
      type: "events.lost",
      data: { dropped: 1 },
    }
    sub.lost = lost
    sub.queue.push(lost)
  }

  #drain(sub: Sub) {
    if (sub.draining) return
    sub.draining = true
    queueMicrotask(async () => {
      try {
        while (sub.queue.length) {
          const ev = sub.queue.shift()!
          if (ev === sub.lost) sub.lost = undefined
          await this.#deliver(sub, ev)
        }
      } finally {
        sub.draining = false
      }
    })
  }

  async #deliver(sub: Sub, ev: AnyEvent) {
    if (!this.#subs.has(sub)) return
    try {
      await sub.fn(ev)
    } catch (err) {
      try {
        this.#onError(err, ev)
      } catch {
        // A broken error handler must not take the process down.
      }
    }
  }
}
