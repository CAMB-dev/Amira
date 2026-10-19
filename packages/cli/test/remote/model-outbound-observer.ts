import type { StreamEvent } from "@amira/ai"
import { encodeRemoteMessage, RemoteDecoder } from "../../src/remote/codec.ts"
import {
  decodeCompactReceipt,
  decodeCompactResult,
  decodeModelEvent,
  encodeCompactReceipt,
  encodeCompactResult,
  encodeModelEvent,
} from "../../src/remote/model-codec.ts"
import type { ModelOutboundItem } from "../../src/remote/model-outbound-filter.ts"
import { modelValueSchema } from "../../src/remote/model-schema.ts"
import type { ModelFramePayload, RemoteJson, RemoteMessage } from "../../src/remote/protocol.ts"
import { assistantMessage } from "../../src/remote/schema/messages.ts"
import { payloadStrings } from "./model-outbound-fields.ts"

/** Independent incremental substring oracle; retained suffixes bound memory across the matrix. */
export class OutboundObserver {
  private tails = new Map<string, string>()
  private decoded = new Map<string, { remote: ModelOutboundItem; strings: string[] }>()
  private readonly width: number
  private readonly forbidden: RegExp
  count = 0
  constructor(private readonly secrets: readonly string[]) {
    this.width = Math.max(...secrets.map((secret) => secret.length)) - 1
    this.forbidden = new RegExp(
      secrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    )
  }
  reset(): void {
    this.tails.clear()
    this.count = 0
  }
  private audit(value: string, context: string): void {
    if (this.forbidden.test(value))
      throw new Error(`Credential reconstructed in ${context}: ${JSON.stringify(value)}`)
  }
  private append(lane: string, value: string): void {
    const text = (this.tails.get(lane) ?? "") + value
    this.audit(text, lane)
    this.tails.set(lane, this.width ? text.slice(-this.width) : "")
  }
  private strings(value: unknown): void {
    if (typeof value === "string") this.audit(value, "individual wire string")
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        this.audit(key, "individual wire key")
        this.strings(child)
      }
    }
  }
  private event(event: StreamEvent, auditFrame: boolean): void {
    if (event.type === "text.delta" || event.type === "thinking.delta") {
      this.append("chronological deltas", event.text)
      this.append(event.type, event.text)
    } else if (event.type === "toolCall.delta") {
      this.append("chronological deltas", event.argsDelta)
      this.append(`tool arguments:${event.index ?? "unindexed"}`, event.argsDelta)
    }
    if (!auditFrame || !("message" in event)) return
    const blocks = event.message.content
    const text = blocks
      .flatMap((block) => (block.type === "text" || block.type === "thinking" ? [block.text] : []))
      .join("")
    this.audit(text, "final message text/thinking blocks")
    for (const type of ["text", "thinking"])
      this.audit(
        blocks
          .flatMap((block) =>
            (block.type === "text" || block.type === "thinking") && block.type === type ? [block.text] : [],
          )
          .join(""),
        `final ${type} blocks`,
      )
    this.audit(
      payloadStrings(blocks as unknown as RemoteJson, assistantMessage.properties!.content!).join(""),
      "final block payload fields",
    )
    this.audit(
      payloadStrings(event.message as unknown as RemoteJson, assistantMessage).join(""),
      "final message payload fields",
    )
  }
  observe(item: ModelOutboundItem): void {
    // Encode every filtered item, including its real accounting sidecars. Identical wire
    // bytes have identical decoded projections: cache only that pure codec work, never a
    // filter row or an adjacency assertion. This keeps the full product bounded in time.
    const payload: ModelFramePayload | undefined =
      item.kind === "metadata"
        ? undefined
        : item.kind === "event"
          ? { kind: "stream", data: encodeModelEvent(item.value, this.secrets) }
          : item.kind === "compact"
            ? { kind: "compact", data: encodeCompactResult(item.value, this.secrets) }
            : { kind: "receipt", data: encodeCompactReceipt(item.value, this.secrets) }
    const key = payload
      ? `${++this.count}:${JSON.stringify(payload)}`
      : `metadata:${JSON.stringify(item.value)}`
    const cached = this.decoded.get(key)
    let remote: ModelOutboundItem
    if (cached) remote = cached.remote
    else if (item.kind === "metadata") {
      const bytes = JSON.stringify(item.value)
      this.audit(bytes, "metadata JSON")
      remote = { kind: "metadata", value: JSON.parse(bytes) }
    } else {
      const frame: RemoteMessage = {
        v: 1,
        kind: "model.frame",
        daemonEpoch: "epoch",
        controllerGeneration: 1,
        sessionGeneration: 1,
        callId: "call",
        seq: this.count,
        payload: payload as unknown as RemoteJson,
      }
      const decoder = new RemoteDecoder()
      const decoded: RemoteMessage[] = []
      for (const bytes of encodeRemoteMessage(frame)) {
        this.audit(Buffer.from(bytes).toString(), "serialized RemoteMessage frame")
        decoded.push(...decoder.push(bytes))
      }
      decoder.finish()
      if (decoded.length !== 1 || decoded[0]?.kind !== "model.frame")
        throw new Error("Lost outbound model frame")
      const received = decoded[0].payload as unknown as ModelFramePayload
      remote =
        received.kind === "stream"
          ? { kind: "event", value: decodeModelEvent(received.data) }
          : received.kind === "compact"
            ? { kind: "compact", value: decodeCompactResult(received.data) }
            : received.kind === "receipt"
              ? { kind: "receipt", value: decodeCompactReceipt(received.data) }
              : (() => {
                  throw new Error("Unexpected outbound frame kind")
                })()
    }
    if (!cached) this.strings(remote.value)
    const strings =
      cached?.strings ?? payloadStrings(remote.value as unknown as RemoteJson, modelValueSchema(remote.kind))
    for (const text of strings) this.append("general payload strings", text)
    if (remote.kind === "event") this.event(remote.value, !cached)
    if (!cached) this.decoded.set(key, { remote, strings })
  }
}

/** Tags and booleans are immutable schema scaffolding, not part of payload concatenation. */
export function identity(item: ModelOutboundItem): string {
  if (item.kind === "event") {
    const event = item.value
    const blocks = "message" in event ? event.message.content.map((block) => block.type) : []
    return JSON.stringify([item.kind, event.type, blocks])
  }
  if (item.kind === "compact") return JSON.stringify([item.kind, item.value.ok])
  if (item.kind === "receipt") return JSON.stringify([item.kind, item.value.late])
  return JSON.stringify([item.kind, item.value.length])
}
