import { createHash, randomBytes } from "node:crypto"
import { FrontendOperationError, type FrontendOperations } from "@amira/core"
import { frontendJson } from "../../../core/src/frontend/json.ts"
import { RemoteConnection, type RemoteIO } from "../remote/connection.ts"
import { RemoteError, RemoteReplyError } from "../remote/errors.ts"
import type { PreparedRemoteMessage } from "../remote/peer-compat.ts"
import {
  ATTACH_ROLES,
  CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY,
  REMOTE_LIMITS,
  REMOTE_OPERATION_ACCESS,
  REMOTE_PEER_LIMITS,
  type RemoteAttachedClient,
  type RemoteAttachment,
  type RemoteJson,
  type RemoteRelease,
  type RemoteRequest,
} from "../remote/protocol.ts"
import { attachedClient, attachIntent, rolesEnabledOn } from "./attach-intent.ts"
import { Controller, type ControllerLease, type ControllerOptions } from "./controller.ts"
import { EventFrameCache } from "./frame-cache.ts"
import { OperationLedger, type OperationLedgerOptions } from "./operation-ledger.ts"
import { OperationObservers } from "./operation-observers.ts"
import type { ServerOperations } from "./operations.ts"
import type { WorkspaceReader } from "./reader.ts"
import type { ServerEffect, WorkspaceAttachment, WorkspaceRuntime } from "./runtime.ts"

type Delivery = Parameters<RemoteConnection["send"]>[0]
type Frontend = Pick<WorkspaceAttachment, "supportedOperations" | "execute" | "request">
const authorities = new WeakMap<WorkspaceRuntime, WorkspaceAttachments>()
type AttachmentOptions = ControllerOptions & {
  heartbeatMs?: number
  /** Test seam for ledger windows and clocks; the defaults are the documented limits. */
  ledger?: Omit<OperationLedgerOptions, "inUse">
  /** Honor attachment roles (viewers, takeover). Defaults to platforms with daemon peer checks. */
  roles?: boolean
}

/** A slow viewer is closed sooner than the controller; it resumes from its cursor. */
const VIEWER_QUEUE = { frames: REMOTE_LIMITS.queuedFrames, bytes: 16 * 1024 * 1024 }
const CONTROLLER_QUEUE = { frames: REMOTE_LIMITS.queuedFrames, bytes: REMOTE_LIMITS.queuedBytes }
/** Initial viewer snapshots held for delivery at once; each can be up to the logical frame limit. */
const VIEWER_SNAPSHOTS = 2

/** One live connection per clientId: a clientId names one frontend process. */
interface Live {
  connection: RemoteConnection
  role: "controller" | "viewer"
  /** The peer understands roles and receives attachment frames. */
  roles: boolean
  client: RemoteAttachedClient
  since: number
  notify(frame: RemoteAttachment): void
}

/** Exactly one controller/ledger authority per runtime, never one per transport. */
export function workspaceAttachments(
  runtime: WorkspaceRuntime,
  options?: AttachmentOptions,
): WorkspaceAttachments {
  let authority = authorities.get(runtime)
  if (!authority) {
    authority = new WorkspaceAttachments(runtime, options)
    authorities.set(runtime, authority)
  }
  return authority
}

class WorkspaceAttachments {
  #controller: Controller
  #ledger: OperationLedger
  #active?: { connection: RemoteConnection; attachment: WorkspaceAttachment }
  #live = new Map<string, Live>()
  /** Display identity of the lease holder, attached or in grace. */
  #holder?: RemoteAttachedClient
  #viewerSnapshots = 0
  #graceTimer?: ReturnType<typeof setTimeout>
  #frames = new EventFrameCache()
  #operations = new Map<string, { abort: AbortController; sessionGeneration: number }>()
  #observers = new OperationObservers()
  #effect = (effect: ServerEffect) => {
    this.runtime.journal.append(frontendJson({ kind: "effect", effect }))
  }

  #heartbeatMs: number
  #roles: boolean

  constructor(
    private runtime: WorkspaceRuntime,
    options?: AttachmentOptions,
  ) {
    this.#controller = new Controller(options)
    this.#ledger = new OperationLedger({
      maxPayloadBytes: REMOTE_LIMITS.logicalBytes,
      ...options?.ledger,
      // The lease holder, attached or in grace, may still resend: never forget its ids.
      inUse: (clientId) => this.#controller.holds(clientId),
    })
    this.#heartbeatMs = options?.heartbeatMs ?? 15_000
    this.#roles = options?.roles ?? rolesEnabledOn()
    if (!Number.isSafeInteger(this.#heartbeatMs) || this.#heartbeatMs < 0)
      throw new RangeError("Heartbeat interval must be a nonnegative safe integer")
  }

  /** Live viewer connections. Viewers never keep the daemon alive or block a replacement. */
  get viewers(): number {
    let count = 0
    for (const live of this.#live.values()) if (live.role === "viewer") count++
    return count
  }

  #scope(clientId: string) {
    return { clientId, controllerToken: this.runtime.journal.daemonEpoch }
  }

  #presence(): RemoteAttachment {
    const state = this.#controller.state()
    const now = Date.now()
    const viewers = [...this.#live.values()].filter((live) => live.role === "viewer")
    return {
      v: 1,
      kind: "attachment",
      daemonEpoch: this.runtime.journal.daemonEpoch,
      controller: { ...state, ...(state.state !== "none" && this.#holder ? { client: this.#holder } : {}) },
      viewers: viewers.map((live) => ({ client: live.client, attachedMs: Math.max(0, now - live.since) })),
    }
  }

  /** Level-triggered: every roles peer gets the full presence after any change. */
  #broadcast(): void {
    clearTimeout(this.#graceTimer)
    const frame = this.#presence()
    for (const live of this.#live.values()) if (live.roles) live.notify(frame)
    // Grace runs out without an event; announce it when it does.
    if (frame.controller.graceRemainingMs !== undefined) {
      this.#graceTimer = setTimeout(() => this.#broadcast(), frame.controller.graceRemainingMs + 1)
      this.#graceTimer.unref?.()
    }
  }

  async #execute(
    frontend: Frontend,
    accepted: RemoteJson,
    id: string,
    operationKey?: string,
    abort = new AbortController(),
  ): Promise<RemoteJson> {
    const admitted = accepted as unknown as Pick<RemoteRequest, "op" | "params" | "sessionGeneration">
    if (operationKey)
      this.#operations.set(operationKey, { abort, sessionGeneration: admitted.sessionGeneration })
    try {
      const options = { sessionGeneration: admitted.sessionGeneration, signal: abort.signal, operationId: id }
      const result = frontend.supportedOperations?.includes(admitted.op as keyof FrontendOperations)
        ? await frontend.execute(admitted.op as keyof FrontendOperations, admitted.params as never, options)
        : await frontend.request(admitted.op as keyof ServerOperations, admitted.params as never, options)
      return frontendJson(result)
    } catch (error) {
      if (error instanceof FrontendOperationError)
        throw new RemoteReplyError(error.code, "The workspace operation could not be applied")
      throw error
    } finally {
      if (operationKey && this.#operations.get(operationKey)?.abort === abort)
        this.#operations.delete(operationKey)
    }
  }

  connect(io: RemoteIO, options: { release: RemoteRelease; workspace: string }): RemoteConnection {
    let lease: ControllerLease | undefined
    let attachment: WorkspaceAttachment | undefined
    let reader: WorkspaceReader | undefined
    let live: Live | undefined
    let capabilities: readonly string[] = []
    let limits = CONTROLLER_QUEUE
    let snapshotPending = false
    let unsubscribe: (() => void) | undefined
    let ended = false
    let pumping = false
    let queuedBytes = 0
    let sent = 0
    let applied = 0
    let lastPong = Date.now()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    // The connection bounds inbound identities. Completed observations keep their admitted
    // context too: a lost response may be cancelled after selection has moved on.
    const observations = new Map<string, { sessionGeneration: number; read: boolean }>()
    const reads = new Map<string, AbortController>()
    const queue: { prepared: PreparedRemoteMessage; bytes: number }[] = []
    // The immutable cut is separately bounded by journal retention/snapshot limits. Stream it
    // after welcome instead of filling the live queue while ready is still unresolved.
    let replay: (Delivery | undefined)[] = []
    let replayIndex = 0
    const releaseSnapshot = () => {
      if (!snapshotPending) return
      snapshotPending = false
      this.#viewerSnapshots--
    }
    const key = (id: string) => JSON.stringify([lease!.clientId, this.runtime.journal.daemonEpoch, id])
    const current = () => {
      if (ended || (!lease && !reader)) throw new RemoteError("disconnected", "Remote attachment unavailable")
      if (lease) this.#controller.assertCurrent(lease.clientId, lease.controllerGeneration)
    }
    const pump = async () => {
      if (pumping || ended) return
      pumping = true
      try {
        while ((replayIndex < replay.length || queue.length) && !ended) {
          const initial = replay[replayIndex]
          if (initial) {
            replay[replayIndex++] = undefined
            if (initial.kind === "event" || initial.kind === "reset") sent = initial.seq
            await connection.send(initial)
            if (initial.kind === "reset") releaseSnapshot()
            continue
          }
          const item = queue.shift()!
          const message = item.prepared.message
          if (message.kind === "event" || message.kind === "reset") sent = message.seq
          await connection.sendPrepared(item.prepared)
          queuedBytes -= item.bytes
        }
      } catch (error) {
        connection.close(error)
      } finally {
        pumping = false
      }
    }
    const enqueue = (message: Delivery) => {
      if (ended) return
      let prepared: PreparedRemoteMessage | undefined
      try {
        // Gated per peer and encoded once per gate set; bytes is the real frame size.
        prepared = this.#frames.prepare(message, capabilities)
      } catch (error) {
        connection.close(error)
        return
      }
      if (!prepared) return
      const bytes = prepared.bytes.byteLength
      if (queue.length >= limits.frames || queuedBytes + bytes > limits.bytes) {
        connection.close(new RemoteError("limit_exceeded", "Attachment replay queue exceeded"))
        return
      }
      queue.push({ prepared, bytes })
      queuedBytes += bytes
      void pump()
    }
    const connection = new RemoteConnection(io, {
      handshake: {
        role: "server",
        accept: (hello) => {
          if (this.runtime.signal.aborted) throw new RemoteError("disconnected", "Workspace stopped")
          if (hello.workspace !== options.workspace)
            throw new RemoteReplyError("invalid_workspace", "Workspace selector does not match")
          const sameEpoch = hello.resume?.daemonEpoch === this.runtime.journal.daemonEpoch
          // A forgotten client's earlier ids are no longer deduplicated; it must use a new clientId.
          if (this.#ledger.isForgotten(this.#scope(hello.clientId)))
            throw new RemoteReplyError("permission_denied", "Controller reconnect credentials expired")
          capabilities = hello.capabilities
          const intent = attachIntent(hello.capabilities, this.#roles)
          const roles = intent !== "legacy"
          const token = sameEpoch && hello.resume ? hello.resume.controllerToken : undefined
          const servesModels = Boolean(this.runtime.modelProxy) && hello.capabilities.includes("model.proxy")
          let taken: RemoteConnection | undefined
          if (intent === "take") {
            const result = this.#controller.take({ clientId: hello.clientId, servesModels })
            lease = result.lease
            // Only another attached client is told; the taker's own old connection is just fenced.
            if (result.previous?.attached && result.previous.lease.clientId !== hello.clientId)
              taken = this.#active?.connection
          } else if (intent !== "viewer") {
            try {
              lease = this.#controller.attach({
                clientId: hello.clientId,
                ...(token ? { controllerToken: token } : {}),
                roles,
                servesModels,
              })
            } catch (error) {
              // auto never reinterprets a refused acquisition: it attaches as a viewer instead.
              const busy =
                error instanceof RemoteReplyError &&
                (error.code === "controller_busy" || error.code === "permission_denied")
              if (intent !== "auto" || !busy) throw error
            }
          }
          const older = this.#live.get(hello.clientId)
          const busy = () =>
            new RemoteReplyError("workspace_busy", "Too many viewers are loading; retry shortly")
          if (!lease) {
            const others = this.viewers - (older?.role === "viewer" ? 1 : 0)
            if (others >= REMOTE_LIMITS.viewers)
              throw new RemoteReplyError("limit_exceeded", "This workspace has the maximum number of viewers")
            // A hello that certainly needs a snapshot is refused before one is built.
            if (this.#viewerSnapshots >= VIEWER_SNAPSHOTS && (!sameEpoch || hello.snapshot === true))
              throw busy()
            limits = VIEWER_QUEUE
          }
          // The lease has moved: fence its previous connection before anything else can fail.
          if (lease) {
            // The old connection is fenced before releasing its frontend; late EOF cannot release us.
            if (taken) {
              taken.reject({ code: "controller_taken", message: "Another client took control" })
              // It is no longer present; its final frame must be the reject.
              for (const [clientId, entry] of this.#live)
                if (entry.connection === taken) this.#live.delete(clientId)
            } else this.#active?.connection.close()
            void this.#active?.attachment.detach()
            attachment = this.runtime.attach({ onEffect: this.#effect })
            this.#active = { connection, attachment }
            this.#holder = attachedClient(hello.release)
          } else {
            reader = this.runtime.reader()
            // The holder hands control back by reconnecting as a viewer with its own token.
            const released =
              intent === "viewer" &&
              token !== undefined &&
              this.#controller.release({ clientId: hello.clientId, controllerToken: token })
            if (released) {
              this.#active?.connection.close()
              void this.#active?.attachment.detach()
              this.#active = undefined
            }
          }
          const cut = this.runtime.journal.open(
            hello.resume,
            () => this.runtime.workspaceSnapshot(),
            enqueue,
            hello.snapshot === true,
          )
          unsubscribe = cut.close
          if (!lease && cut.initial.some((message) => message.kind === "reset")) {
            if (this.#viewerSnapshots >= VIEWER_SNAPSHOTS) throw busy()
            snapshotPending = true
            this.#viewerSnapshots++
          }
          // Admitted: the clientId's older connection goes, as with a fenced reconnect.
          older?.connection.close()
          live = {
            connection,
            role: lease ? "controller" : "viewer",
            roles,
            client: attachedClient(hello.release),
            since: Date.now(),
            notify: enqueue,
          }
          this.#live.set(hello.clientId, live)
          replay = cut.initial
          if (hello.resume && !cut.initial.some((message) => message.kind === "reset"))
            sent = applied = hello.resume.after
          void pump()
          // Presence follows this connection's initial replay on its own queue.
          this.#broadcast()
          return {
            v: 1,
            kind: "welcome",
            release: options.release,
            workspace: options.workspace,
            workspaceId: createHash("sha256").update(options.workspace).digest("hex"),
            daemonEpoch: this.runtime.journal.daemonEpoch,
            // A viewer's generation 0 is never a real one, and its token grants nothing.
            controllerGeneration: lease?.controllerGeneration ?? 0,
            controllerToken: lease?.controllerToken ?? randomBytes(32).toString("hex"),
            sessionGeneration: (attachment ?? reader)!.identity!.sessionGeneration,
            limits: REMOTE_PEER_LIMITS,
            capabilities: [
              CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY,
              "frontend.v1",
              "replay",
              "controller",
              "mutation.ledger",
              "files",
              "images",
              "jobs",
              "conversations",
              ...(this.runtime.modelProxy ? ["model.proxy"] : ["model.remote-key"]),
              ...(roles ? [ATTACH_ROLES] : []),
            ],
            ...(roles ? { role: lease ? ("controller" as const) : ("viewer" as const) } : {}),
          }
        },
      },
      handle: (request, transportSignal) => {
        current()
        if (request.controllerGeneration !== (lease?.controllerGeneration ?? 0))
          throw new RemoteReplyError("stale_controller", "Stale controller generation")
        const frontend: Frontend | undefined = attachment ?? reader
        if (!frontend) throw new RemoteError("disconnected", "No workspace frontend")
        if (request.op === "model.open" || request.op === "model.stream" || request.op === "model.compact")
          throw new RemoteError("unsupported_operation", "Model routing is not configured")
        if (request.daemonEpoch !== this.runtime.journal.daemonEpoch)
          throw new RemoteReplyError("outcome_unknown", "The operation belongs to another daemon epoch")
        if (!lease && !REMOTE_OPERATION_ACCESS[request.op].viewer)
          throw new RemoteReplyError("not_controller", "Only the controller may run this operation")
        const identity = (attachment ?? reader)!.identity
        const payload = {
          op: request.op,
          params: request.params,
          sessionGeneration: request.sessionGeneration,
        }
        const id = request.id
        const unledgered = !REMOTE_OPERATION_ACCESS[request.op].ledger
        // Evaluations keep their editor's revision check instead; a lost reply is read again.
        if (
          unledgered &&
          request.op !== "form.evaluate" &&
          request.sessionGeneration !== identity?.sessionGeneration
        )
          throw new RemoteReplyError("stale_session", "The active session changed")
        observations.set(id, { sessionGeneration: request.sessionGeneration, read: unledgered })
        if (unledgered) {
          const abort = new AbortController()
          reads.set(id, abort)
          return this.#execute(frontend, payload, id, undefined, abort).finally(() => reads.delete(id))
        }
        // Connection EOF aborts its own handlers, NOT admitted workspace operations.
        // Retain ids for a client even if it later recovers with a fresh controller token.
        const scope = this.#scope(lease!.clientId)
        // Admission starts synchronously, but execution must not retain this transport's scope.
        const operationKey = key(id)
        const run = (accepted: RemoteJson) => this.#execute(frontend, accepted, id, operationKey)
        const result = this.#observers.wait(this.#ledger.run(scope, id, payload, run), transportSignal)
        if (request.op === "proxy.bind")
          return result.then((value) => {
            current()
            this.runtime.modelProxy?.admit(connection)
            return value
          })
        return result
      },
      onCancel: (id, frame) => {
        current()
        if (
          (frame.channel !== "control" && frame.channel !== "files") ||
          frame.controllerGeneration !== (lease?.controllerGeneration ?? 0)
        )
          throw new RemoteError("invalid_frame", "Stale cancellation authority")
        const observation = observations.get(id)
        // A viewer has no ledgered operations; it can only abort its own reads.
        const operation = observation?.read || !lease ? undefined : this.#operations.get(key(id))
        if (
          frame.sessionGeneration !==
          (operation?.sessionGeneration ??
            observation?.sessionGeneration ??
            (attachment ?? reader)?.identity?.sessionGeneration)
        )
          throw new RemoteError("invalid_frame", "Stale cancellation authority")
        operation?.abort.abort()
        reads.get(id)?.abort()
      },
      onMessage: (message) => {
        current()
        if (message.kind === "model.frame") {
          // A viewer never serves models; its model frames are ignored, not fatal.
          if (lease) this.runtime.modelProxy?.receive(connection, message)
          return
        }
        if (message.kind === "pong" && message.id === "heartbeat") lastPong = Date.now()
        if (message.kind !== "ack") return
        if (
          message.channel !== "control" ||
          message.id !== this.runtime.journal.daemonEpoch ||
          message.seq < applied ||
          message.seq > sent
        )
          throw new RemoteError("invalid_frame", "Invalid applied replay cursor")
        applied = message.seq
      },
    })
    void connection.ready
      .then((welcome) => {
        if (ended) return
        // Only a controller is the model peer: a viewer must never displace a serving one.
        if (lease)
          this.runtime.modelProxy?.attach(
            connection,
            welcome,
            () => attachment!.identity!.sessionGeneration,
            {
              paused: true,
            },
          )
        if (!this.#heartbeatMs) return
        lastPong = Date.now()
        heartbeat = setInterval(() => {
          if (Date.now() - lastPong > this.#heartbeatMs * 3) connection.close()
          else void connection.send({ v: 1, kind: "ping", id: "heartbeat" }).catch(() => connection.close())
        }, this.#heartbeatMs)
        heartbeat.unref()
      })
      .catch(() => {})
    const stop = () => connection.close()
    this.runtime.signal.addEventListener("abort", stop, { once: true })
    void connection.closed.then(() => {
      ended = true
      clearInterval(heartbeat)
      queue.length = 0
      replay.length = 0
      releaseSnapshot()
      observations.clear()
      for (const abort of reads.values()) abort.abort()
      reads.clear()
      reader?.close()
      unsubscribe?.()
      this.runtime.signal.removeEventListener("abort", stop)
      if (lease) this.#controller.detach(lease.clientId, lease.controllerGeneration)
      void attachment?.detach()
      if (this.#active?.connection === connection) this.#active = undefined
      for (const [clientId, entry] of this.#live) if (entry === live) this.#live.delete(clientId)
      // A refused hello that already moved the lease changed presence too.
      if ((live || lease) && !this.runtime.signal.aborted) this.#broadcast()
    })
    return connection
  }
}
