#!/usr/bin/env bun
// Generates the public frontend protocol JSON Schema (docs/protocol/frontend-v1.schema.json) from
// the runtime validators in packages/cli/src/remote, the single source of truth. Only the control
// channel's frontend surface is emitted; model brokering and the files channel stay internal.
// `bun scripts/gen-protocol-schema.ts` rewrites the file; `--check` only reports staleness, and
// protocol-schema.test.ts fails the test run when the committed file is stale.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  REMOTE_FAULT_CODES,
  REMOTE_FRONTEND_OPERATIONS,
  REMOTE_GATED_FIELDS,
  REMOTE_GATED_FRAMES,
  REMOTE_GATED_VALUES,
  REMOTE_OPERATION_ACCESS,
  REMOTE_PROTOCOL_VERSION,
  type RemoteOperation,
} from "../packages/cli/src/remote/protocol.ts"
import * as base from "../packages/cli/src/remote/schema/base.ts"
import * as events from "../packages/cli/src/remote/schema/events.ts"
import * as forms from "../packages/cli/src/remote/schema/forms.ts"
import * as frontend from "../packages/cli/src/remote/schema/frontend.ts"
import * as messages from "../packages/cli/src/remote/schema/messages.ts"
import { operationSchemas } from "../packages/cli/src/remote/schema/operations.ts"
import * as workspace from "../packages/cli/src/remote/schema/workspace.ts"
import { REMOTE_FRAME_SCHEMAS, SERVER_LIST_OUTPUT_SCHEMA } from "../packages/cli/src/remote-schema.ts"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Schema = base.Schema

export const root = path.resolve(import.meta.dir, "..")
export const schemaFile = `docs/protocol/frontend-v${REMOTE_PROTOCOL_VERSION}.schema.json`
const id = `https://raw.githubusercontent.com/CAMB-dev/Amira/main/${schemaFile}`
const lineWidth = 110

const shapeKeys = new Set([
  "type",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "oneOf",
  "anyOf",
])
const primitives = new Set<unknown>([
  base.text,
  base.number,
  base.bool,
  base.nil,
  base.integer,
  base.id,
  base.json,
])
const pascal = (value: string) =>
  value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("")
const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => shapeKeys.has(key)) &&
  ["type", "enum", "oneOf", "anyOf"].some((key) => Object.hasOwn(value, key))

// Frame and payload prose; the structure itself always comes from the validators.
const descriptions: Record<string, string> = {
  HelloFrame: "First client frame. Selects the workspace and advertises the client's capabilities.",
  WelcomeFrame: "Server handshake reply: daemon epoch, generations and server capabilities.",
  RejectFrame:
    "Handshake refusal; the server closes the connection after sending it. An attach.roles client also accepts one after welcome (controller_taken).",
  AttachmentFrame:
    "Presence of the controller and the viewers; sent after welcome and on every change, never journaled or replayed.",
  AttachmentController:
    "state is open: attached, detached (in grace, with graceRemainingMs) or none. Treat an unknown value as none.",
  AttachedClient:
    "Self-reported display identity of a client (never its clientId); version only when printable.",
  RequestFrame: "Client operation request on the control channel, correlated by id.",
  ResponseFrame: "Exactly one response per request id, unless the client cancelled it first.",
  CancelFrame: "Cancels a pending request by id.",
  ResetFrame: "Authoritative workspace snapshot that replaces all client state at seq.",
  EventFrame: "Ordered workspace event. seq increases by one within a daemon epoch.",
  AckFrame: "Client confirmation of the last applied event seq; id is the daemon epoch.",
  PingFrame: "Heartbeat; the peer must answer with a pong carrying the same id.",
  PongFrame: "Heartbeat answer.",
  ChunkFrame: "One part of a frame whose encoded line would exceed the line limit.",
  ClientFrame: "Any frame a frontend client may send.",
  ServerFrame: "Any frame the server may send to a frontend client.",
  ErrorResponse: "Failed operation. error.code is a stable machine-readable code.",
  EventPayload: "Event payload: a core event (has type) or a workspace notification (has kind).",
  WorkspaceSnapshot: "Complete workspace state captured at one event cursor.",
  Fault:
    "Stable machine-readable code plus display text. The code set is open: treat an unknown code as operation_failed. x-known-codes lists the documented ones.",
  ResponseEnvelope:
    "Decode-only, not a frame variant: parse a response by this envelope, match id to the pending request (ignore an unknown id), check op equals that request's op, then decode error as Fault when ok is false, else result with x-operations[op].result.",
  ServerListOutput: "Decode-only: the single stdout line of `amira-server list`, one entry per live daemon.",
}
// Unions whose discriminated object branches become named definitions, with the name suffix.
const hoisted: Record<string, string> = {
  CoreEvent: "Event",
  EventPayload: "Payload",
  FrontendUpdate: "Update",
  UiRequest: "UiRequest",
  FormField: "FormField",
  SettingField: "SettingField",
  RequestFrame: "Request",
  AssistantContent: "Block",
  MessageDeltaEventData: "Delta",
  MessageStreamEventData: "StreamEvent",
  TurnSteerEventData: "Steer",
  ServerEffect: "Effect",
  UiAck: "UiAck",
  ConversationsControlParams: "ConversationControl",
}
const renamed: Record<string, string> = { snapshot: "FrontendSnapshot", update: "FrontendUpdate" }
const discriminators = ["kind", "type", "op", "role", "status", "state", "action"]

class Bundle {
  names = new Map<object, string>()
  used = new Set<string>()
  queue: [string, Schema][] = []
  defs: Record<string, Json> = {}
  splits = new WeakMap<Schema, Schema[]>()

  name(schema: unknown, value: string): void {
    if (!isSchema(schema) || primitives.has(schema) || this.names.has(schema)) return
    if (this.used.has(value)) throw new Error(`Duplicate protocol schema name ${value}`)
    this.names.set(schema, value)
    this.used.add(value)
  }

  ref(schema: Schema): Json {
    const name = this.names.get(schema)!
    if (!(name in this.defs) && !this.queue.some(([queued]) => queued === name))
      this.queue.push([name, schema])
    return { $ref: `#/$defs/${name}` }
  }

  /** Every enum value a required discriminator can take in this schema, through nested unions. */
  values(schema: Schema, key: string): unknown[] | undefined {
    const branches = schema.oneOf ?? schema.anyOf
    if (branches) {
      const all = branches.map((branch) => this.values(branch, key))
      return all.every(Boolean) ? all.flat() : undefined
    }
    const property = schema.properties?.[key]
    return schema.required?.includes(key) && property?.enum ? [...property.enum] : undefined
  }

  discriminator(branches: readonly Schema[]): string | undefined {
    return discriminators.find((key) => {
      const values = branches.map((branch) => this.values(branch, key))
      if (!values.every(Boolean)) return false
      // A nested union branch (RequestFrame) may repeat one value; branches must still be disjoint.
      const flat = values.flatMap((value) => [...new Set(value)])
      return new Set(flat).size === flat.length
    })
  }

  /**
   * One branch per discriminator value: an object branch whose tag is an enum becomes one copy
   * per value with a single-value tag. The accepted JSON is identical; each copy can be named.
   */
  split(branches: readonly Schema[]): readonly Schema[] {
    const key = this.discriminator(branches)
    if (!key) return branches
    return branches.flatMap((branch) => {
      const tag = branch.properties?.[key]
      if (!tag?.enum || tag.enum.length < 2 || this.names.has(branch)) return [branch]
      let copies = this.splits.get(branch)
      if (!copies) {
        copies = tag.enum.map(
          (value) =>
            ({ ...branch, properties: { ...branch.properties, [key]: { ...tag, enum: [value] } } }) as Schema,
        )
        this.splits.set(branch, copies)
      }
      return copies
    })
  }

  /** Name each object branch after its own single discriminator value, e.g. SelectUiRequest. */
  hoist(branches: readonly Schema[], suffix: string): void {
    const single = (branch: Schema, key: string) => {
      const values = branch.properties ? this.values(branch, key) : undefined
      return values?.length === 1 && typeof values[0] === "string" ? values[0] : undefined
    }
    const key = discriminators.find((key) => {
      const values = branches.flatMap((branch) => single(branch, key) ?? [])
      return values.length > 0 && new Set(values).size === values.length
    })
    if (!key) return
    for (const branch of branches) {
      const value = single(branch, key)
      if (value) this.name(branch, `${pascal(value)}${suffix}`)
    }
  }

  render(schema: Schema, defining?: string): Json {
    const name = this.names.get(schema)
    if (name && name !== defining) return this.ref(schema)
    const out: Record<string, Json> = {}
    if (defining) {
      out.title = defining
      if (descriptions[defining]) out.description = descriptions[defining]!
    }
    if (schema.enum) {
      const kinds = new Set(schema.enum.map((value) => (value === null ? "null" : typeof value)))
      const type = kinds.size === 1 ? [...kinds][0] : undefined
      if (!schema.type && type && type !== "null")
        out.type = type === "number" && schema.enum.every(Number.isInteger) ? "integer" : type
    }
    if (schema.type) out.type = schema.type
    if (schema.enum) {
      if (schema.enum.length === 1) out.const = schema.enum[0]!
      else out.enum = [...schema.enum]
    }
    if (schema.properties) {
      const properties: Record<string, Json> = {}
      for (const [key, value] of Object.entries(schema.properties)) {
        const rendered = this.render(value)
        const gates = REMOTE_GATED_VALUES.filter(
          (gate) => gate.property === key && value.enum?.includes(gate.value),
        )
        properties[key] = gates.length
          ? {
              ...(rendered as Record<string, Json>),
              description: gates
                .map((gate) => `"${gate.value}" is sent only to peers advertising "${gate.capability}".`)
                .join(" "),
            }
          : rendered
        const field = REMOTE_GATED_FIELDS.find(
          (gate) => REMOTE_FRAME_SCHEMAS[gate.frame].properties?.[gate.property] === value,
        )
        if (field)
          properties[key] = {
            ...(properties[key] as Record<string, Json>),
            description: `Sent only to peers advertising "${field.capability}".`,
            "x-capability": field.capability,
          }
      }
      out.properties = properties
    }
    if (schema.required?.length) out.required = [...schema.required]
    if (schema.additionalProperties !== undefined)
      out.additionalProperties =
        schema.additionalProperties === false ? false : this.render(schema.additionalProperties)
    if (schema.items) out.items = this.render(schema.items)
    for (const key of [
      "minItems",
      "maxItems",
      "minLength",
      "maxLength",
      "pattern",
      "minimum",
      "maximum",
    ] as const)
      if (schema[key] !== undefined) out[key] = schema[key]!
    for (const key of ["oneOf", "anyOf"] as const) {
      if (!schema[key]) continue
      const branches = this.split(schema[key])
      const suffix = defining && hoisted[defining]
      if (suffix) this.hoist(branches, suffix)
      out[key] = branches.map((branch) => this.render(branch))
      const discriminator = this.discriminator(branches)
      if (discriminator) out["x-discriminator"] = discriminator
    }
    return out
  }

  drain(): void {
    while (this.queue.length) {
      const [name, schema] = this.queue.shift()!
      this.defs[name] = this.render(schema, name)
    }
  }
}

/** Replace the shared channel enum: public frames are always on the control channel. */
function control(schema: Schema): Schema {
  const properties = schema.properties!
  return {
    ...schema,
    properties: { ...properties, ...(properties.channel ? { channel: base.enumeration("control") } : {}) },
  } as Schema
}
function branch(union: Schema, op: string): Schema {
  const found = union.oneOf!.find((item) => item.properties?.op?.enum?.[0] === op)
  if (!found) throw new Error(`Missing frame branch for ${op}`)
  return found
}
function operationDto(
  bundle: Bundle,
  op: RemoteOperation,
  field: "params" | "result",
  found: Schema,
): Schema {
  const schema = operationSchemas[op][field] as Schema
  // Drift guard: the frame branch must embed exactly the operation's own validator.
  if (found.properties?.[field] !== schema) throw new Error(`Frame ${field} for ${op} is not its validator`)
  if (bundle.names.has(schema)) return schema
  // Operations can share one validator object (an empty DTO); each op still gets its own name.
  const copy = { ...schema } as Schema
  bundle.name(copy, `${pascal(op)}${pascal(field)}`)
  return copy
}

export function buildProtocolSchema(): Json {
  const bundle = new Bundle()
  for (const module of [messages, frontend, forms, events, workspace])
    for (const [key, value] of Object.entries(module)) bundle.name(value, renamed[key] ?? pascal(key))
  for (const [type, data] of Object.entries(events.coreEventData))
    bundle.name(data, `${pascal(type)}EventData`)
  bundle.name(messages.assistantMessage.properties!.content!.items, "AssistantContent")
  const frames = REMOTE_FRAME_SCHEMAS
  bundle.name(frames.hello.properties!.release, "Release")
  bundle.name(frames.hello.properties!.limits, "PeerLimits")
  bundle.name(frames.reject.properties!.error, "Fault")
  bundle.name(frames.event.properties!.payload, "EventPayload")
  bundle.name(frames.attachment.properties!.controller, "AttachmentController")
  bundle.name(frames.attachment.properties!.controller!.properties!.client, "AttachedClient")
  bundle.name(frames.attachment.properties!.viewers!.items, "AttachmentViewer")
  const simple = [
    "hello",
    "welcome",
    "reject",
    "cancel",
    "reset",
    "event",
    "attachment",
    "ack",
    "ping",
    "pong",
    "chunk",
  ] as const
  const frame: Record<string, Schema> = {}
  for (const kind of simple) {
    const schema = frames[kind] as Schema
    frame[kind] = schema.properties?.channel ? control(schema) : schema
    bundle.name(frame[kind], `${pascal(kind)}Frame`)
  }
  const operations: Record<string, Json> = {}
  const requests: Schema[] = []
  const responses: Schema[] = []
  const [successes, failures] = (frames.response as Schema).oneOf!
  for (const op of REMOTE_FRONTEND_OPERATIONS) {
    const request = branch(frames.request as Schema, op)
    const params = operationDto(bundle, op, "params", request)
    requests.push(control({ ...request, properties: { ...request.properties, params } } as Schema))
    const success = branch(successes!, op)
    const result = operationDto(bundle, op, "result", success)
    const response = control({ ...success, properties: { ...success.properties, result } } as Schema)
    bundle.name(response, `${pascal(op)}Response`)
    responses.push(response)
    const { ledger, viewer } = REMOTE_OPERATION_ACCESS[op]
    operations[op] = {
      params: bundle.ref(params),
      result: bundle.ref(result),
      "x-access": { ledger, viewer },
    }
  }
  const failure = branch(failures!, REMOTE_FRONTEND_OPERATIONS[0]!)
  const error = control({
    ...failure,
    properties: { ...failure.properties, op: base.enumeration(...REMOTE_FRONTEND_OPERATIONS) },
  } as Schema)
  bundle.name(error, "ErrorResponse")
  const request = { oneOf: requests } as Schema
  const response = { oneOf: [...responses, error] } as Schema
  bundle.name(request, "RequestFrame")
  bundle.name(response, "ResponseFrame")
  const pick = (...kinds: string[]) => kinds.map((kind) => (kind === "request" ? request : frame[kind]!))
  const client = { oneOf: pick("hello", "request", "cancel", "ack", "ping", "pong", "chunk") } as Schema
  const server = {
    oneOf: [
      ...pick("welcome", "reject"),
      response,
      ...pick("reset", "event", "attachment", "ping", "pong", "chunk"),
    ],
  } as Schema
  bundle.name(client, "ClientFrame")
  bundle.name(server, "ServerFrame")
  const frameRefs = [bundle.ref(client), bundle.ref(server)]
  // Decode-only documents: never frames, so outside ClientFrame and ServerFrame.
  const envelope = base.object({
    v: base.enumeration(1),
    kind: base.enumeration("response"),
    channel: base.enumeration("control"),
    id: base.id,
    op: base.enumeration(...REMOTE_FRONTEND_OPERATIONS),
    ok: base.bool,
    "result?": base.json,
    "error?": frames.reject.properties!.error!,
  })
  bundle.name(envelope, "ResponseEnvelope")
  bundle.name(SERVER_LIST_OUTPUT_SCHEMA, "ServerListOutput")
  const decodeRefs = [bundle.ref(envelope), bundle.ref(SERVER_LIST_OUTPUT_SCHEMA)]
  bundle.drain()
  const defsOut = bundle.defs as Record<string, Record<string, Json>>
  for (const name of ["ResponseEnvelope", "ServerListOutput"]) defsOut[name]!["x-decode-only"] = true
  defsOut.ResponseEnvelope!["x-result-by"] = "op"
  const faultCode = (defsOut.Fault!.properties as Record<string, Record<string, Json>>).code!
  for (const gate of REMOTE_GATED_FRAMES)
    defsOut[`${pascal(gate.kind)}Frame`]!["x-capability"] = gate.capability
  const state = (defsOut.AttachmentController!.properties as Record<string, Record<string, Json>>).state!
  state["x-known-values"] = ["attached", "detached", "none"]
  faultCode["x-known-codes"] = [...new Set([...REMOTE_FAULT_CODES.reject, ...REMOTE_FAULT_CODES.response])]
  const defs = Object.fromEntries(
    Object.keys(bundle.defs)
      .sort()
      .map((key) => [key, bundle.defs[key]!]),
  )
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    $comment: "Generated by scripts/gen-protocol-schema.ts from the runtime validators; do not edit.",
    title: `Amira frontend protocol v${REMOTE_PROTOCOL_VERSION}`,
    description:
      "One JSON object per line on the control channel. Validate client frames with ClientFrame and server frames with ServerFrame. See docs/protocol.md.",
    "x-protocol-version": REMOTE_PROTOCOL_VERSION,
    "x-operations": operations,
    "x-decode-only": decodeRefs,
    anyOf: frameRefs,
    $defs: defs,
  }
}

const primitive = (value: Json) => value === null || typeof value !== "object"
/** One-line form Biome keeps for primitives, flat objects and arrays of those; undefined otherwise. */
function flat(value: Json): string | undefined {
  if (primitive(value)) return JSON.stringify(value)
  if (Array.isArray(value)) {
    // Like Prettier, several multi-key objects always break one per line.
    if (value.length > 1 && value.every((item) => !primitive(item) && Object.keys(item!).length > 1)) return
    const items = value.map(flat)
    return items.every((item) => item !== undefined) ? `[${items.join(", ")}]` : undefined
  }
  const entries = Object.entries(value!)
  if (!entries.length) return "{}"
  if (!entries.every(([, item]) => primitive(item))) return
  return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(", ")} }`
}
/** Biome's JSON layout: one line when it fits, else one member per line. */
function format(value: Json, indent: number, used: number, trailing: number): string {
  const line = flat(value)
  if (line !== undefined && (primitive(value) || used + line.length + trailing <= lineWidth)) return line
  const pad = " ".repeat(indent + 2)
  const close = " ".repeat(indent)
  if (Array.isArray(value)) {
    const items = value.map(
      (item, index) => pad + format(item, indent + 2, indent + 2, index < value.length - 1 ? 1 : 0),
    )
    return `[\n${items.join(",\n")}\n${close}]`
  }
  const entries = Object.entries(value!)
  const lines = entries.map(([key, item], index) => {
    const prefix = `${pad}${JSON.stringify(key)}: `
    return prefix + format(item, indent + 2, prefix.length, index < entries.length - 1 ? 1 : 0)
  })
  return `{\n${lines.join(",\n")}\n${close}}`
}

export function renderProtocolSchema(): string {
  return `${format(buildProtocolSchema(), 0, 0, 0)}\n`
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const out = args.includes("--out")
    ? path.resolve(args[args.indexOf("--out") + 1]!)
    : path.join(root, schemaFile)
  const rendered = renderProtocolSchema()
  let current: string | undefined
  try {
    current = readFileSync(out, "utf8").replace(/\r\n/g, "\n")
  } catch {}
  if (args.includes("--check")) {
    if (current !== rendered) {
      console.error(`${path.relative(root, out)} is stale; run bun scripts/gen-protocol-schema.ts`)
      process.exit(1)
    }
  } else if (current !== rendered) {
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, rendered)
  }
}
