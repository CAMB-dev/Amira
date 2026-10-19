import { createHash } from "node:crypto"
import type { RemoteJson } from "./protocol.ts"
import { proxyFailure } from "./proxy-gate.ts"

export interface RetainedModelFrame {
  seq: number
  event: RemoteJson
}
interface Call {
  fingerprint: string
  abort: AbortController
  frames: RetainedModelFrame[]
  bytes: number
  seq: number
  ack: number
  terminal: boolean
  overflowed: boolean
  retainReceipts: boolean
  timer: ReturnType<typeof setTimeout>
  send?: (frame: RetainedModelFrame) => Promise<void>
  pumping: boolean
  sent: number
}

/** Local-process memory only. Resuming an unknown accepted call NEVER executes it again. */
export class ModelRetention {
  private calls = new Map<string, Call>()
  private seen = new Set<string>()

  constructor(
    private options: { timeoutMs?: number; maxBytes?: number; maxFrames?: number; maxCalls?: number } = {},
  ) {}

  open(options: {
    callId: string
    payload: RemoteJson
    after: number
    resume: boolean
    retainReceipts?: boolean
    send(frame: RetainedModelFrame): Promise<void>
    run(signal: AbortSignal, emit: (event: RemoteJson, terminal?: boolean) => void): Promise<void>
    failure(code: string): RemoteJson
  }): void {
    const fingerprint = createHash("sha256").update(JSON.stringify(options.payload)).digest("hex")
    let call = this.calls.get(options.callId)
    if (call) {
      if (call.fingerprint !== fingerprint) throw proxyFailure("proxy_call_conflict")
      if (options.after < call.ack || options.after > call.seq) throw proxyFailure("proxy_cursor_expired")
      call.ack = options.after
      call.frames = call.frames.filter((frame) => frame.seq > options.after)
      call.bytes = call.frames.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0)
      call.sent = options.after
      call.send = options.send
      this.pump(call)
      return
    }
    if (options.resume || this.seen.has(options.callId)) throw proxyFailure("proxy_broker_lost")
    if (this.seen.size >= 65_536) throw proxyFailure("proxy_capacity_exceeded")
    this.seen.add(options.callId)
    if (this.calls.size >= (this.options.maxCalls ?? 128)) throw proxyFailure("proxy_capacity_exceeded")
    const abort = new AbortController()
    call = {
      fingerprint,
      abort,
      frames: [],
      bytes: 0,
      seq: 0,
      ack: 0,
      terminal: false,
      overflowed: false,
      retainReceipts: options.retainReceipts ?? false,
      timer: setTimeout(() => {
        if (!call!.terminal) emit(options.failure("proxy_retention_expired"), true)
        abort.abort()
        // Retain the terminal for one further bounded window, then forget without reissue.
        call!.timer = setTimeout(() => this.calls.delete(options.callId), this.options.timeoutMs ?? 600_000)
        call!.timer.unref()
      }, this.options.timeoutMs ?? 600_000),
      send: options.send,
      pumping: false,
      sent: 0,
    }
    call.timer.unref()
    this.calls.set(options.callId, call)
    const entry = call
    const emit = (event: RemoteJson, terminal = false) => {
      if (this.calls.get(options.callId) !== entry || entry.overflowed) return
      const lateReceipt =
        entry.retainReceipts &&
        event !== null &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        event.kind === "receipt"
      if ((entry.terminal || entry.abort.signal.aborted) && !lateReceipt) return
      let overflow = false
      let frame = { seq: entry.seq + 1, event }
      let bytes = Buffer.byteLength(JSON.stringify(frame))
      if (
        [...this.calls.values()].reduce((sum, call) => sum + call.frames.length, 0) >=
          (this.options.maxFrames ?? 4096) ||
        [...this.calls.values()].reduce((sum, call) => sum + call.bytes, 0) + bytes >
          (this.options.maxBytes ?? 32 * 1024 * 1024)
      ) {
        // Do not discard unacknowledged deltas; one fixed terminal may exceed the cap slightly.
        frame = { seq: entry.seq + 1, event: options.failure("proxy_retention_expired") }
        bytes = Buffer.byteLength(JSON.stringify(frame))
        terminal = true
        overflow = true
        // Late receipts may bypass terminal/abort suppression, but never this capacity latch.
        entry.overflowed = true
      }
      entry.seq++
      entry.frames.push(frame)
      entry.bytes += bytes
      entry.terminal ||= terminal
      this.pump(entry)
      if (overflow) entry.abort.abort()
    }
    void options.run(abort.signal, emit).then(
      () => {
        if (!entry.terminal) emit(options.failure("proxy_broker_lost"), true)
      },
      () => emit(options.failure("proxy_broker_lost"), true),
    )
  }

  ack(callId: string, seq: number): void {
    const call = this.calls.get(callId)
    if (!call) return
    if (seq < call.ack || seq > call.seq) throw proxyFailure("proxy_cursor_expired")
    call.ack = seq
    call.frames = call.frames.filter((frame) => frame.seq > seq)
    call.bytes = call.frames.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0)
    if (call.terminal && !call.retainReceipts && seq === call.seq) {
      clearTimeout(call.timer)
      this.calls.delete(callId)
    }
  }

  cancel(callId: string): void {
    const call = this.calls.get(callId)
    if (!call) return
    call.abort.abort()
    if (call.retainReceipts) call.terminal = true
    else {
      clearTimeout(call.timer)
      this.calls.delete(callId)
    }
  }

  detach(): void {
    for (const call of this.calls.values()) call.send = undefined
  }

  close(): void {
    for (const call of this.calls.values()) {
      call.abort.abort()
      clearTimeout(call.timer)
    }
    this.calls.clear()
  }

  private pump(call: Call): void {
    if (call.pumping || !call.send) return
    call.pumping = true
    const send = call.send
    void (async () => {
      try {
        while (call.send === send) {
          const frame = call.frames.find((item) => item.seq > call.sent)
          if (!frame) break
          await send(frame)
          if (call.send === send) call.sent = frame.seq
        }
      } catch {
        if (call.send === send) call.send = undefined
      } finally {
        call.pumping = false
        if (call.send && call.send !== send) this.pump(call)
      }
    })()
  }
}
