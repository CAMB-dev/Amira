import { randomUUID } from "node:crypto"
import type {
  Ai,
  CompactReceipt,
  CompactResult,
  ModelError,
  ModelInfo,
  ModelRequest,
  NativeCompaction,
  ReplayTarget,
  Signature,
  StreamEvent,
} from "@amira/ai"
import { canReplay, emptyUsage } from "@amira/ai"
import type { RemoteConnection } from "./connection.ts"
import {
  copyModelInfo,
  decodeCompactReceipt,
  decodeCompactResult,
  decodeModelEvent,
  encodeModelRequest,
} from "./model-codec.ts"
import type { RemoteJson, RemoteMessage, RemoteWelcome } from "./protocol.ts"
import { ProxyGate, proxyFailure } from "./proxy-gate.ts"

export interface ProxyModelMetadata {
  model: ModelInfo
  revision: string
  available: boolean
  replay: ReplayTarget
  native?: NativeCompaction
}
interface Peer {
  connection: RemoteConnection
  authority: RemoteWelcome
  generation(): number
}
interface Call {
  id: string
  request: ModelRequest
  revision: string
  operation: "stream" | "compact"
  end: AbortController
  signal?: AbortSignal
  scope?: AbortSignal
  generation?: number
  queue: { seq: number; payload: RemoteJson; bytes: number }[]
  bytes: number
  applied: number
  received: number
  attempted: boolean
  terminal: boolean
  error?: ModelError
  peer?: Peer
  admitted?: boolean
  onUsage?: (receipt: CompactReceipt) => void | Promise<void>
  wake?: () => void
}

/** Metadata-only remote Ai. No credentials, endpoints, provider administration or second retry loop. */
export class ProxyAi implements Ai {
  private stopped = false
  private gate: ProxyGate<Peer>
  private models = new Map<string, ProxyModelMetadata>()
  private calls = new Map<string, Call>()
  private cancelled = new Map<string, { call: Call; timer: ReturnType<typeof setTimeout> }>()
  private receipts = new Map<string, { call: Call; timer: ReturnType<typeof setTimeout> }>()

  constructor(models: ProxyModelMetadata[], options: { reconnectTimeoutMs?: number } = {}) {
    this.gate = new ProxyGate(options.reconnectTimeoutMs)
    // Core Ai decorators intentionally spread the interface; preserve methods through those copies.
    this.model = this.model.bind(this)
    this.stream = this.stream.bind(this)
    this.registerProvider = this.registerProvider.bind(this)
    this.registerDialect = this.registerDialect.bind(this)
    this.providers = this.providers.bind(this)
    this.providerEndpoint = this.providerEndpoint.bind(this)
    this.hasKey = this.hasKey.bind(this)
    this.knownModels = this.knownModels.bind(this)
    this.replayTarget = this.replayTarget.bind(this)
    this.canReplay = this.canReplay.bind(this)
    this.nativeCompaction = this.nativeCompaction.bind(this)
    this.compact = this.compact.bind(this)
    for (const item of models) {
      const model = copyModelInfo(item.model)
      this.models.set(`${model.provider}/${model.id}`, structuredClone({ ...item, model }))
    }
  }

  /** Remote settings affect future admission waits; already accepted calls are never restarted. */
  setReconnectTimeout(timeoutMs: number): void {
    this.gate.configure(timeoutMs)
  }

  attach(
    connection: RemoteConnection,
    authority: RemoteWelcome,
    generation = () => authority.sessionGeneration,
  ): () => void {
    const peer = { connection, authority, generation }
    this.gate.attach(peer)
    for (const { call } of this.cancelled.values()) this.sendCancellation(call, peer)
    for (const { call } of this.receipts.values()) void this.resumeReceipts(call, peer)
    const detach = () => this.gate.detach(peer)
    void connection.closed.then(detach)
    return detach
  }

  receive(connection: RemoteConnection, frame: RemoteMessage): void {
    if (frame.kind !== "model.frame") return
    const active = this.calls.get(frame.callId)
    const call = active ?? this.receipts.get(frame.callId)?.call
    const peer = call?.peer
    if (!call || !peer || peer.connection !== connection || (active && call.terminal && !call.onUsage)) return
    if (
      frame.daemonEpoch !== peer.authority.daemonEpoch ||
      frame.controllerGeneration !== peer.authority.controllerGeneration ||
      frame.sessionGeneration !== call.generation
    )
      throw new Error("Stale model response authority")
    if (frame.seq <= call.received) return
    if (frame.seq !== call.received + 1) throw new Error("Model stream cursor gap")
    const payload = frame.payload as { [key: string]: RemoteJson }
    if (payload.kind === "receipt" && call.onUsage) {
      const received = decodeCompactReceipt(payload.data)
      // Late is relative to the REMOTE result too: an abort may beat a local completion.
      const receipt = !active || call.signal?.aborted ? { ...received, late: true } : received
      try {
        void Promise.resolve(call.onUsage(receipt)).catch(() => {})
      } catch {}
    }
    if (!active || call.terminal) {
      // Replay/cancellation may include buffered results before a late receipt. Consume cursors only.
      call.received = call.applied = frame.seq
      this.ack(call)
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify(frame.payload))
    if (call.queue.length >= 4096 || call.bytes + bytes > 32 * 1024 * 1024) {
      call.error = this.gate.latch(proxyFailure("proxy_retention_expired"), call.scope)
      call.terminal = true
      this.cancel(call)
    } else {
      call.queue.push({ seq: frame.seq, payload: frame.payload, bytes })
      call.bytes += bytes
      call.received = frame.seq
    }
    call.wake?.()
  }

  private metadata(model: Pick<ModelInfo, "provider" | "id">): ProxyModelMetadata {
    const item = this.models.get(`${model.provider}/${model.id}`)
    if (!item) throw new Error("Remote model metadata is unavailable")
    return item
  }
  model(ref: string): ModelInfo {
    const item = this.models.get(ref)
    if (!item) throw new Error("Remote model metadata is unavailable")
    return copyModelInfo(item.model)
  }
  providers(): ReturnType<Ai["providers"]> {
    const providers = new Map<string, ReturnType<Ai["providers"]>[number]>()
    for (const { model } of this.models.values()) {
      let provider = providers.get(model.provider)
      if (!provider) {
        // Synthetic identities for host model selection, never credential/endpoint objects.
        provider = { id: model.provider, dialect: model.dialect, baseUrl: "", models: [] }
        providers.set(model.provider, provider)
      }
      provider.models!.push(copyModelInfo(model))
    }
    return [...providers.values()]
  }
  providerEndpoint(_providerId: string): ReturnType<Ai["providerEndpoint"]> {
    throw new Error("Manage model credentials locally")
  }
  registerProvider(): void {
    throw new Error("Manage model credentials locally")
  }
  registerDialect(): void {
    throw new Error("Model dialects are owned by the local broker")
  }
  hasKey(provider: string): boolean {
    return [...this.models.values()].some((item) => item.model.provider === provider && item.available)
  }
  knownModels(): string[] {
    return [...this.models].filter(([, item]) => item.available).map(([ref]) => ref)
  }
  replayTarget(model: ModelInfo): ReplayTarget {
    const replay = this.metadata(model).replay
    return { ...replay, webSearch: replay.webSearch && model.caps.webSearch !== false }
  }
  canReplay(signature: Signature, model: ModelInfo, producer?: string): boolean {
    return canReplay(signature, this.replayTarget(model), producer)
  }
  nativeCompaction(model: ModelInfo): NativeCompaction | undefined {
    return structuredClone(this.metadata(model).native)
  }

  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    // Native async-generator return() queues behind next(); abort before forwarding cleanup.
    const controller = new AbortController()
    const iterator = this.streamEvents(
      request,
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      signal,
    )
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => iterator.next(),
          return: () => {
            controller.abort()
            return iterator.return(undefined)
          },
          throw: (error) => {
            controller.abort()
            return iterator.throw(error)
          },
        }
      },
    }
  }

  private async *streamEvents(
    request: ModelRequest,
    signal?: AbortSignal,
    scope?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const content: { type: "text" | "thinking"; text: string }[] = []
    try {
      for await (const payload of this.run("stream", request, signal, undefined, scope)) {
        if (signal?.aborted) throw proxyFailure("proxy_cancelled")
        if (payload.kind !== "stream") continue
        const event = decodeModelEvent(payload.data)
        if (event.type === "text.delta" || event.type === "thinking.delta") {
          const type = event.type === "text.delta" ? "text" : "thinking"
          const last = content.at(-1)
          if (last?.type === type) last.text += event.text
          else content.push({ type, text: event.text })
        } else if (event.type === "request.end") content.length = 0
        yield event
      }
    } catch (error) {
      const failure = this.failure(error)
      yield {
        type: "error",
        error: failure,
        retryable: false,
        message: {
          role: "assistant",
          model: { provider: request.model.provider, model: request.model.id },
          content,
          ...(failure.kind === "network"
            ? { usage: { ...emptyUsage(), pricingUnknown: true, outputReported: false } }
            : {}),
          stopReason: signal?.aborted ? "aborted" : "error",
        },
      }
    }
  }

  async compact(
    request: ModelRequest,
    signal?: AbortSignal,
    onProgress?: () => void,
    onUsage?: (receipt: CompactReceipt) => void | Promise<void>,
  ): Promise<CompactResult> {
    try {
      let result: CompactResult | undefined
      for await (const payload of this.run("compact", request, signal, onUsage)) {
        if (signal?.aborted) throw proxyFailure("proxy_cancelled")
        if (payload.kind === "progress") {
          try {
            onProgress?.()
          } catch {}
        }
        if (payload.kind === "compact") result = decodeCompactResult(payload.data)
      }
      if (result) return result
      throw proxyFailure("proxy_broker_lost")
    } catch (error) {
      const failure = this.failure(error)
      return {
        ok: false,
        error: failure.message,
        failure,
        usage:
          failure.kind === "network"
            ? { ...emptyUsage(), pricingUnknown: true, outputReported: false }
            : emptyUsage(),
        ...(failure.kind === "network" ? { usageIncomplete: true } : {}),
        tried: [],
        ...(signal?.aborted ? { aborted: true } : {}),
      }
    }
  }

  private failure(error: unknown): ModelError {
    if (error && typeof error === "object" && "code" in error && error.code === "model_binding_rejected")
      return {
        kind: "config",
        code: "model_binding_rejected",
        message: "Approve a local provider binding for this remote model",
      }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      ["proxy_reconnect_expired", "proxy_retention_expired", "proxy_cancelled"].includes(error.code)
    )
      return proxyFailure(error.code)
    return proxyFailure("proxy_broker_lost")
  }

  private async *run(
    operation: Call["operation"],
    request: ModelRequest,
    signal?: AbortSignal,
    onUsage?: Call["onUsage"],
    scope = signal,
  ): AsyncGenerator<{ [key: string]: RemoteJson }> {
    if (this.stopped) throw proxyFailure("proxy_cancelled")
    const metadata = this.metadata(request.model)
    if (!metadata.available) throw { code: "model_binding_rejected" }
    const call: Call = {
      id: randomUUID(),
      request,
      revision: metadata.revision,
      operation,
      signal,
      scope,
      onUsage,
      end: new AbortController(),
      queue: [],
      bytes: 0,
      applied: 0,
      received: 0,
      attempted: false,
      terminal: false,
    }
    this.calls.set(call.id, call)
    const abort = () => {
      call.error = proxyFailure("proxy_cancelled")
      call.terminal = true
      this.cancel(call)
      call.wake?.()
    }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    void this.drive(call)
    try {
      while (true) {
        // Explicit cancellation wins over buffered application data, including success.
        // Receipts are delivered independently by receive(), not by this application queue.
        if (signal?.aborted || this.stopped) throw proxyFailure("proxy_cancelled")
        const item = call.queue.shift()
        if (!item) {
          if (call.error) throw call.error
          if (call.terminal) return
          await new Promise<void>((resolve) => {
            call.wake = resolve
          })
          continue
        }
        call.bytes -= item.bytes
        const payload = item.payload as { [key: string]: RemoteJson }
        if (payload.kind === "failure") throw this.gate.latch(proxyFailure(String(payload.code)), scope)
        const terminal =
          payload.kind === "compact" || (payload.kind === "stream" && this.streamTerminal(payload.data))
        // Decoding/application is completed by the consumer before its applied ACK.
        yield payload
        // Cancellation may already have consumed later receipt-only cursors in receive().
        call.applied = Math.max(call.applied, item.seq)
        this.ack(call)
        if (signal?.aborted || this.stopped) throw proxyFailure("proxy_cancelled")
        if (terminal) {
          call.terminal = true
          return
        }
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      if (operation === "compact" && onUsage) this.retain(this.receipts, call)
      this.calls.delete(call.id)
      if (!call.terminal || call.error) this.cancel(call)
      call.terminal = true
      call.end.abort()
      call.wake?.()
    }
  }

  private streamTerminal(data: RemoteJson | undefined): boolean {
    const event = decodeModelEvent(data)
    return event.type === "done" || event.type === "error"
  }

  private ack(call: Call): void {
    if (!call.peer || !call.admitted) return
    void call.peer.connection
      .send({ v: 1, kind: "ack", channel: "model", id: call.id, seq: call.applied })
      .catch(() => {})
  }

  private retain(map: Map<string, { call: Call; timer: ReturnType<typeof setTimeout> }>, call: Call): void {
    if (this.stopped) return
    const previous = map.get(call.id)
    if (previous) clearTimeout(previous.timer)
    if (map.size >= 128 && !previous) {
      const [id, oldest] = map.entries().next().value!
      clearTimeout(oldest.timer)
      map.delete(id)
    }
    // Disabling admission expiry does not make terminal receipt retention unbounded.
    const timer = setTimeout(() => map.delete(call.id), this.gate.timeoutMs || 10 * 60_000)
    timer.unref()
    map.set(call.id, { call, timer })
  }

  private cancel(call: Call): void {
    if (!call.attempted) return
    this.retain(this.cancelled, call)
    if (call.peer) this.sendCancellation(call, call.peer)
  }

  private sendCancellation(call: Call, peer: Peer): void {
    if (call.peer && call.peer.authority.daemonEpoch !== peer.authority.daemonEpoch) return
    void peer.connection
      .send({
        v: 1,
        kind: "cancel",
        channel: "model",
        id: call.id,
        controllerGeneration: peer.authority.controllerGeneration,
        sessionGeneration: call.generation,
      })
      .catch(() => {})
  }

  private async resumeReceipts(call: Call, peer: Peer): Promise<void> {
    if (call.peer?.authority.daemonEpoch !== peer.authority.daemonEpoch) return
    call.peer = peer
    call.admitted = false
    try {
      await peer.connection.request(
        "model.open",
        {
          callId: call.id,
          revision: call.revision,
          operation: "compact",
          request: encodeModelRequest(call.request) as unknown as RemoteJson,
          resume: true,
          after: call.received,
        },
        { channel: "model", sessionGeneration: call.generation },
      )
      call.admitted = true
      this.ack(call)
    } catch {
      /* An expired receipt window must never reissue compaction. */
    }
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true
    for (const call of this.calls.values()) {
      this.cancel(call)
      call.error = proxyFailure("proxy_cancelled")
      call.terminal = true
      call.end.abort()
      call.wake?.()
    }
    for (const map of [this.cancelled, this.receipts]) {
      for (const entry of map.values()) clearTimeout(entry.timer)
      map.clear()
    }
  }

  private async drive(call: Call): Promise<void> {
    try {
      while (!call.terminal) {
        const signal = call.signal ? AbortSignal.any([call.signal, call.end.signal]) : call.end.signal
        const peer = await this.gate.wait(signal, call.scope)
        if (call.terminal) return
        call.peer = peer
        call.admitted = false
        call.generation ??= peer.generation()
        try {
          const resume = call.attempted
          call.attempted = true
          await peer.connection.request(
            "model.open",
            {
              callId: call.id,
              revision: call.revision,
              operation: call.operation,
              request: encodeModelRequest(call.request) as unknown as RemoteJson,
              resume,
              after: call.applied,
            },
            { channel: "model", signal, sessionGeneration: call.generation },
          )
          call.admitted = true
          this.ack(call)
          await new Promise<void>((resolve) => {
            const done = () => {
              signal.removeEventListener("abort", done)
              resolve()
            }
            signal.addEventListener("abort", done, { once: true })
            void peer.connection.closed.then(done)
            if (signal.aborted) done()
          })
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code !== "disconnected" &&
            error.code !== "cancelled"
          )
            throw proxyFailure(typeof error.code === "string" ? error.code : "proxy_broker_lost")
        }
        if (call.terminal || signal.aborted) return
        this.gate.detach(peer)
        // Retain queued frames. Replay overlap is deduplicated against the received cursor.
      }
    } catch (error) {
      call.error = this.gate.latch(this.failure(error), call.scope)
      call.terminal = true
      call.wake?.()
    }
  }
}

export const createProxyAi = (models: ProxyModelMetadata[], options?: { reconnectTimeoutMs?: number }) =>
  new ProxyAi(models, options)
