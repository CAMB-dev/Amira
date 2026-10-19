import { RemoteError } from "./remote/errors.ts"
import { REMOTE_LIMITS, type RemoteFrame, type RemoteJson, type RemoteOperation } from "./remote/protocol.ts"
import { publicUpdateError } from "./remote/public-errors.ts"
import {
  array,
  bool,
  constrain,
  exclusive,
  id,
  integer,
  matches,
  object,
  pickSchemas,
  repeatSchema,
  type Schema,
  taggedUnion,
  text,
  union,
  enumeration as values,
} from "./remote/schema/base.ts"
import { coreEvent } from "./remote/schema/events.ts"
import { uiRequest } from "./remote/schema/forms.ts"
import { serverEffect, snapshot, update } from "./remote/schema/frontend.ts"
import { copyRemoteJson } from "./remote/schema/json.ts"
import { streamEvent, userMessage } from "./remote/schema/messages.ts"
import { modelFramePayload } from "./remote/schema/model-wire.ts"
import { operationSchemas } from "./remote/schema/operations.ts"
import {
  backgroundJob,
  holdState,
  inputQueue,
  noticeInbox,
  noticeRetry,
  ownerState,
  workspaceSemantic,
  workspaceSnapshot,
} from "./remote/schema/workspace.ts"

export { assertRemoteJson, copyRemoteJson } from "./remote/schema/json.ts"
export {
  backgroundJob,
  type RemoteJobInfo,
  type RemoteOwnerState,
  type RemoteWorkspaceSnapshot,
  workspaceSnapshot,
} from "./remote/schema/workspace.ts"

const channel = values("control", "model", "files")
const strings = constrain(array(constrain(text, { maxLength: 128 })), { maxItems: 128 })
const release = object({
  version: constrain(text, { minLength: 1, maxLength: 128 }),
  buildId: id,
  target: id,
})
const fault = object({ code: id, message: constrain(text, { maxLength: 4096 }) })
const limits = object({
  lineBytes: values(REMOTE_LIMITS.lineBytes),
  logicalBytes: values(REMOTE_LIMITS.logicalBytes),
})
const base = <const K extends string, const P extends Record<string, Schema>>(kind: K, properties: P) =>
  object({ v: values(1), kind: values(kind), ...properties })
const reply = { channel, id }
const eventPayload = union(
  coreEvent,
  update,
  object({ kind: values("effect"), effect: serverEffect }),
  object({ kind: values("startup"), events: array(coreEvent) }),
  object({ kind: values("jobs"), jobs: array(backgroundJob) }),
  object({ kind: values("semantic"), semantic: workspaceSemantic }),
  object({ kind: values("inputQueue"), sessionId: text, sessionGeneration: integer, inputQueue }),
  object({ kind: values("noticeInbox"), sessionId: text, sessionGeneration: integer, noticeInbox }),
  object({ kind: values("noticeRetry"), sessionId: text, sessionGeneration: integer, noticeRetry }),
  object({
    kind: values("steering"),
    sessionId: text,
    sessionGeneration: integer,
    steering: array(userMessage),
  }),
  object({ kind: values("hold"), sessionId: text, sessionGeneration: integer, hold: holdState }),
)

/** Wire schemas are independent of the legacy unversioned RPC schema. Every payload is discriminated. */
export const REMOTE_FRAME_SCHEMAS = {
  hello: base("hello", {
    clientId: id,
    workspace: constrain(text, { minLength: 1, maxLength: 4096 }),
    release,
    limits,
    capabilities: strings,
    "resume?": object({ daemonEpoch: id, after: integer, controllerToken: id }),
    "snapshot?": bool,
  }),
  welcome: base("welcome", {
    release,
    daemonEpoch: id,
    workspaceId: id,
    workspace: constrain(text, { minLength: 1, maxLength: 4096 }),
    sessionGeneration: integer,
    controllerGeneration: integer,
    "controllerToken?": id,
    limits,
    capabilities: strings,
  }),
  reject: base("reject", { error: fault }),
  request: taggedUnion(pickSchemas(operationSchemas, "params"), "op", "params", {
    v: values(1),
    kind: values("request"),
    ...reply,
    "daemonEpoch?": id,
    controllerGeneration: integer,
    sessionGeneration: integer,
  }),
  response: exclusive(
    taggedUnion(pickSchemas(operationSchemas, "result"), "op", "result", {
      v: values(1),
      kind: values("response"),
      ...reply,
      ok: values(true),
    }),
    taggedUnion(repeatSchema(operationSchemas, fault), "op", "error", {
      v: values(1),
      kind: values("response"),
      ...reply,
      ok: values(false),
    }),
  ),
  cancel: base("cancel", { ...reply, "controllerGeneration?": integer, "sessionGeneration?": integer }),
  reset: base("reset", {
    daemonEpoch: id,
    seq: integer,
    reason: values("fresh", "epoch_changed", "cursor_expired", "future_cursor", "capture_failed"),
    snapshot: workspaceSnapshot,
  }),
  event: base("event", { daemonEpoch: id, seq: integer, "replay?": bool, payload: eventPayload }),
  "model.event": base("model.event", { callId: id, seq: integer, event: streamEvent }),
  "model.frame": base("model.frame", {
    daemonEpoch: id,
    controllerGeneration: integer,
    sessionGeneration: integer,
    callId: id,
    seq: integer,
    payload: modelFramePayload,
  }),
  ack: base("ack", { ...reply, seq: integer }),
  ping: base("ping", { id }),
  pong: base("pong", { id }),
  chunk: base("chunk", {
    channel,
    transferId: id,
    index: integer,
    total: constrain(integer, { minimum: 1, maximum: 1024 }),
    bytes: constrain(integer, { minimum: 1, maximum: REMOTE_LIMITS.logicalBytes }),
    sha256: constrain(text, { pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 }),
    data: constrain(text, {
      maxLength: REMOTE_LIMITS.lineBytes,
      pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
    }),
  }),
} satisfies Record<RemoteFrame["kind"], Schema>

export function remoteSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Amira remote attach v1",
    oneOf: Object.values(REMOTE_FRAME_SCHEMAS),
  }
}
function validate(value: unknown, schema: Schema, label: string): void {
  const copy = copyRemoteJson(value)
  if (!matches(copy, schema)) throw new RemoteError("invalid_frame", `Invalid remote ${label}`)
}
function operationSchema(operation: string) {
  if (!Object.hasOwn(operationSchemas, operation))
    throw new RemoteError("unsupported_operation", "Unknown remote operation")
  return operationSchemas[operation as RemoteOperation]
}
/** The host uses these same validators before direct (non-wire) operation dispatch. */
export function validateRemoteParams(operation: string, value: unknown): void {
  validate(value, operationSchema(operation).params, "operation params")
}
export function validateRemoteResult(operation: string, value: unknown): void {
  validate(value, operationSchema(operation).result, "operation result")
}
const dtoSchemas = {
  snapshot,
  workspaceSnapshot,
  workspaceSemantic,
  inputQueue,
  noticeInbox,
  noticeRetry,
  holdState,
  ownerState,
  backgroundJob,
  update,
  coreEvent,
  uiRequest,
  effect: serverEffect,
  startup: array(coreEvent),
}
export function validateRemoteDto(kind: keyof typeof dtoSchemas, value: unknown): void {
  validate(value, dtoSchemas[kind], kind)
}
function record(value: unknown): value is { [key: string]: RemoteJson } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Change only public error facts on the inert copy; unknown fields still fail validation. */
function normalizeErrorUpdate(frame: RemoteJson): void {
  if (!record(frame) || frame.kind !== "event" || !record(frame.payload) || frame.payload.kind !== "error")
    return
  const update = frame.payload
  const error = publicUpdateError(record(update.error) ? update.error.code : undefined).error
  if (record(update.error)) {
    update.error.code = error.code
    update.error.message = error.message
  } else update.error = error
}

export function validateRemoteFrame(value: unknown, options?: { outgoing?: boolean }): RemoteFrame {
  const copy = copyRemoteJson(value)
  if (options?.outgoing) normalizeErrorUpdate(copy)
  if (typeof copy !== "object" || copy === null || Array.isArray(copy))
    throw new RemoteError("invalid_frame", "Expected a remote envelope")
  if (copy.v !== 1) throw new RemoteError("incompatible_protocol", "Unsupported remote protocol version")
  const schema =
    typeof copy.kind === "string" && Object.hasOwn(REMOTE_FRAME_SCHEMAS, copy.kind)
      ? REMOTE_FRAME_SCHEMAS[copy.kind as keyof typeof REMOTE_FRAME_SCHEMAS]
      : undefined
  if (!schema || !matches(copy, schema)) throw new RemoteError("invalid_frame", "Invalid remote envelope")
  return copy as unknown as RemoteFrame
}
