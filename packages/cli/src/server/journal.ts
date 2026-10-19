import { randomUUID } from "node:crypto"
import { freezeSnapshot } from "../../../core/src/frontend/json.ts"
import { RemoteError } from "../remote/errors.ts"
import { REMOTE_LIMITS, type RemoteJson, type RemoteMessage } from "../remote/protocol.ts"
import { publicUpdateError } from "../remote/public-errors.ts"
import { copyRemoteJson } from "../remote-schema.ts"

export type JournalEvent = Extract<RemoteMessage, { kind: "event" }>
export type JournalResetReason =
  | "fresh"
  | "epoch_changed"
  | "cursor_expired"
  | "future_cursor"
  | "capture_failed"
export interface JournalCursor {
  daemonEpoch: string
  after: number
}

/** Bounded memory only. A synchronous cut plus live registration has no snapshot/replay gap. */
export class ReplayJournal {
  readonly daemonEpoch = randomUUID()
  #seq = 0
  #entries: ({ event: JournalEvent; bytes: number } | undefined)[] = []
  #bytes = 0
  #head = 0
  #delivering = false
  #notifications: JournalEvent[] = []
  #listeners = new Set<(event: JournalEvent) => void>()
  #degraded = false

  constructor(private limits = { bytes: 32 * 1024 * 1024, events: 50_000 }) {
    if (![limits.bytes, limits.events].every((value) => Number.isSafeInteger(value) && value > 0))
      throw new RangeError("Replay limits must be positive safe integers")
  }

  get watermark(): number {
    return this.#seq
  }

  invalidate(): void {
    if (this.#degraded) return
    this.#degraded = true
    // Already connected clients must also learn that exact capture has degraded.
    this.append(copyRemoteJson(publicUpdateError()))
  }

  append(payload: RemoteJson): JournalEvent {
    const copy = copyRemoteJson(payload)
    const bytes = Buffer.byteLength(JSON.stringify(copy))
    if (bytes > REMOTE_LIMITS.logicalBytes - 1024)
      throw new RemoteError("limit_exceeded", "Replay payload exceeds the logical frame limit")
    const event = freezeSnapshot({
      v: 1 as const,
      kind: "event" as const,
      daemonEpoch: this.daemonEpoch,
      seq: ++this.#seq,
      payload: copy,
    })
    this.#entries.push({ event, bytes })
    this.#bytes += bytes
    while (this.#entries.length - this.#head > this.limits.events || this.#bytes > this.limits.bytes) {
      this.#bytes -= this.#entries[this.#head]!.bytes
      this.#entries[this.#head++] = undefined
    }
    if (this.#head > 4096 && this.#head > this.#entries.length / 2) {
      this.#entries = this.#entries.slice(this.#head)
      this.#head = 0
    }
    this.#notifications.push(event)
    if (!this.#delivering) {
      this.#delivering = true
      try {
        for (let i = 0; i < this.#notifications.length; i++) {
          for (const listener of this.#listeners) {
            try {
              listener(this.#notifications[i]!)
            } catch {
              // A failed connection must not degrade capture or another subscriber.
              this.#listeners.delete(listener)
            }
          }
        }
      } finally {
        this.#notifications.length = 0
        this.#delivering = false
      }
    }
    return event
  }

  open(
    cursor: JournalCursor | undefined,
    snapshot: () => RemoteJson,
    listener: (event: JournalEvent) => void,
    forceSnapshot = false,
  ): { initial: Extract<RemoteMessage, { kind: "event" | "reset" }>[]; watermark: number; close(): void } {
    const watermark = this.#seq
    const oldest = this.#entries[this.#head]?.event.seq ?? watermark + 1
    // Cursor repair takes precedence: a client must know when an authoritative reset
    // replaces an invalid epoch/watermark, even if capture also requires resynchronization.
    const reason: JournalResetReason | undefined =
      cursor && cursor.daemonEpoch !== this.daemonEpoch
        ? "epoch_changed"
        : cursor && cursor.after > watermark
          ? "future_cursor"
          : this.#degraded
            ? "capture_failed"
            : !cursor
              ? "fresh"
              : cursor.after < oldest - 1
                ? "cursor_expired"
                : forceSnapshot
                  ? "fresh"
                  : undefined
    if (cursor && (!Number.isSafeInteger(cursor.after) || cursor.after < 0))
      throw new RemoteError("invalid_frame", "Invalid replay cursor")
    // Snapshot is synchronous and copied at this cut, never a live array or paged mutable store.
    const initial: Extract<RemoteMessage, { kind: "event" | "reset" }>[] = reason
      ? [
          {
            v: 1,
            kind: "reset",
            daemonEpoch: this.daemonEpoch,
            seq: watermark,
            reason,
            snapshot: copyRemoteJson(snapshot()),
          },
        ]
      : this.#entries
          .slice(this.#head)
          .flatMap((entry) =>
            entry && entry.event.seq > cursor!.after ? [{ ...entry.event, replay: true }] : [],
          )
    if (reason && Buffer.byteLength(JSON.stringify(initial[0])) > REMOTE_LIMITS.logicalBytes)
      throw new RemoteError("limit_exceeded", "Workspace snapshot exceeds the logical frame limit")
    if (this.#seq !== watermark)
      throw new RemoteError("operation_failed", "Reentrant snapshot construction requires resynchronization")
    this.#listeners.add(listener)
    return { initial, watermark, close: () => void this.#listeners.delete(listener) }
  }
}
