import type { StreamEvent, UserMessage } from "@amira/ai"
import type { BackgroundJobInfo, SpawnGroupInfo, SubagentInfo } from "@amira/api"
import type { FrontendSnapshot, FrontendUpdate } from "@amira/core"
import type { HeldInput, HoldState } from "../../../core/src/agent/held-input.ts"
import type { NoticeInputSnapshot } from "../../../core/src/agent/notice-input.ts"
import type { NoticeRetry } from "../../../core/src/agent/notice-retry.ts"
import type {
  RemoteFrame,
  RemoteOperation,
  RemoteRequest,
  RemoteResponse,
} from "../../src/remote/protocol.ts"
import type { Schema, SchemaType } from "../../src/remote/schema/base.ts"
import type { backgroundJob, workspaceSnapshot } from "../../src/remote/schema/workspace.ts"
import type { REMOTE_FRAME_SCHEMAS } from "../../src/remote-schema.ts"
import type { ServerEffect, ServerEvent, ServerUiRequest } from "../../src/server/runtime.ts"
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
type WireJob = Pick<
  BackgroundJobInfo,
  | "id"
  | "command"
  | "kind"
  | "cwd"
  | "owner"
  | "startedAt"
  | "status"
  | "pid"
  | "contained"
  | "exitCode"
  | "signal"
  | "endedAt"
  | "stopRequested"
  | "outputChars"
>
type WireWorkspaceSnapshot = {
  frontend: FrontendSnapshot
  semantic: {
    status: WireOperations["status.read"]["result"]
    models: WireOperations["models.list"]["result"]
    subagents: SubagentInfo[]
    groups: SpawnGroupInfo[]
  }
  pendingRequests: ServerUiRequest[]
  startupEvents: ServerEvent[]
  activity: { events: ServerEvent[] }
  owners: Record<
    string,
    {
      parentSessionId?: string
      status: "idle" | "working" | "blocked" | "error"
      busy: boolean
      turnId: string | null
      hold: HoldState
      inputQueue: HeldInput[]
      steering: UserMessage[]
      noticeInbox: NoticeInputSnapshot
      noticeRetry: NoticeRetry | null
    }
  >
  jobs: WireJob[]
}
export type WorkspaceSchemaParity = [
  AssertNone<Difference<typeof backgroundJob, WireJob>>,
  AssertNone<Difference<typeof workspaceSnapshot, WireWorkspaceSnapshot>>,
]
type ResetFrame = Omit<Extract<RemoteFrame, { kind: "reset" }>, "snapshot"> & {
  snapshot: WireWorkspaceSnapshot
}
type EventFrame = Omit<Extract<RemoteFrame, { kind: "event" }>, "payload"> & {
  payload:
    | ServerEvent
    | FrontendUpdate
    | { kind: "effect"; effect: ServerEffect }
    | { kind: "startup"; events: ServerEvent[] }
    | { kind: "jobs"; jobs: WireJob[] }
    | { kind: "semantic"; semantic: WireWorkspaceSnapshot["semantic"] }
    | { kind: "inputQueue"; inputQueue: HeldInput[]; sessionId: string; sessionGeneration: number }
    | { kind: "noticeInbox"; noticeInbox: NoticeInputSnapshot; sessionId: string; sessionGeneration: number }
    | { kind: "noticeRetry"; noticeRetry: NoticeRetry | null; sessionId: string; sessionGeneration: number }
    | { kind: "steering"; steering: UserMessage[]; sessionId: string; sessionGeneration: number }
    | { kind: "hold"; hold: HoldState; sessionId: string; sessionGeneration: number }
}
type ModelEvent = Omit<Extract<RemoteFrame, { kind: "model.event" }>, "event"> & { event: StreamEvent }
type Frames =
  | Exclude<RemoteFrame, { kind: "request" | "response" | "event" | "model.event" | "reset" }>
  | ResetFrame
  | Requests
  | Responses
  | EventFrame
  | ModelEvent
type FrameFor<T, K> = T extends { kind: infer V }
  ? K extends V
    ? Omit<T, "kind"> & { kind: K }
    : never
  : never
// Compare the large reset payload separately from its envelope to avoid multiplying its
// paths through discriminator refinement. Both the actual frame payload and requiredness
// remain checked; a reset pointing at the wrong snapshot schema must still fail parity.
type ResetSchema = SchemaType<(typeof REMOTE_FRAME_SCHEMAS)["reset"]>
type ResetEnvelope<T> = { [K in keyof T]: K extends "snapshot" ? null : T[K] }
type ResetDifferences =
  | Difference<Schema<ResetEnvelope<ResetSchema>>, ResetEnvelope<ResetFrame>>
  | Difference<Schema<ResetSchema["snapshot"]>, WireWorkspaceSnapshot>
type OtherFrameKind = Exclude<RemoteFrame["kind"], "reset">
type FrameDifferences = {
  [K in OtherFrameKind]: Difference<(typeof REMOTE_FRAME_SCHEMAS)[K], FrameFor<Frames, K>>
}[OtherFrameKind]
export type FrameSchemaParity = AssertNone<FrameDifferences | ResetDifferences>
