import { encodeRemoteBytes, prepareRemoteMessage } from "./codec.ts"
import { RemoteError } from "./errors.ts"
import { REMOTE_LIMITS, type RemoteChannel, type RemoteMessage, remoteChannel } from "./protocol.ts"

interface PendingWrite {
  bytes: number
  chunks: Generator<Uint8Array>
  resolve: () => void
  reject: (error: unknown) => void
}
type Lane = RemoteChannel | "urgent"
const schedule: Lane[] = ["urgent", "control", "model", "urgent", "files"]

/** One backpressure-aware writer for every channel. Each scheduling quantum is one bounded line. */
export class RemoteWriter {
  private queues: Record<Lane, PendingWrite[]> = { urgent: [], control: [], model: [], files: [] }
  private bytes = 0
  private count = 0
  private cursor = 0
  private pumping = false
  private failure?: unknown

  constructor(
    private write: (bytes: Uint8Array) => Promise<void>,
    private onFailure?: (error: unknown) => void,
  ) {}

  send(message: RemoteMessage): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    try {
      const { message: frame, bytes } = prepareRemoteMessage(message)
      const urgent =
        bytes.length <= REMOTE_LIMITS.lineBytes &&
        (frame.kind === "cancel" ||
          frame.kind === "ack" ||
          (frame.kind === "response" && frame.channel === "control") ||
          frame.kind === "ping" ||
          frame.kind === "pong" ||
          frame.kind === "reject")
      // Reserve room for cancellation/ACKs even when a bulk producer exhausts its allowance.
      const maxCount = REMOTE_LIMITS.queuedFrames - (urgent ? 0 : 16)
      const maxBytes = REMOTE_LIMITS.queuedBytes + (urgent ? REMOTE_LIMITS.lineBytes : 0)
      if (this.count >= maxCount || this.bytes + bytes.length > maxBytes)
        throw new RemoteError("limit_exceeded", "Remote writer queue is full")
      this.bytes += bytes.length
      this.count++
      const channel = remoteChannel(frame)
      const promise = new Promise<void>((resolve, reject) => {
        this.queues[urgent ? "urgent" : channel].push({
          bytes: bytes.length,
          chunks: encodeRemoteBytes(bytes, channel),
          resolve,
          reject,
        })
      })
      void this.pump()
      return promise
    } catch (error) {
      return Promise.reject(error)
    }
  }

  close(error: unknown = new RemoteError("disconnected", "Remote writer closed")): void {
    if (this.failure) return
    this.failure = error
    for (const queue of Object.values(this.queues)) {
      for (const item of queue) {
        item.chunks.return(undefined)
        item.reject(error)
      }
      queue.length = 0
    }
    this.bytes = 0
    this.count = 0
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.failure) return
    this.pumping = true
    try {
      while (this.count && !this.failure) {
        const channel = schedule[this.cursor++ % schedule.length]!
        const queue = this.queues[channel]
        const item = queue[0]
        if (!item) continue
        const next = item.chunks.next()
        if (next.done) {
          queue.shift()
          this.bytes -= item.bytes
          this.count--
          item.resolve()
        } else {
          await this.write(next.value)
        }
      }
    } catch (error) {
      this.close(error)
      this.onFailure?.(error)
    } finally {
      this.pumping = false
    }
  }
}
