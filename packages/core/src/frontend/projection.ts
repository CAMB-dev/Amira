import { createHash } from "node:crypto"
import type { AnyEvent } from "@amira/api"
import { joinMessages } from "../agent/messages.ts"
import type { NoticeInputSnapshot } from "../agent/notice-input.ts"
import type { NoticeRetry } from "../agent/notice-retry.ts"
import { freezeSnapshot, frontendJson } from "./json.ts"
import { FrontendPartial } from "./partial.ts"

/** Host-internal in-flight display state. Settled history comes from the session projector.
 * Snapshot deltas describe current blocks; the journal independently retains original events.
 */
export class FrontendProjection {
  #streams = new Map<string, FrontendPartial>()
  #turnIds = new Map<string, string>()
  #missing = new Map<string, "message" | "turn">()
  #missingQueue = new Map<string, Map<string, number>>()
  #noticeQueues = new Map<string, NoticeInputSnapshot>()
  #noticeEvents = new Map<string, Map<string, string>>()
  #missingNotices = new Set<string>()
  // Reconciliation markers only; reset retry state is read from the owning Agent, not here.
  #noticeRetries = new Map<string, NoticeRetry | undefined>()
  #missingRetries = new Set<string>()
  #missingState = new Set<string>()
  #latest = new Map<string, AnyEvent>()
  #sizes = new WeakMap<AnyEvent, number>()
  #bytes = 0
  #count = 0
  #failed = false

  constructor(private limits = { bytes: 16 * 1024 * 1024, events: 20_000 }) {}

  get failed(): boolean {
    return (
      this.#failed ||
      this.#missing.size > 0 ||
      this.#missingQueue.size > 0 ||
      this.#missingNotices.size > 0 ||
      this.#missingRetries.size > 0 ||
      this.#missingState.size > 0
    )
  }

  fail(): void {
    this.#failed = true
  }

  clear(): void {
    this.#streams.clear()
    this.#turnIds.clear()
    this.#missing.clear()
    this.#missingQueue.clear()
    this.#noticeQueues.clear()
    this.#noticeEvents.clear()
    this.#missingNotices.clear()
    this.#noticeRetries.clear()
    this.#missingRetries.clear()
    this.#missingState.clear()
    this.#latest.clear()
    this.#bytes = 0
    this.#count = 0
    this.#failed = false
  }

  /** Selection may follow model work on the shared bus. Retain only authoritative live turns
   * and inbox admissions; semantic state is resampled separately. A session id alone cannot
   * distinguish a rewind/replacement from the retired Agent that used the same id.
   */
  reconcileTurns(turns: ReadonlyMap<string, string | undefined>): void {
    const current = (session: string, turn: string | undefined) =>
      turn !== undefined && turns.get(session) === turn
    const notices = new Set<string>()
    for (const [session, events] of this.#noticeEvents) {
      if (!turns.has(session)) {
        this.#noticeEvents.delete(session)
        this.#noticeQueues.delete(session)
      } else for (const key of events.values()) notices.add(key)
    }
    for (const [key, event] of this.#latest) {
      if (
        current(event.sessionId, event.turnId) ||
        notices.has(key) ||
        (event.type === "notice.retry" &&
          turns.has(event.sessionId) &&
          this.#noticeRetries.get(event.sessionId))
      )
        continue
      this.#remove(event)
      this.#latest.delete(key)
    }
    for (const [session, stream] of this.#streams) {
      if (!current(session, stream.events[0]?.turnId)) this.#clearStream(session)
    }
    for (const session of this.#missing.keys()) {
      if (!current(session, this.#turnIds.get(session))) this.#missing.delete(session)
    }
    for (const [session, turn] of this.#turnIds) {
      if (!current(session, turn)) this.#turnIds.delete(session)
    }
    for (const session of this.#missingQueue.keys()) {
      if (!turns.get(session)) this.#missingQueue.delete(session)
    }
    for (const key of this.#missingNotices) {
      if (!notices.has(key)) this.#missingNotices.delete(key)
    }
    for (const session of this.#noticeQueues.keys()) {
      if (!turns.has(session)) this.#noticeQueues.delete(session)
    }
    for (const session of this.#noticeRetries.keys()) {
      if (!turns.has(session)) {
        this.#noticeRetries.delete(session)
        this.#missingRetries.delete(session)
      }
    }
    this.#missingState.clear()
    if (this.#failed) {
      // A new selection can discard retired corruption, but must not pretend that live
      // work skipped during failed capture was observed. Its terminal events still recover.
      this.#failed = false
      for (const [session, turn] of turns)
        if (turn) {
          this.#turnIds.set(session, turn)
          this.#missing.set(session, "turn")
        }
      for (const [session, inbox] of this.#noticeQueues) {
        let events = this.#noticeEvents.get(session)
        if (!events) {
          events = new Map()
          this.#noticeEvents.set(session, events)
        }
        for (const entry of inbox.queue) {
          const key = events.get(entry.id) ?? `${session}:notice:${entry.id}`
          events.set(entry.id, key)
          if (!this.#latest.has(key)) this.#missingNotices.add(key)
        }
      }
    }
  }

  /** Reconcile by inbox admission identity, never by a combined injected-message fingerprint. */
  reconcileNotices(session: string, snapshot: NoticeInputSnapshot): void {
    this.#noticeQueues.set(session, snapshot)
    const queued = new Set(snapshot.queue.map((entry) => entry.id))
    const events = this.#noticeEvents.get(session)
    if (!events) return
    for (const [id, key] of events) {
      if (queued.has(id)) continue
      const previous = this.#latest.get(key)
      if (previous) {
        this.#remove(previous)
        this.#latest.delete(key)
      }
      this.#missingNotices.delete(key)
      events.delete(id)
    }
  }

  /** Keep active retry event metadata only while its authoritative timer still exists. */
  reconcileNoticeRetry(session: string, retry: NoticeRetry | undefined): void {
    const previous = this.#noticeRetries.get(session)
    this.#noticeRetries.set(session, retry && { ...retry })
    if (retry && previous?.attempt === retry.attempt && previous.at === retry.at) return
    const key = `${session}:notice.retry`
    const event = this.#latest.get(key)
    if (event) {
      this.#remove(event)
      this.#latest.delete(key)
    }
    this.#missingRetries.delete(session)
  }

  capture(source: AnyEvent): void {
    if (this.#failed) return
    const event = freezeSnapshot(frontendJson(source)) as unknown as AnyEvent
    const session = event.sessionId
    const key = `${session}:`
    if (event.type.startsWith("message.") || event.type === "turn.end") {
      const retry = this.#latest.get(`${key}model.retry`)
      if (retry) {
        this.#remove(retry)
        this.#latest.delete(`${key}model.retry`)
      }
    }
    let noticeKey: string | undefined
    const noticeEvents = this.#noticeEvents.get(session)
    const settled =
      event.type === "turn.end" ||
      event.type === "session.end" ||
      event.type === "compact.end" ||
      event.type === "compact.failed" ||
      event.type === "subagent.end" ||
      event.type === "group.end" ||
      (event.type === "status.changed" && event.data.status === "idle")
    if (settled) this.#missingState.delete(session)
    const put = (key: string) => {
      if (
        this.#missing.get(session) === "turn" &&
        (key.startsWith(`${session}:tool:`) || key === `${session}:turn`)
      )
        return
      const previous = this.#latest.get(key)
      if (previous) this.#remove(previous)
      this.#latest.set(key, event)
      this.#add(event)
    }
    const clearStream = () => this.#clearStream(session)
    switch (event.type) {
      case "message.start":
        clearStream()
        this.#streams.set(session, new FrontendPartial())
        this.#captureStream(event)
        break
      case "message.stream":
      case "message.delta":
        this.#captureStream(event)
        break
      case "message.end":
        clearStream()
        if (this.#missing.get(session) === "message") this.#missing.delete(session)
        break
      case "tool.execute.start":
        put(`${key}tool:${event.data.toolCallId}:start`)
        break
      case "tool.execute.update":
      case "tool.execute.end":
        put(`${key}tool:${event.data.toolCallId}`)
        break
      case "turn.start":
        if (event.turnId) this.#turnIds.set(session, event.turnId)
        put(`${key}turn`)
        break
      case "turn.end":
        this.#turnIds.delete(session)
        clearStream()
        this.#missing.delete(session)
        if (event.data.reason === "done") this.#missingQueue.delete(session)
        this.#clearTurn(session)
        break
      case "turn.steer": {
        if (event.data.state === "queued") {
          const target = JSON.stringify(event.data.message)
          const admission = this.#noticeQueues
            .get(session)
            ?.queue.find((entry) => !noticeEvents?.has(entry.id) && JSON.stringify(entry.message) === target)
          if (admission) {
            noticeKey = `${key}steer:${event.seq}`
            let events = noticeEvents
            if (!events) {
              events = new Map()
              this.#noticeEvents.set(session, events)
            }
            events.set(admission.id, noticeKey)
          }
          put(`${key}steer:${event.seq}`)
        } else {
          const queued = [...this.#latest.entries()].filter(
            (entry): entry is [string, Extract<AnyEvent, { type: "turn.steer" }>] =>
              entry[0].startsWith(`${key}steer:`) &&
              entry[1].type === "turn.steer" &&
              ![...(noticeEvents?.values() ?? [])].includes(entry[0]),
          )
          const target = JSON.stringify(event.data.message)
          const digest = createHash("sha256").update(target).digest("hex")
          const omitted = this.#missingQueue.get(session)
          const exact = queued.find(([, item]) => JSON.stringify(item.data.message) === target)
          // Legacy-only projections can still infer joined notices. Once the inbox seam is
          // attached, its admission/removal records are the sole authority for notices.
          const notices = this.#noticeQueues.has(session)
            ? []
            : queued.filter(([, item]) => item.data.message.display?.origin)
          const matches = exact
            ? [exact]
            : JSON.stringify(joinMessages(notices.map(([, item]) => item.data.message))) === target
              ? notices
              : []
          for (const [id, previous] of matches) {
            this.#remove(previous)
            this.#latest.delete(id)
          }
          if (!matches.length && omitted?.has(digest)) {
            const remaining = omitted.get(digest)! - 1
            if (remaining) omitted.set(digest, remaining)
            else omitted.delete(digest)
            if (!omitted.size) this.#missingQueue.delete(session)
          }
        }
        break
      }
      case "subagent.start":
      case "subagent.end":
        put(`child:${event.data.childSessionId}`)
        break
      case "subagent.state":
        put(`childState:${event.data.childSessionId}`)
        break
      case "notice.retry": {
        const retry = this.#noticeRetries.get(session)
        if (!this.#noticeRetries.has(session) || retry?.attempt === event.data.attempt)
          put(`${key}notice.retry`)
        break
      }
      case "group.start":
      case "group.update":
      case "group.end":
        put(`group:${event.data.group.id}`)
        break
      default:
        // Semantic state outside the transcript is last-value state, not a transient log.
        if (
          event.type.startsWith("budget.") ||
          event.type.startsWith("session.") ||
          event.type.startsWith("compact.") ||
          event.type === "status.changed" ||
          event.type === "model.retry" ||
          event.type === "thinking.changed" ||
          event.type === "model.changed" ||
          event.type === "workspace.changed"
        )
          put(`${key}${event.type}`)
    }
    // Quarantine only the overflowing work, and keep observing its terminal event. Do not
    // throw: capture's caller must still journal the original event independently.
    if (this.#bytes > this.limits.bytes || this.#count > this.limits.events) {
      if (event.type.startsWith("message.")) {
        clearStream()
        if (!this.#missing.has(session)) this.#missing.set(session, "message")
      } else if (event.type.startsWith("tool.execute.") || event.type === "turn.start") {
        this.#missing.set(session, "turn")
        this.#clearTurn(session)
      } else {
        if (noticeKey) this.#missingNotices.add(noticeKey)
        else if (event.type === "notice.retry") this.#missingRetries.add(session)
        else if (event.type === "turn.steer" && event.data.state === "queued") {
          // Retain only a small fingerprint/count, not the oversized payload. Duplicate
          // admissions must each settle; held inputs can be dropped without turn.end.
          const digest = createHash("sha256").update(JSON.stringify(event.data.message)).digest("hex")
          let omitted = this.#missingQueue.get(session)
          if (!omitted) {
            omitted = new Map()
            this.#missingQueue.set(session, omitted)
          }
          omitted.set(digest, (omitted.get(digest) ?? 0) + 1)
        } else if (!settled) this.#missingState.add(session)
        // Semantic state is resampled from the host at the cut. Observe its work's
        // settlement instead of poisoning all future snapshots with a permanent failure.
        for (const [id, value] of this.#latest) {
          if (value === event) {
            this.#remove(value)
            this.#latest.delete(id)
          }
        }
      }
    }
  }

  snapshot(): { events: readonly AnyEvent[] } {
    if (this.failed) throw new Error("Frontend activity requires authoritative recovery")
    return freezeSnapshot({ events: this.#events() })
  }

  /** Resets obtain queues and timers from host state, not this incremental display projection. */
  inFlightSnapshot(): { events: readonly AnyEvent[] } {
    if (this.#failed || this.#missing.size || this.#missingState.size)
      throw new Error("Frontend activity requires authoritative recovery")
    return freezeSnapshot({
      events: this.#events().filter((event) => event.type !== "turn.steer" && event.type !== "notice.retry"),
    })
  }

  #captureStream(event: AnyEvent): void {
    if (this.#missing.has(event.sessionId)) return
    const stream = this.#streams.get(event.sessionId)
    if (!stream) return
    this.#bytes -= stream.bytes
    this.#count -= stream.count
    stream.capture(event)
    this.#bytes += stream.bytes
    this.#count += stream.count
  }

  #clearStream(session: string): void {
    const stream = this.#streams.get(session)
    if (stream) {
      this.#bytes -= stream.bytes
      this.#count -= stream.count
      this.#streams.delete(session)
    }
  }

  #clearTurn(session: string): void {
    for (const [id, value] of this.#latest) {
      if (value.sessionId === session && (id.startsWith(`${session}:tool:`) || id === `${session}:turn`)) {
        this.#remove(value)
        this.#latest.delete(id)
      }
    }
  }

  #add(event: AnyEvent): void {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    this.#sizes.set(event, bytes)
    this.#bytes += bytes
    this.#count++
  }

  #remove(event: AnyEvent): void {
    this.#bytes -= this.#sizes.get(event) ?? 0
    this.#count--
  }

  #events(): AnyEvent[] {
    return [...this.#latest.values(), ...[...this.#streams.values()].flatMap((stream) => stream.events)].sort(
      (a, b) => a.seq - b.seq,
    )
  }
}
