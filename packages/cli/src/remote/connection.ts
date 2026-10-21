import { randomUUID } from "node:crypto"
import { validateRemoteParams } from "../remote-schema.ts"
import { RemoteDecoder } from "./codec.ts"
import { RemoteError, RemoteReplyError } from "./errors.ts"
import {
  REMOTE_LIMITS,
  type RemoteCancel,
  type RemoteChannel,
  type RemoteHello,
  type RemoteJson,
  type RemoteMessage,
  type RemoteOperation,
  type RemoteRequest,
  type RemoteWelcome,
} from "./protocol.ts"
import { matches, id as operationId } from "./schema/base.ts"
import { RemoteWriter } from "./writer.ts"

function operationChannel(op: RemoteOperation): RemoteChannel {
  if (op === "model.open" || op === "model.stream" || op === "model.compact") return "model"
  return /^(?:files|images|artifacts|uploads)\./.test(op) ? "files" : "control"
}

export interface RemoteIO {
  input: AsyncIterable<Uint8Array>
  /** Resolves only after the sink accepts the bytes; must honor backpressure. */
  write(bytes: Uint8Array): Promise<void>
  /** Must interrupt pending reads and writes. Never owns the workspace runtime. */
  close(): void
}
export interface RemoteRequestOptions {
  /** Stable across reconnect retries, but never reusable within one connection. */
  operationId?: string
  /** Preserve this alongside operationId when retrying an uncertain mutation. */
  daemonEpoch?: string
  channel?: RemoteChannel
  sessionGeneration?: number
  controllerGeneration?: number
  signal?: AbortSignal
}
export interface RemoteConnectionOptions {
  handshake:
    | { role: "client"; hello: RemoteHello; validateWelcome?: (welcome: RemoteWelcome) => void }
    | {
        role: "server"
        accept(hello: RemoteHello): RemoteWelcome | Promise<RemoteWelcome>
      }
  handle?(request: RemoteRequest, signal: AbortSignal): Promise<RemoteJson>
  /** Explicit peer cancellation only, including operations retained across connections. */
  onCancel?(id: string, frame: RemoteCancel): void
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

const REQUEST_ID_LIMIT = 65_536

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
  private idPrefix = randomUUID()
  private usedIds = new Set<string>()
  private inboundIds = new Set<string>()
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
    if (this.usedIds.size >= REQUEST_ID_LIMIT)
      return Promise.reject(new RemoteError("limit_exceeded", "Remote request identity capacity exhausted"))
    let id = options.operationId
    if (id !== undefined) {
      if (!matches(id, operationId))
        return Promise.reject(new RemoteError("invalid_frame", "Invalid remote operation ID"))
      if (this.usedIds.has(id))
        return Promise.reject(new RemoteError("invalid_frame", "Duplicate remote operation ID"))
    } else {
      do id = `${this.idPrefix}:r${++this.nextId}`
      while (this.usedIds.has(id))
    }
    this.usedIds.add(id)
    const channel = options.channel ?? operationChannel(op)
    return new Promise((resolve, reject) => {
      let sent = false
      const cancel: RemoteCancel = { v: 1, kind: "cancel", channel, id }
      const abort = () => {
        if (!this.pending.delete(id)) return
        options.signal?.removeEventListener("abort", abort)
        reject(new RemoteError("cancelled", "Remote request cancelled"))
        if (sent) void this.writer.send(cancel).catch((error) => this.close(error))
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
          cancel.sessionGeneration = options.sessionGeneration ?? welcome.sessionGeneration
          cancel.controllerGeneration = options.controllerGeneration ?? welcome.controllerGeneration
          await this.writer.send({
            v: 1,
            kind: "request",
            channel,
            id,
            op,
            params,
            daemonEpoch: options.daemonEpoch ?? welcome.daemonEpoch,
            sessionGeneration: cancel.sessionGeneration,
            controllerGeneration: cancel.controllerGeneration,
          })
          sent = true
          // A cancel must not overtake the request's final chunk. Local cancellation is immediate.
          if (options.signal?.aborted) await this.writer.send(cancel)
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

  /** Local terminal cause; protocol rejections win over later pipe/process cleanup. */
  get failureReason(): unknown {
    return this.failure
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
    this.inboundIds.clear()
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
        handshake.validateWelcome?.(message)
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
        this.options.onCancel?.(message.id, message)
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
    if (this.inboundIds.has(request.id)) throw new RemoteError("invalid_frame", "Duplicate remote request ID")
    if (this.inboundIds.size >= REQUEST_ID_LIMIT)
      throw new RemoteError("limit_exceeded", "Remote request identity capacity exhausted")
    if (this.active.size >= REMOTE_LIMITS.pendingRequests)
      throw new RemoteError("limit_exceeded", "Too many incoming remote requests")
    if (request.channel !== operationChannel(request.op))
      throw new RemoteError("invalid_frame", "Operation channel mismatch")
    this.inboundIds.add(request.id)
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
