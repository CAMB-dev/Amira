export const REMOTE_PROTOCOL_VERSION = 1

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
} as const

/** Finite operation names; each owning host adapter validates its operation-specific DTO. */
export const REMOTE_OPERATIONS = [
  "state.read",
  "transcript.read",
  "turn.prompt",
  "turn.steer",
  "turn.abort",
  "command.run",
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
  "model.set",
  "thinking.set",
  "fastMode.set",
  "status.read",
  "ui.respond",
  "ui.cancel",
  "form.open",
  "form.evaluate",
  "form.action",
  "form.submit",
  "form.cancel",
  "model.stream",
  "model.compact",
] as const
export type RemoteOperation = (typeof REMOTE_OPERATIONS)[number]

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
  | { v: 1; kind: "event"; daemonEpoch: string; seq: number; replay?: boolean; payload: RemoteJson }
  | { v: 1; kind: "model.event"; callId: string; seq: number; event: RemoteJson }
  | { v: 1; kind: "ack"; channel: RemoteChannel; id: string; seq: number }
  | { v: 1; kind: "ping" | "pong"; id: string }
export type RemoteFrame = RemoteMessage | RemoteChunk

export function remoteChannel(frame: RemoteFrame): RemoteChannel {
  if ("channel" in frame) return frame.channel
  return frame.kind === "model.event" ? "model" : "control"
}
