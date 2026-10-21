import { createHash } from "node:crypto"
import { FrontendOperationError, type FrontendOperations } from "@amira/core"
import { frontendJson } from "../../../core/src/frontend/json.ts"
import { RemoteConnection, type RemoteIO } from "../remote/connection.ts"
import { RemoteError, RemoteReplyError } from "../remote/errors.ts"
import {
  REMOTE_LIMITS,
  REMOTE_PEER_LIMITS,
  type RemoteJson,
  type RemoteRelease,
  type RemoteRequest,
} from "../remote/protocol.ts"
import { Controller, type ControllerLease, type ControllerOptions } from "./controller.ts"
import { OperationLedger } from "./operation-ledger.ts"
import { OperationObservers } from "./operation-observers.ts"
import type { ServerOperations } from "./operations.ts"
import type { ServerEffect, WorkspaceAttachment, WorkspaceRuntime } from "./runtime.ts"

type Delivery = Parameters<RemoteConnection["send"]>[0]
const authorities = new WeakMap<WorkspaceRuntime, WorkspaceAttachments>()

/** Exactly one controller/ledger authority per runtime, never one per transport. */
export function workspaceAttachments(
  runtime: WorkspaceRuntime,
  options?: ControllerOptions & { heartbeatMs?: number },
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
  #ledger = new OperationLedger({ maxPayloadBytes: REMOTE_LIMITS.logicalBytes })
  #active?: { connection: RemoteConnection; attachment: WorkspaceAttachment }
  #operations = new Map<string, { abort: AbortController; sessionGeneration: number }>()
  #observers = new OperationObservers()
  #effect = (effect: ServerEffect) => {
    this.runtime.journal.append(frontendJson({ kind: "effect", effect }))
  }

  #heartbeatMs: number

  constructor(
    private runtime: WorkspaceRuntime,
    options?: ControllerOptions & { heartbeatMs?: number },
  ) {
    this.#controller = new Controller(options)
    this.#heartbeatMs = options?.heartbeatMs ?? 15_000
    if (!Number.isSafeInteger(this.#heartbeatMs) || this.#heartbeatMs < 0)
      throw new RangeError("Heartbeat interval must be a nonnegative safe integer")
  }

  async #execute(
    frontend: WorkspaceAttachment,
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
    const queue: { message: Delivery; bytes: number }[] = []
    // The immutable cut is separately bounded by journal retention/snapshot limits. Stream it
    // after welcome instead of filling the live queue while ready is still unresolved.
    let replay: (Delivery | undefined)[] = []
    let replayIndex = 0
    const key = (id: string) => JSON.stringify([lease!.clientId, this.runtime.journal.daemonEpoch, id])
    const current = () => {
      if (!lease || ended) throw new RemoteError("disconnected", "Remote attachment unavailable")
      this.#controller.assertCurrent(lease.clientId, lease.controllerGeneration)
    }
    const pump = async () => {
      if (pumping || ended) return
      pumping = true
      try {
        while ((replayIndex < replay.length || queue.length) && !ended) {
          const initial = replay[replayIndex]
          const item = initial ? { message: initial, bytes: 0 } : queue.shift()!
          if (initial) replay[replayIndex++] = undefined
          if (item.message.kind === "event" || item.message.kind === "reset") sent = item.message.seq
          await connection.send(item.message)
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
      const bytes = Buffer.byteLength(JSON.stringify(message))
      if (queue.length >= REMOTE_LIMITS.queuedFrames || queuedBytes + bytes > REMOTE_LIMITS.queuedBytes) {
        connection.close(new RemoteError("limit_exceeded", "Attachment replay queue exceeded"))
        return
      }
      queue.push({ message, bytes })
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
          lease = this.#controller.attach({
            clientId: hello.clientId,
            ...(sameEpoch && hello.resume ? { controllerToken: hello.resume.controllerToken } : {}),
          })
          // The old connection is fenced before releasing its frontend; late EOF cannot release us.
          this.#active?.connection.close()
          void this.#active?.attachment.detach()
          attachment = this.runtime.attach({ onEffect: this.#effect })
          this.#active = { connection, attachment }
          const cut = this.runtime.journal.open(
            hello.resume,
            () => this.runtime.workspaceSnapshot(),
            enqueue,
            hello.snapshot === true,
          )
          unsubscribe = cut.close
          replay = cut.initial
          if (hello.resume && !cut.initial.some((message) => message.kind === "reset"))
            sent = applied = hello.resume.after
          void pump()
          return {
            v: 1,
            kind: "welcome",
            release: options.release,
            workspace: options.workspace,
            workspaceId: createHash("sha256").update(options.workspace).digest("hex"),
            daemonEpoch: this.runtime.journal.daemonEpoch,
            controllerGeneration: lease.controllerGeneration,
            controllerToken: lease.controllerToken,
            sessionGeneration: attachment.identity!.sessionGeneration,
            limits: REMOTE_PEER_LIMITS,
            capabilities: [
              "frontend.v1",
              "replay",
              "controller",
              "mutation.ledger",
              "files",
              "images",
              "jobs",
              "conversations",
              ...(this.runtime.modelProxy ? ["model.proxy"] : ["model.remote-key"]),
            ],
          }
        },
      },
      handle: (request, transportSignal) => {
        current()
        if (request.controllerGeneration !== lease!.controllerGeneration)
          throw new RemoteReplyError("stale_controller", "Stale controller generation")
        if (!attachment) throw new RemoteError("disconnected", "No workspace frontend")
        if (request.op === "model.open" || request.op === "model.stream" || request.op === "model.compact")
          throw new RemoteError("unsupported_operation", "Model routing is not configured")
        if (request.daemonEpoch !== this.runtime.journal.daemonEpoch)
          throw new RemoteReplyError("outcome_unknown", "The operation belongs to another daemon epoch")
        // Connection EOF aborts its own handlers, NOT admitted workspace operations.
        // Retain ids for a client even if it later recovers with a fresh controller token.
        const scope = { clientId: lease!.clientId, controllerToken: this.runtime.journal.daemonEpoch }
        const payload = {
          op: request.op,
          params: request.params,
          sessionGeneration: request.sessionGeneration,
        }
        // Admission starts synchronously, but execution must not retain this transport's scope.
        const frontend = attachment
        const id = request.id
        const operationKey = key(id)
        const run = (accepted: RemoteJson) => this.#execute(frontend, accepted, id, operationKey)
        const read =
          /^(?:files|images|artifacts)\./.test(request.op) ||
          (request.op.startsWith("uploads.") && request.op !== "uploads.send") ||
          [
            "state.read",
            "transcript.read",
            "sessions.list",
            "sessions.read",
            "models.list",
            "commands.describe",
            "commands.complete",
            "proxy.describe",
            "status.read",
            "jobs.list",
            "jobs.output",
            "jobs.wait",
            "conversations.list",
            "conversations.history",
            "session.planRewind",
          ].includes(request.op)
        if (read && request.sessionGeneration !== frontend.identity?.sessionGeneration)
          throw new RemoteReplyError("stale_session", "The active session changed")
        observations.set(id, { sessionGeneration: request.sessionGeneration, read })
        if (read) {
          const abort = new AbortController()
          reads.set(id, abort)
          return this.#execute(frontend, payload, id, undefined, abort).finally(() => reads.delete(id))
        }
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
          frame.controllerGeneration !== lease!.controllerGeneration
        )
          throw new RemoteError("invalid_frame", "Stale cancellation authority")
        const observation = observations.get(id)
        const operation = observation?.read ? undefined : this.#operations.get(key(id))
        if (
          frame.sessionGeneration !==
          (operation?.sessionGeneration ??
            observation?.sessionGeneration ??
            attachment?.identity?.sessionGeneration)
        )
          throw new RemoteError("invalid_frame", "Stale cancellation authority")
        operation?.abort.abort()
        reads.get(id)?.abort()
      },
      onMessage: (message) => {
        current()
        if (message.kind === "model.frame") {
          this.runtime.modelProxy?.receive(connection, message)
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
        this.runtime.modelProxy?.attach(connection, welcome, () => attachment!.identity!.sessionGeneration, {
          paused: true,
        })
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
      observations.clear()
      for (const abort of reads.values()) abort.abort()
      reads.clear()
      unsubscribe?.()
      this.runtime.signal.removeEventListener("abort", stop)
      if (lease) this.#controller.detach(lease.clientId, lease.controllerGeneration)
      void attachment?.detach()
      if (this.#active?.connection === connection) this.#active = undefined
    })
    return connection
  }
}
