import { RemoteConnection, type RemoteIO } from "./connection.ts"
import { RemoteError, RemoteReplyError } from "./errors.ts"
import type { ModelBroker } from "./model-broker.ts"
import {
  decodeModelRequest,
  encodeCompactReceipt,
  encodeCompactResult,
  encodeModelEvent,
} from "./model-codec.ts"
import { ModelRetention } from "./model-retention.ts"
import type { RemoteHello, RemoteJson, RemoteMessage, RemoteWelcome } from "./protocol.ts"

/** One local broker process, retained across SSH attachments, never across local process death. */
export class ModelBrokerPeer {
  private retention: ModelRetention
  private active?: RemoteConnection
  private scopes = new Map<string, { epoch: string; generation: number }>()

  constructor(
    private broker: ModelBroker,
    options?: ConstructorParameters<typeof ModelRetention>[0],
  ) {
    this.retention = new ModelRetention(options)
  }

  connect(io: RemoteIO, hello: RemoteHello, onMessage?: (message: RemoteMessage) => void): RemoteConnection {
    this.active?.close()
    this.retention.detach()
    let authority: RemoteWelcome | undefined
    const requests = new Map<string, string>()
    const opened = new Set<string>()
    const current = () => {
      if (this.active !== connection || !authority)
        throw new RemoteError("disconnected", "Local broker detached")
      return authority
    }
    const connection = new RemoteConnection(io, {
      handshake: { role: "client", hello },
      handle: async (request) => {
        const welcome = current()
        if (request.op !== "model.open")
          throw new RemoteError("unsupported_operation", "Unsupported local model operation")
        if (
          request.daemonEpoch !== welcome.daemonEpoch ||
          request.controllerGeneration !== welcome.controllerGeneration
        )
          throw new RemoteReplyError("stale_controller", "Stale model request authority")
        const params = request.params
        const callId = String(params.callId)
        const decoded = decodeModelRequest(params.request)
        const call = { request: decoded, bindingRevision: String(params.revision) }
        const generation = request.sessionGeneration
        const scope = this.scopes.get(callId)
        if (scope && (scope.epoch !== welcome.daemonEpoch || scope.generation !== generation))
          throw new RemoteReplyError("stale_session", "Stale model call scope")
        if (!scope && this.scopes.size >= 65_536)
          throw new RemoteReplyError("limit_exceeded", "Model identity capacity exceeded")
        try {
          this.retention.open({
            callId,
            payload: {
              request: params.request!,
              revision: params.revision!,
              operation: params.operation!,
              epoch: welcome.daemonEpoch,
              generation,
            },
            after: Number(params.after),
            resume: params.resume === true,
            retainReceipts: params.operation === "compact",
            send: async (frame) => {
              try {
                const message: Extract<RemoteMessage, { kind: "model.frame" }> = {
                  v: 1,
                  kind: "model.frame",
                  daemonEpoch: welcome.daemonEpoch,
                  controllerGeneration: welcome.controllerGeneration,
                  sessionGeneration: generation,
                  callId,
                  seq: frame.seq,
                  payload: frame.event,
                }
                this.broker.assertOutbound?.(call, message)
                await connection.send(message)
              } catch (error) {
                // Queue admission can reject without a transport failure. Force the remote
                // into reconnect waiting; retention keeps this unacknowledged frame.
                connection.close()
                throw error
              }
            },
            failure: (code) => ({ kind: "failure", code }),
            run: async (signal, emit) => {
              if (params.operation === "stream") {
                for await (const event of this.broker.stream(call, signal)) {
                  emit(
                    { kind: "stream", data: encodeModelEvent(event) as unknown as RemoteJson },
                    event.type === "done" || event.type === "error",
                  )
                }
              } else {
                const result = await this.broker.compact(
                  call,
                  signal,
                  () => emit({ kind: "progress" }),
                  (receipt) =>
                    emit({ kind: "receipt", data: encodeCompactReceipt(receipt) as unknown as RemoteJson }),
                )
                emit({ kind: "compact", data: encodeCompactResult(result) as unknown as RemoteJson }, true)
              }
            },
          })
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error && typeof error.code === "string"
              ? error.code
              : "proxy_broker_lost"
          throw new RemoteReplyError(code, "The retained local model call is unavailable")
        }
        this.scopes.set(callId, { epoch: welcome.daemonEpoch, generation })
        requests.set(request.id, callId)
        opened.add(callId)
        return { accepted: true }
      },
      onCancel: (id, frame) => {
        const welcome = current()
        if (frame.channel !== "model" || frame.controllerGeneration !== welcome.controllerGeneration)
          throw new RemoteError("invalid_frame", "Stale model cancellation authority")
        const callId = requests.get(id) ?? id
        const scope = this.scopes.get(callId)
        // Unknown ambiguous calls are safe no-ops; cancelling a request is not a malformed call ID.
        if (!scope) return
        if (frame.sessionGeneration !== scope.generation || scope.epoch !== welcome.daemonEpoch)
          throw new RemoteError("invalid_frame", "Stale model cancellation authority")
        this.retention.cancel(callId)
      },
      onMessage: (message) => {
        const welcome = current()
        if (message.kind === "ack" && message.channel === "model") {
          const scope = this.scopes.get(message.id)
          if (!opened.has(message.id) || scope?.epoch !== welcome.daemonEpoch)
            throw new RemoteError("invalid_frame", "Stale model acknowledgement authority")
          this.retention.ack(message.id, message.seq)
        } else onMessage?.(message)
      },
    })
    this.active = connection
    void connection.ready
      .then((welcome) => {
        authority = welcome
      })
      .catch(() => {})
    void connection.closed.then(() => {
      if (this.active === connection) {
        this.active = undefined
        this.retention.detach()
      }
    })
    return connection
  }

  close(): void {
    this.active?.close()
    this.retention.close()
    this.scopes.clear()
  }
}
