import type { StreamEvent } from "@amira/ai"
import type { FrontendUpdate } from "@amira/core"
import type {
  RemoteFrame,
  RemoteOperation,
  RemoteRequest,
  RemoteResponse,
} from "../../src/remote/protocol.ts"
import type { REMOTE_FRAME_SCHEMAS } from "../../src/remote-schema.ts"
import type { ServerEffect, ServerEvent } from "../../src/server/runtime.ts"
import type { WireOperations } from "./schema-parity-operations.ts"
import type { AssertNone, Difference } from "./schema-parity-types.ts"

type Requests = {
  [K in RemoteOperation]: Omit<RemoteRequest, "op" | "params"> & {
    op: K
    params: WireOperations[K]["params"]
  }
}[RemoteOperation]
type Responses = {
  [K in RemoteOperation]:
    | (Omit<Extract<RemoteResponse, { ok: true }>, "op" | "result"> & {
        op: K
        result: WireOperations[K]["result"]
      })
    | (Extract<RemoteResponse, { ok: false }> & { op: K })
}[RemoteOperation]
type EventFrame = Omit<Extract<RemoteFrame, { kind: "event" }>, "payload"> & {
  payload:
    | ServerEvent
    | FrontendUpdate
    | { kind: "effect"; effect: ServerEffect }
    | { kind: "startup"; events: ServerEvent[] }
}
type ModelEvent = Omit<Extract<RemoteFrame, { kind: "model.event" }>, "event"> & { event: StreamEvent }
type Frames =
  | Exclude<RemoteFrame, { kind: "request" | "response" | "event" | "model.event" }>
  | Requests
  | Responses
  | EventFrame
  | ModelEvent
type FrameFor<T, K> = T extends { kind: infer V }
  ? K extends V
    ? Omit<T, "kind"> & { kind: K }
    : never
  : never
type FrameDifferences = {
  [K in RemoteFrame["kind"]]: Difference<(typeof REMOTE_FRAME_SCHEMAS)[K], FrameFor<Frames, K>>
}[RemoteFrame["kind"]]
export type FrameSchemaParity = AssertNone<FrameDifferences>
