import type { CompactReceipt, CompactResult, ModelRequest, StreamEvent, Usage } from "@amira/ai"
import type { ModelWireValue } from "./model-codec.ts"

export type ModelOpenParams = {
  callId: string
  revision: string
  operation: "stream" | "compact"
  request: ModelWireValue<ModelRequest>
  resume: boolean
  after: number
}
export type ModelFramePayload =
  | { kind: "stream"; data: ModelWireValue<StreamEvent> }
  | { kind: "compact"; data: ModelWireValue<CompactResult> }
  | { kind: "progress" }
  | { kind: "receipt"; data: ModelWireValue<Omit<CompactReceipt, "usage"> & { usage?: Usage }> }
  | { kind: "failure"; code: string }

export const REMOTE_PROTOCOL_VERSION = 1
/** Peer understands the optional endpoint-reported context-window source in model/session DTOs. */
export const CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY = "context-window-source.provider"
/**
 * Attachment roles. A client sends at most one intent, and each implies ATTACH_ROLES. The daemon
 * echoes ATTACH_ROLES in welcome.capabilities only to such clients, and only where roles are on.
 */
export const ATTACH_ROLES = "attach.roles"
export const ATTACH_INTENTS = {
  viewer: "attach.role.viewer",
  auto: "attach.role.auto",
  take: "attach.take",
} as const
/** Optional DTO values sent only to peers that advertised the capability; others see the field omitted. */
export const REMOTE_GATED_VALUES = [
  {
    capability: CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY,
    property: "contextWindowSource",
    value: "provider",
  },
] as const
/** Optional top-level frame fields, removed for peers without the capability. */
export const REMOTE_GATED_FIELDS = [{ capability: ATTACH_ROLES, frame: "welcome", property: "role" }] as const
/** Whole frames that are never sent to peers without the capability. */
export const REMOTE_GATED_FRAMES = [{ capability: ATTACH_ROLES, kind: "attachment" }] as const
/** Adds the capabilities a hello string implies, so gating sees what the peer understands. */
export function remotePeerCapabilities(capabilities: readonly string[]): readonly string[] {
  const intents: readonly string[] = Object.values(ATTACH_INTENTS)
  return !capabilities.includes(ATTACH_ROLES) && capabilities.some((value) => intents.includes(value))
    ? [...capabilities, ATTACH_ROLES]
    : capabilities
}

/**
 * Documented Fault.code values (the schema's x-known-codes). The set is open: a client treats an
 * unknown code as operation_failed, so adding one is not a protocol change.
 */
export const REMOTE_FAULT_CODES = {
  reject: [
    "controller_busy",
    "controller_taken",
    "incompatible_protocol",
    "incompatible_build",
    "invalid_frame",
    "invalid_workspace",
    "workspace_busy",
    "unsupported_capability",
    "permission_denied",
    "startup_failed",
    "limit_exceeded",
    "disconnected",
    "cancelled",
    "unsupported_operation",
    "operation_failed",
  ],
  response: [
    "agent_busy",
    "stale_session",
    "stale_operation",
    "stale_controller",
    "not_controller",
    "outcome_unknown",
    "operation_conflict",
    "operation_expired",
    "permission_denied",
    "unsupported_operation",
    "cancelled",
    "disconnected",
    "limit_exceeded",
    "invalid_frame",
    "operation_failed",
  ],
} as const

export type RemoteJson = null | boolean | number | string | RemoteJson[] | { [key: string]: RemoteJson }
export type RemoteChannel = "control" | "model" | "files"

export const REMOTE_LIMITS = {
  lineBytes: 256 * 1024,
  logicalBytes: 64 * 1024 * 1024,
  depth: 64,
  nodes: 1_000_000,
  pendingRequests: 128,
  queuedFrames: 1024,
  queuedBytes: 64 * 1024 * 1024,
  transfers: 4,
  transferBytes: 64 * 1024 * 1024,
  /** Viewers per workspace, beside its one controller. */
  viewers: 8,
} as const

/** Finite operation names; each owning host adapter validates its operation-specific DTO. */
export const REMOTE_OPERATIONS = [
  "state.read",
  "permissions.cycle",
  "transcript.read",
  "turn.prompt",
  "turn.steer",
  "turn.abort",
  "command.run",
  "commands.describe",
  "commands.complete",
  "skill.run",
  "input.run",
  "session.resume",
  "session.clear",
  "session.fork",
  "session.rewind",
  "session.planRewind",
  "conversation.send",
  "conversation.stop",
  "sessions.list",
  "sessions.read",
  "models.list",
  "proxy.describe",
  "proxy.bind",
  "model.set",
  "thinking.set",
  "fastMode.set",
  "status.read",
  "files.list",
  "files.refresh",
  "files.cancel",
  "images.read",
  "artifacts.read",
  "uploads.begin",
  "uploads.chunk",
  "uploads.finish",
  "uploads.cancel",
  "uploads.send",
  "jobs.list",
  "jobs.output",
  "jobs.stop",
  "jobs.wait",
  "conversations.list",
  "conversations.history",
  "conversations.focus",
  "conversations.unfocus",
  "conversations.control",
  "ui.respond",
  "ui.cancel",
  "form.open",
  "form.evaluate",
  "form.action",
  "form.submit",
  "form.cancel",
  "model.stream",
  "model.compact",
  "model.open",
] as const
export type RemoteOperation = (typeof REMOTE_OPERATIONS)[number]

/** ledger: admitted through the mutation ledger. viewer: a read-only attachment may call it. */
export interface RemoteOperationAccess {
  readonly ledger: boolean
  readonly viewer: boolean
}
const read = { ledger: false, viewer: true } as const
const mutation = { ledger: true, viewer: false } as const
/** Unledgered but controller-only: shared listing state, extension code, staging or model routing. */
const control = { ledger: false, viewer: false } as const
/**
 * The single classification of every operation; an unclassified one fails to compile.
 * form.evaluate is unledgered: the host caches it by editor and revision, and it is issued per
 * keystroke. turn.abort is a mutation like any other; a viewer must take control first.
 */
export const REMOTE_OPERATION_ACCESS: { readonly [K in RemoteOperation]: RemoteOperationAccess } = {
  "state.read": read,
  "permissions.cycle": mutation,
  "transcript.read": read,
  "turn.prompt": mutation,
  "turn.steer": mutation,
  "turn.abort": mutation,
  "command.run": mutation,
  "commands.describe": read,
  "commands.complete": control,
  "skill.run": mutation,
  "input.run": mutation,
  "session.resume": mutation,
  "session.clear": mutation,
  "session.fork": mutation,
  "session.rewind": mutation,
  "session.planRewind": read,
  "conversation.send": mutation,
  "conversation.stop": mutation,
  "sessions.list": read,
  "sessions.read": read,
  "models.list": read,
  "proxy.describe": control,
  "proxy.bind": mutation,
  "model.set": mutation,
  "thinking.set": mutation,
  "fastMode.set": mutation,
  "status.read": read,
  "files.list": control,
  "files.refresh": control,
  "files.cancel": control,
  "images.read": read,
  "artifacts.read": read,
  "uploads.begin": control,
  "uploads.chunk": control,
  "uploads.finish": control,
  "uploads.cancel": control,
  "uploads.send": mutation,
  "jobs.list": read,
  "jobs.output": read,
  "jobs.stop": mutation,
  "jobs.wait": read,
  "conversations.list": read,
  "conversations.history": read,
  "conversations.focus": mutation,
  "conversations.unfocus": mutation,
  "conversations.control": mutation,
  "ui.respond": mutation,
  "ui.cancel": mutation,
  "form.open": mutation,
  "form.evaluate": control,
  "form.action": mutation,
  "form.submit": mutation,
  "form.cancel": mutation,
  "model.stream": control,
  "model.compact": control,
  "model.open": control,
}

export function remoteOperationChannel(op: RemoteOperation): RemoteChannel {
  if (op === "model.open" || op === "model.stream" || op === "model.compact") return "model"
  return /^(?:files|images|artifacts|uploads)\./.test(op) ? "files" : "control"
}
/** The documented frontend surface (docs/protocol.md). Model brokering and the files channel are internal. */
export const REMOTE_FRONTEND_OPERATIONS = REMOTE_OPERATIONS.filter(
  (op) => remoteOperationChannel(op) === "control" && !op.startsWith("proxy."),
)

export interface RemoteRelease {
  version: string
  buildId: string
  target: string
}
export interface RemoteFault {
  code: string
  message: string
}
export interface RemotePeerLimits {
  lineBytes: number
  logicalBytes: number
}
export const REMOTE_PEER_LIMITS: RemotePeerLimits = {
  lineBytes: REMOTE_LIMITS.lineBytes,
  logicalBytes: REMOTE_LIMITS.logicalBytes,
}
export interface RemoteHello {
  v: 1
  kind: "hello"
  clientId: string
  workspace: string
  release: RemoteRelease
  limits: RemotePeerLimits
  capabilities: string[]
  resume?: { daemonEpoch: string; after: number; controllerToken: string }
  /** Request a reset when this attachment has no retained local snapshot. */
  snapshot?: boolean
}
export interface RemoteWelcome {
  v: 1
  kind: "welcome"
  release: RemoteRelease
  daemonEpoch: string
  workspaceId: string
  workspace: string
  sessionGeneration: number
  controllerGeneration: number
  controllerToken?: string
  limits: RemotePeerLimits
  capabilities: string[]
  /** Only for attach.roles peers; a connection's role never changes. */
  role?: "controller" | "viewer"
}
/** Display identity of an attached client, never its clientId (the ledger scope). */
export interface RemoteAttachedClient {
  buildId: string
  target: string
  version?: string
}
/** Level-triggered presence per connection, never journaled; only for attach.roles peers. */
export interface RemoteAttachment {
  v: 1
  kind: "attachment"
  daemonEpoch: string
  /** state is open (attached, detached or none); a client treats an unknown value as none. */
  controller: { state: string; graceRemainingMs?: number; client?: RemoteAttachedClient }
  viewers: { client: RemoteAttachedClient; attachedMs: number }[]
}
export interface RemoteRequest {
  v: 1
  kind: "request"
  channel: RemoteChannel
  id: string
  /** Retried mutations retain the epoch in which they were first submitted. */
  daemonEpoch?: string
  controllerGeneration: number
  sessionGeneration: number
  op: RemoteOperation
  params: { [key: string]: RemoteJson }
}
export type RemoteResponse = {
  v: 1
  kind: "response"
  channel: RemoteChannel
  id: string
  op: RemoteOperation
} & ({ ok: true; result: RemoteJson } | { ok: false; error: RemoteFault })
export interface RemoteChunk {
  v: 1
  kind: "chunk"
  channel: RemoteChannel
  transferId: string
  index: number
  total: number
  bytes: number
  sha256: string
  data: string
}

export interface RemoteCancel {
  v: 1
  kind: "cancel"
  channel: RemoteChannel
  id: string
  controllerGeneration?: number
  sessionGeneration?: number
}
export interface RemoteReset {
  v: 1
  kind: "reset"
  daemonEpoch: string
  seq: number
  reason: "fresh" | "epoch_changed" | "cursor_expired" | "future_cursor" | "capture_failed"
  snapshot: RemoteJson
}

export type RemoteMessage =
  | RemoteHello
  | RemoteWelcome
  | { v: 1; kind: "reject"; error: RemoteFault }
  | RemoteRequest
  | RemoteResponse
  | RemoteCancel
  | RemoteReset
  | RemoteAttachment
  | { v: 1; kind: "event"; daemonEpoch: string; seq: number; replay?: boolean; payload: RemoteJson }
  | { v: 1; kind: "model.event"; callId: string; seq: number; event: RemoteJson }
  | {
      v: 1
      kind: "model.frame"
      daemonEpoch: string
      controllerGeneration: number
      sessionGeneration: number
      callId: string
      seq: number
      payload: RemoteJson
    }
  | { v: 1; kind: "ack"; channel: RemoteChannel; id: string; seq: number }
  | { v: 1; kind: "ping" | "pong"; id: string }
export type RemoteFrame = RemoteMessage | RemoteChunk

export function remoteChannel(frame: RemoteFrame): RemoteChannel {
  if ("channel" in frame) return frame.channel
  return frame.kind === "model.event" || frame.kind === "model.frame" ? "model" : "control"
}
