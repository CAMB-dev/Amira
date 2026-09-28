import type { AnyEvent, EventEnvelope, EventMap } from "@amira/api"

const isStreaming = (type: string) => type === "message.delta" || type === "tool.execute.update"

export type Subscriber = (event: AnyEvent) => void | Promise<void>

export interface SubscribeOptions {
  /** Maximum queued events before dropping. Default 10_000. */
  maxQueue?: number
  /** Only deliver these event types. */
  types?: (keyof EventMap)[]
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
  dropped: number
}

/**
 * Fire-and-forget event bus. Each subscriber has its own queue and is drained
 * asynchronously, so a slow or failing subscriber never blocks the core.
 */
export class EventBus {
  #seq = 0
  #subs = new Set<Sub>()
  #onError: (err: unknown, event: AnyEvent) => void

  constructor(onError?: (err: unknown, event: AnyEvent) => void) {
    this.#onError = onError ?? ((err) => console.error("[amira] event subscriber failed:", err))
  }

  subscribe(fn: Subscriber, opts: SubscribeOptions = {}): () => void {
    const sub: Sub = {
      fn,
      queue: [],
      max: opts.maxQueue ?? 10_000,
      draining: false,
      dropped: 0,
      ...(opts.types ? { types: new Set(opts.types as string[]) } : {}),
    }
    this.#subs.add(sub)
    return () => this.#subs.delete(sub)
  }

  emit<K extends keyof EventMap>(type: K, data: EventMap[K], meta: EmitMeta): EventEnvelope<K> {
    const ev: EventEnvelope<K> = { seq: ++this.#seq, ts: Date.now(), ...meta, type, data }
    for (const sub of this.#subs) {
      if (sub.types && !sub.types.has(type)) continue
      if (sub.queue.length >= sub.max) {
        // Drop streaming updates first; clients can resync from the final message.
        sub.dropped++
        if (isStreaming(type)) continue
        const i = sub.queue.findIndex((e) => isStreaming(e.type))
        sub.queue.splice(i === -1 ? 0 : i, 1)
      }
      sub.queue.push(ev as AnyEvent)
      this.#drain(sub)
    }
    return ev
  }

  /** Resolves once every subscriber has processed everything queued so far. */
  async flush(): Promise<void> {
    while ([...this.#subs].some((s) => s.draining || s.queue.length)) await Bun.sleep(0)
  }

  #drain(sub: Sub) {
    if (sub.draining) return
    sub.draining = true
    queueMicrotask(async () => {
      while (sub.queue.length) {
        if (sub.dropped) {
          const lost: AnyEvent = {
            seq: ++this.#seq,
            ts: Date.now(),
            sessionId: sub.queue[0]!.sessionId,
            type: "events.lost",
            data: { dropped: sub.dropped },
          }
          sub.dropped = 0
          await this.#deliver(sub, lost)
        }
        const ev = sub.queue.shift()!
        await this.#deliver(sub, ev)
      }
      sub.draining = false
    })
  }

  async #deliver(sub: Sub, ev: AnyEvent) {
    if (!this.#subs.has(sub)) return
    try {
      await sub.fn(ev)
    } catch (err) {
      this.#onError(err, ev)
    }
  }
}
