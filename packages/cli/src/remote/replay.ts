import { RemoteReplyError } from "./errors.ts"
import type { RemoteJson, RemoteMessage, RemoteReset } from "./protocol.ts"

type Event = Extract<RemoteMessage, { kind: "event" }>

/** Cursor advances only after application succeeds. Rendering owns replay-suppressed effects. */
export class RemoteReplay {
  #cursor?: { daemonEpoch: string; after: number }
  #applied?: { daemonEpoch: string; after: number }

  constructor(
    private apply: {
      reset(snapshot: RemoteJson, reason: RemoteReset["reason"]): void
      event(payload: RemoteJson, options: { replay: boolean; seq: number }): void
    },
    retained?: { daemonEpoch: string; after: number },
  ) {
    this.#cursor = retained && { ...retained }
  }

  get cursor(): Readonly<{ daemonEpoch: string; after: number }> | undefined {
    return this.#cursor && Object.freeze({ ...this.#cursor })
  }

  receive(frame: Event | RemoteReset): boolean {
    const cursor = this.#cursor
    if (frame.kind === "reset") {
      if (
        cursor?.daemonEpoch === frame.daemonEpoch &&
        frame.seq < cursor.after &&
        frame.reason !== "future_cursor"
      )
        return false
      this.apply.reset(frame.snapshot, frame.reason)
    } else {
      if (!cursor || cursor.daemonEpoch !== frame.daemonEpoch)
        throw new RemoteReplyError("resync_required", "A workspace snapshot is required")
      if (frame.seq <= cursor.after) return false
      if (frame.seq !== cursor.after + 1)
        throw new RemoteReplyError("replay_gap", "A gap requires workspace replay or resynchronization")
      this.apply.event(frame.payload, { replay: frame.replay === true, seq: frame.seq })
    }
    this.#cursor = { daemonEpoch: frame.daemonEpoch, after: frame.seq }
    this.#applied = this.#cursor
    return true
  }

  acknowledgement(): Extract<RemoteMessage, { kind: "ack" }> | undefined {
    // A retained cursor is only a reconnect claim until this attachment delivers state.
    const cursor = this.#applied
    return cursor && { v: 1, kind: "ack", channel: "control", id: cursor.daemonEpoch, seq: cursor.after }
  }
}
