import type { AnyEvent } from "@amira/api"
import type {
  AgentPort,
  FrontendExecuteOptions,
  FrontendOperations,
  FrontendSnapshot,
  FrontendUpdate,
} from "@amira/core"
import type { RemoteWorkspaceSnapshot } from "../remote-schema.ts"
import type { ServerOperations } from "../server/operations.ts"
import { RemoteAgentOperations } from "./agent-port-operations.ts"
import { RemoteAgentState, type RemoteWorkspaceUpdate } from "./agent-port-state.ts"
import { RemoteConnection, type RemoteIO } from "./connection.ts"
import { RemoteError, RemoteReplyError } from "./errors.ts"
import type { ModelBrokerPeer } from "./model-peer.ts"
import type { RemoteHello, RemoteMessage, RemoteReset, RemoteWelcome } from "./protocol.ts"
import { RemoteReplay } from "./replay.ts"

export type RemoteAgentStatus = "connecting" | "connected" | "reconnecting" | "disconnected" | "detached"
export interface RemoteEventContext {
  readonly replay: boolean
  readonly seq: number
}
export interface RemoteAgentPortOptions {
  /** Each attempt supplies a fresh byte transport. The port owns and closes it, never the daemon. */
  connect(signal: AbortSignal): Promise<RemoteIO>
  hello: RemoteHello
  /** Deployment/release policy runs before any snapshot is exposed. */
  validateWelcome?(welcome: RemoteWelcome): void
  /** Retained local broker; no provider credentials/configuration enter the remote port. */
  brokerPeer?: Pick<ModelBrokerPeer, "connect">
}

/** Codec-backed, detachable frontend. Reconnect is explicit so deployment owns retry policy. */
export class RemoteAgentPort implements AgentPort {
  readonly quitBehavior = "detach" as const
  private state = new RemoteAgentState()
  private transport?: RemoteConnection
  private disconnectedBy?: unknown
  private welcome?: RemoteWelcome
  private lifetime = new AbortController()
  private connecting?: Promise<void>
  private needsSnapshot = true
  private operations = new RemoteAgentOperations()
  private listeners = new Set<(update: FrontendUpdate) => void>()
  private events = new Set<(event: AnyEvent, context: RemoteEventContext) => void>()
  private updates = new Set<(update: RemoteWorkspaceUpdate, context: RemoteEventContext) => void>()
  private resets = new Set<(snapshot: RemoteWorkspaceSnapshot, reason: RemoteReset["reason"]) => void>()
  private statuses = new Set<(status: RemoteAgentStatus) => void>()
  private currentStatus: RemoteAgentStatus = "connecting"
  private replay = new RemoteReplay({
    reset: (value, reason) => {
      this.state.reset(value)
      this.needsSnapshot = false
      this.publish(this.listeners, { kind: "snapshot", snapshot: this.snapshot, reset: true })
      for (const listener of this.resets) this.notify(() => listener(this.workspaceSnapshot, reason))
    },
    event: (value, context) => {
      const update = this.state.apply(value)
      if ("kind" in update) {
        if (update.kind === "snapshot" || update.kind === "error") this.publish(this.listeners, update)
      } else for (const listener of this.events) this.notify(() => listener(localEvent(update), context))
      for (const listener of this.updates) this.notify(() => listener(update, context))
    },
  })

  constructor(private options: RemoteAgentPortOptions) {}

  get status(): RemoteAgentStatus {
    return this.currentStatus
  }
  /** Preserved local EOF/protocol/process cause for attach retry policy. */
  get disconnectionReason(): unknown {
    return this.disconnectedBy
  }
  get connection(): "connecting" | "connected" | "reconnecting" | "disconnected" {
    return this.currentStatus === "detached" ? "disconnected" : this.currentStatus
  }
  subscribeConnection(listener: () => void): () => void {
    return this.subscribeStatus(listener)
  }
  get authority(): RemoteWelcome | undefined {
    return this.welcome
  }
  get identity() {
    return { sessionId: this.snapshot.state.sessionId, sessionGeneration: this.snapshot.sessionGeneration }
  }
  get sessionGeneration(): number {
    return this.identity.sessionGeneration
  }
  get snapshot(): FrontendSnapshot {
    return this.workspaceSnapshot.frontend
  }
  get workspaceSnapshot(): RemoteWorkspaceSnapshot {
    if (!this.state.workspace) throw new RemoteError("disconnected", "Remote snapshot is not available")
    return this.state.workspace
  }
  get pendingRequests() {
    return this.workspaceSnapshot.pendingRequests
  }
  /** Startup diagnostics are presentation input, separate from replayed live events. */
  get startupEvents(): readonly AnyEvent[] {
    return this.workspaceSnapshot.startupEvents.map((event) =>
      localEvent(event as import("../server/runtime.ts").ServerEvent),
    )
  }
  get cursor() {
    return this.replay.cursor
  }
  subscribe(listener: (update: FrontendUpdate) => void): () => void {
    return this.listen(this.listeners, listener)
  }
  subscribeEvents(listener: (event: AnyEvent, context: RemoteEventContext) => void): () => void {
    return this.listen(this.events, listener)
  }
  subscribeWorkspace(
    listener: (update: RemoteWorkspaceUpdate, context: RemoteEventContext) => void,
  ): () => void {
    return this.listen(this.updates, listener)
  }
  subscribeReset(
    listener: (snapshot: RemoteWorkspaceSnapshot, reason: RemoteReset["reason"]) => void,
  ): () => void {
    return this.listen(this.resets, listener)
  }
  subscribeStatus(listener: (status: RemoteAgentStatus) => void): () => void {
    return this.listen(this.statuses, listener)
  }

  reconnect(): Promise<void> {
    if (this.lifetime.signal.aborted)
      return Promise.reject(new RemoteError("disconnected", "Remote frontend detached"))
    if (this.connecting) return this.connecting
    this.setStatus(this.welcome ? "reconnecting" : "connecting")
    this.connecting = this.attach().finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  private async attach(): Promise<void> {
    const previous = this.transport
    this.disconnectedBy = undefined
    this.transport = undefined
    previous?.close()
    let connection: RemoteConnection | undefined
    try {
      const io = await this.options.connect(this.lifetime.signal)
      if (this.lifetime.signal.aborted) {
        io.close()
        throw new RemoteError("disconnected", "Remote frontend detached")
      }
      const cursor = this.replay.cursor
      const token = this.welcome?.controllerToken
      const hello: RemoteHello = {
        ...this.options.hello,
        snapshot: this.needsSnapshot,
        ...(cursor && token ? { resume: { ...cursor, controllerToken: token } } : {}),
      }
      const receive = (message: RemoteMessage) => {
        if (this.transport !== connection) return
        if (message.kind !== "reset" && message.kind !== "event") return
        try {
          if (!this.replay.receive(message)) return
          const ack = this.replay.acknowledgement()
          if (ack) void connection!.send(ack).catch(() => connection!.close())
        } catch (error) {
          this.needsSnapshot = true
          throw error
        }
      }
      connection = this.options.brokerPeer
        ? this.options.brokerPeer.connect(io, hello, receive, this.options.validateWelcome)
        : new RemoteConnection(io, {
            handshake: { role: "client", hello, validateWelcome: this.options.validateWelcome },
            onMessage: receive,
          })
      this.transport = connection
      const closed = connection.closed.then(() => {
        if (this.transport === connection && !this.lifetime.signal.aborted) {
          this.disconnectedBy = connection?.failureReason
          this.setStatus("disconnected")
        }
      })
      const welcome = await connection.ready
      this.welcome = Object.freeze(welcome)
      // A fresh attachment must expose a real immutable snapshot before callers mount a UI.
      if (this.needsSnapshot) {
        let off = () => {}
        try {
          await Promise.race([
            new Promise<void>((resolve) => {
              off = this.subscribeReset(() => resolve())
            }),
            closed.then(() => {
              throw (
                connection?.failureReason ??
                new RemoteError("disconnected", "Remote snapshot was not delivered")
              )
            }),
          ])
        } finally {
          off()
        }
      }
      if (this.lifetime.signal.aborted || this.transport !== connection || this.status === "disconnected")
        throw connection.failureReason ?? new RemoteError("disconnected", "Remote attachment unavailable")
      this.setStatus("connected")
    } catch (error) {
      connection?.close(error)
      if (!this.lifetime.signal.aborted) {
        this.disconnectedBy = error
        this.setStatus("disconnected")
      }
      throw error
    }
  }

  execute<K extends keyof FrontendOperations>(
    operation: K,
    params: FrontendOperations[K]["params"],
    options?: FrontendExecuteOptions,
  ): Promise<FrontendOperations[K]["result"]> {
    if ((operation === "state.read" || operation === "transcript.read") && this.state.error)
      return Promise.reject(new RemoteReplyError("invalid_snapshot", this.state.error.error.message))
    return this.run(operation, params, options)
  }
  request<K extends keyof ServerOperations>(
    operation: K,
    params: ServerOperations[K]["params"],
    options?: FrontendExecuteOptions,
  ): Promise<ServerOperations[K]["result"]> {
    return this.run(operation, params, options)
  }
  private run<K extends keyof (FrontendOperations & ServerOperations)>(
    operation: K,
    params: (FrontendOperations & ServerOperations)[K]["params"],
    options: FrontendExecuteOptions = {},
  ): Promise<(FrontendOperations & ServerOperations)[K]["result"]> {
    const connection = this.transport
    if (!connection || !this.welcome || this.status !== "connected")
      return Promise.reject(new RemoteError("disconnected", "Remote attachment unavailable"))
    return this.operations.run(
      connection,
      this.welcome,
      this.identity.sessionGeneration,
      operation,
      params,
      options,
    )
  }

  async detach(): Promise<void> {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort()
    this.transport?.close()
    this.setStatus("detached")
    this.listeners.clear()
    this.events.clear()
    this.updates.clear()
    this.resets.clear()
    this.statuses.clear()
    this.operations.clear()
  }
  private listen<T>(listeners: Set<T>, listener: T): () => void {
    if (!this.lifetime.signal.aborted) listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  private notify(run: () => void): void {
    try {
      run()
    } catch {
      /* A renderer cannot corrupt the acknowledged protocol state. */
    }
  }
  private publish<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) this.notify(() => listener(value))
  }
  private setStatus(status: RemoteAgentStatus): void {
    this.currentStatus = status
    this.publish(this.statuses, status)
  }
}

export async function createRemoteAgentPort(options: RemoteAgentPortOptions): Promise<RemoteAgentPort> {
  const port = new RemoteAgentPort(options)
  try {
    await port.reconnect()
    return port
  } catch (error) {
    await port.detach()
    throw error
  }
}

function localEvent(event: import("../server/runtime.ts").ServerEvent): AnyEvent {
  if (event.type !== "ui.request" || event.data.kind !== "select") return event as AnyEvent
  return {
    ...event,
    data: {
      ...event.data,
      optionStatuses: event.data.optionStatuses?.map((status) => status ?? undefined),
      optionExtensionStatuses: event.data.optionExtensionStatuses?.map((status) => status ?? undefined),
    },
  }
}
