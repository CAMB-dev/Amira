import { validateRemoteParams } from "../remote-schema.ts"
import { RemoteDecoder } from "./codec.ts"
import { RemoteError, RemoteReplyError } from "./errors.ts"
import {
  REMOTE_LIMITS,
  type RemoteChannel,
  type RemoteHello,
  type RemoteJson,
  type RemoteMessage,
  type RemoteOperation,
  type RemoteRequest,
  type RemoteWelcome,
} from "./protocol.ts"
import { RemoteWriter } from "./writer.ts"

export interface RemoteIO {
  input: AsyncIterable<Uint8Array>
  /** Resolves only after the sink accepts the bytes; must honor backpressure. */
  write(bytes: Uint8Array): Promise<void>
  /** Must interrupt pending reads and writes. Never owns the workspace runtime. */
  close(): void
}
export interface RemoteRequestOptions {
  channel?: RemoteChannel
  sessionGeneration?: number
  controllerGeneration?: number
  signal?: AbortSignal
}
export interface RemoteConnectionOptions {
  handshake:
    | { role: "client"; hello: RemoteHello }
    | {
        role: "server"
        accept(hello: RemoteHello): RemoteWelcome | Promise<RemoteWelcome>
      }
  handle?(request: RemoteRequest, signal: AbortSignal): Promise<RemoteJson>
  onMessage?(message: Exclude<RemoteMessage, RemoteHello | RemoteWelcome | RemoteRequest>): void
  handshakeTimeoutMs?: number
}
// Only registered handshake fault codes cross this boundary. Exception text may contain secrets.
const rejectionMessages: Record<string, string> = {
  controller_busy: "A controller is already attached to this workspace",
  incompatible_protocol: "Unsupported remote protocol version",
  incompatible_build: "The running server build is not compatible with this client",
  invalid_frame: "Invalid remote handshake",
  invalid_workspace: "The remote workspace is unavailable",
  workspace_busy: "The remote workspace is busy",
  unsupported_capability: "The server does not support a required capability",
  permission_denied: "Access to the remote workspace was denied",
  startup_failed: "The remote workspace could not start",
  limit_exceeded: "Remote handshake limit exceeded",
  disconnected: "Remote attachment unavailable",
  cancelled: "Remote attachment cancelled",
  unsupported_operation: "The server does not support this attachment",
  operation_failed: "Remote attachment rejected",
}

interface Pending {
  channel: RemoteChannel
  op: RemoteOperation
  resolve(value: RemoteJson): void
  reject(error: unknown): void
  cleanup(): void
}

/** Multiplexes a single attachment. Closing it cancels connection handlers, not an agent/runtime. */
export class RemoteConnection {
  readonly ready: Promise<RemoteWelcome>
  readonly closed: Promise<void>
  private resolveReady!: (welcome: RemoteWelcome) => void
  private rejectReady!: (error: unknown) => void
  private resolveClosed!: () => void
  private welcome?: RemoteWelcome
  private writer: RemoteWriter
  private decoder = new RemoteDecoder()
  private pending = new Map<string, Pending>()
  private active = new Map<string, { channel: RemoteChannel; controller: AbortController }>()
  private nextId = 0
  private failure?: unknown
  private timer: ReturnType<typeof setTimeout>

  constructor(
    private io: RemoteIO,
    private options: RemoteConnectionOptions,
  ) {
    this.writer = new RemoteWriter(
      (bytes) => io.write(bytes),
      (error) => this.close(error),
    )
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // A server can be closed before its owner awaits the handshake.
    void this.ready.catch(() => {})
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
    this.timer = setTimeout(
      () => this.close(new RemoteError("disconnected", "Remote handshake timed out")),
      options.handshakeTimeoutMs ?? 10_000,
    )
    void this.read()
    if (options.handshake.role === "client")
      void this.writer.send(options.handshake.hello).catch((error) => this.close(error))
  }

  request(
    op: RemoteOperation,
    params: RemoteRequest["params"],
    options: RemoteRequestOptions = {},
  ): Promise<RemoteJson> {
    if (this.failure) return Promise.reject(this.failure)
    if (options.signal?.aborted)
      return Promise.reject(new RemoteError("cancelled", "Remote request cancelled"))
    if (this.pending.size >= REMOTE_LIMITS.pendingRequests)
      return Promise.reject(new RemoteError("limit_exceeded", "Too many pending remote requests"))
    try {
      validateRemoteParams(op, params)
    } catch (error) {
      return Promise.reject(error)
    }
    const id = `r${++this.nextId}`
    const channel =
      options.channel ??
      (op.startsWith("model.") && (op === "model.stream" || op === "model.compact") ? "model" : "control")
    return new Promise((resolve, reject) => {
      let sent = false
      const abort = () => {
        if (!this.pending.delete(id)) return
        options.signal?.removeEventListener("abort", abort)
        reject(new RemoteError("cancelled", "Remote request cancelled"))
        if (sent)
          void this.writer.send({ v: 1, kind: "cancel", channel, id }).catch((error) => this.close(error))
      }
      this.pending.set(id, {
        channel,
        op,
        resolve,
        reject,
        cleanup: () => options.signal?.removeEventListener("abort", abort),
      })
      options.signal?.addEventListener("abort", abort, { once: true })
      void this.ready
        .then(async (welcome) => {
          if (!this.pending.has(id)) return
          await this.writer.send({
            v: 1,
            kind: "request",
            channel,
            id,
            op,
            params,
            sessionGeneration: options.sessionGeneration ?? welcome.sessionGeneration,
            controllerGeneration: options.controllerGeneration ?? welcome.controllerGeneration,
          })
          sent = true
          // A cancel must not overtake the request's final chunk. Local cancellation is immediate.
          if (options.signal?.aborted) await this.writer.send({ v: 1, kind: "cancel", channel, id })
        })
        .catch((error) => {
          const pending = this.pending.get(id)
          if (!pending) return
          this.pending.delete(id)
          pending.cleanup()
          pending.reject(error)
        })
    })
  }

  async send(message: Exclude<RemoteMessage, RemoteHello | RemoteWelcome | RemoteRequest>): Promise<void> {
    await this.ready
    await this.writer.send(message)
  }

  close(error: unknown = new RemoteError("disconnected", "Remote attachment closed")): void {
    if (this.failure) return
    this.failure = error
    clearTimeout(this.timer)
    this.rejectReady(error)
    this.writer.close(error)
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
    for (const active of this.active.values()) active.controller.abort()
    this.active.clear()
    try {
      this.decoder.finish()
    } catch {
      // Local close discards any partial transfer; retain the original terminal error.
    }
    try {
      this.io.close()
    } catch {
      // Closing is terminal even if the adapter's cleanup fails.
    } finally {
      this.resolveClosed()
    }
  }

  private async read(): Promise<void> {
    try {
      for await (const bytes of this.io.input) {
        if (this.failure) return
        for (const message of this.decoder.push(bytes)) {
          if (this.failure) return
          await this.receive(message)
        }
      }
      this.decoder.finish()
      this.close()
    } catch (error) {
      if (!this.welcome && error instanceof RemoteError && error.code === "incompatible_protocol")
        await this.rejectHandshake(error)
      else this.close(error)
    }
  }

  private async rejectHandshake(error: unknown): Promise<void> {
    const code =
      (error instanceof RemoteError || error instanceof RemoteReplyError) &&
      typeof error.code === "string" &&
      Object.hasOwn(rejectionMessages, error.code)
        ? error.code
        : "operation_failed"
    const fault = { code, message: rejectionMessages[code]! }
    // Await the refusal before EOF so the peer sees the reason, not a generic disconnect.
    await this.writer.send({ v: 1, kind: "reject", error: fault }).catch(() => {})
    this.close(new RemoteReplyError(fault.code, fault.message))
  }

  private async receive(message: RemoteMessage): Promise<void> {
    if (!this.welcome) {
      const handshake = this.options.handshake
      if (message.kind === "reject") throw new RemoteReplyError(message.error.code, message.error.message)
      let welcome: RemoteWelcome
      if (handshake.role === "server" && message.kind === "hello") {
        try {
          welcome = await handshake.accept(message)
          await this.writer.send(welcome)
        } catch (error) {
          await this.rejectHandshake(error)
          return
        }
      } else if (handshake.role === "client" && message.kind === "welcome") {
        welcome = message
      } else {
        throw new RemoteError("invalid_frame", "Expected remote handshake before operations")
      }
      if (this.failure) return
      this.welcome = welcome
      clearTimeout(this.timer)
      this.resolveReady(welcome)
      return
    }
    switch (message.kind) {
      case "hello":
      case "welcome":
      case "reject":
        throw new RemoteError("invalid_frame", "Repeated remote handshake")
      case "request":
        this.dispatch(message)
        return
      case "response": {
        const pending = this.pending.get(message.id)
        // A response racing a local cancel is intentionally ignored. IDs are never reused.
        if (!pending) return
        if (pending.channel !== message.channel)
          throw new RemoteError("invalid_frame", "Response channel mismatch")
        if (pending.op !== message.op) throw new RemoteError("invalid_frame", "Response operation mismatch")
        this.pending.delete(message.id)
        pending.cleanup()
        if (message.ok) pending.resolve(message.result)
        else pending.reject(new RemoteReplyError(message.error.code, message.error.message))
        return
      }
      case "cancel": {
        const active = this.active.get(message.id)
        if (active && active.channel !== message.channel)
          throw new RemoteError("invalid_frame", "Cancel channel mismatch")
        active?.controller.abort()
        return
      }
      case "ping":
        void this.writer.send({ v: 1, kind: "pong", id: message.id }).catch((error) => this.close(error))
        return
      default:
        this.options.onMessage?.(message)
    }
  }

  private dispatch(request: RemoteRequest): void {
    if (this.active.has(request.id)) throw new RemoteError("invalid_frame", "Duplicate in-flight request ID")
    if (this.active.size >= REMOTE_LIMITS.pendingRequests)
      throw new RemoteError("limit_exceeded", "Too many incoming remote requests")
    const isModel = request.op === "model.stream" || request.op === "model.compact"
    if (request.channel !== (isModel ? "model" : "control"))
      throw new RemoteError("invalid_frame", "Operation channel mismatch")
    const controller = new AbortController()
    this.active.set(request.id, { channel: request.channel, controller })
    const run = async () => {
      try {
        if (!this.options.handle)
          throw new RemoteError("unsupported_operation", "No remote operation handler")
        const result = await this.options.handle(request, controller.signal)
        if (!controller.signal.aborted && !this.failure)
          await this.writer.send({
            v: 1,
            kind: "response",
            channel: request.channel,
            id: request.id,
            op: request.op,
            ok: true,
            result,
          })
      } catch (error) {
        if (!controller.signal.aborted && !this.failure) {
          // Unknown exceptions can contain credentials. Never serialize arbitrary errors/stacks.
          const fault =
            error instanceof RemoteError || error instanceof RemoteReplyError
              ? { code: error.code, message: error.message }
              : { code: "operation_failed", message: "Remote operation failed" }
          await this.writer.send({
            v: 1,
            kind: "response",
            channel: request.channel,
            id: request.id,
            op: request.op,
            ok: false,
            error: fault,
          })
        }
      } finally {
        this.active.delete(request.id)
      }
    }
    void run().catch((error) => this.close(error))
  }
}
