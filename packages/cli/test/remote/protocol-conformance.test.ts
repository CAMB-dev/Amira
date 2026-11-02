import "../server/offline.ts"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { REMOTE_FRONTEND_OPERATIONS, type RemoteOperation } from "../../src/remote/protocol.ts"
import { validateRemoteFrame } from "../../src/remote-schema.ts"
import { exampleExchange, exampleHello, rawClientSession, type WireLine } from "./protocol-client-fixture.ts"
import { eventFixtures } from "./schema-events.ts"
import { operationFixtures } from "./schema-fixtures.ts"

// The published schema (docs/protocol/frontend-v1.schema.json) checked with a small, independent
// JSON Schema subset validator: real frames, the existing DTO fixtures and the documented example.

type Node = { [key: string]: any }
const root = path.resolve(import.meta.dir, "../../../..")
const bundle = JSON.parse(
  readFileSync(path.join(root, "docs/protocol/frontend-v1.schema.json"), "utf8"),
) as Node
const def = (name: string) => ({ $ref: `#/$defs/${name}` })

function valid(value: unknown, schema: Node): boolean {
  if (schema.$ref) {
    const target = bundle.$defs[(schema.$ref as string).replace("#/$defs/", "")]
    if (!target) throw new Error(`Unresolved ${schema.$ref}`)
    return valid(value, target)
  }
  if ("const" in schema && value !== schema.const) return false
  if (schema.enum && !schema.enum.includes(value)) return false
  const object = typeof value === "object" && value !== null && !Array.isArray(value)
  switch (schema.type) {
    case "null":
      if (value !== null) return false
      break
    case "boolean":
      if (typeof value !== "boolean") return false
      break
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return false
      if (schema.type === "integer" && !Number.isInteger(value)) return false
      break
    case "string":
      if (typeof value !== "string") return false
      break
    case "array":
      if (!Array.isArray(value)) return false
      break
    case "object":
      if (!object) return false
  }
  if (typeof value === "string") {
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength) return false
    if (schema.maxLength !== undefined && length > schema.maxLength) return false
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) return false
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false
    if (schema.maximum !== undefined && value > schema.maximum) return false
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false
    if (schema.items && !value.every((item) => valid(item, schema.items))) return false
  }
  if (object) {
    const record = value as Record<string, unknown>
    if (schema.required?.some((key: string) => !Object.hasOwn(record, key))) return false
    for (const [key, item] of Object.entries(record)) {
      const property = schema.properties?.[key]
      if (property) {
        if (!valid(item, property)) return false
      } else if (schema.additionalProperties === false) return false
      else if (schema.additionalProperties && !valid(item, schema.additionalProperties)) return false
    }
  }
  if (schema.anyOf && !schema.anyOf.some((branch: Node) => valid(value, branch))) return false
  if (schema.oneOf && schema.oneOf.filter((branch: Node) => valid(value, branch)).length !== 1) return false
  return true
}
const client = (frame: unknown) => valid(frame, def("ClientFrame"))
const server = (frame: unknown) => valid(frame, def("ServerFrame"))
const runtime = (frame: unknown) => {
  try {
    validateRemoteFrame(frame)
    return true
  } catch {
    return false
  }
}

const envelope = { v: 1, channel: "control", id: "r1" }
const request = (op: string, params: unknown) => ({
  ...envelope,
  kind: "request",
  daemonEpoch: "epoch-1",
  controllerGeneration: 1,
  sessionGeneration: 1,
  op,
  params,
})
const response = (op: string, result: unknown) => ({ ...envelope, kind: "response", op, ok: true, result })

test("existing operation fixtures: the schema accepts and rejects exactly what the runtime does", () => {
  const fixtures = operationFixtures as Record<
    RemoteOperation,
    { params: unknown; result: unknown; invalidParams: unknown[]; invalidResults: unknown[] }
  >
  for (const op of REMOTE_FRONTEND_OPERATIONS) {
    const fixture = fixtures[op]
    for (const [frame, side, ok] of [
      [request(op, fixture.params), client, true],
      [response(op, fixture.result), server, true],
      ...fixture.invalidParams.map((params) => [request(op, params), client, false] as const),
      ...fixture.invalidResults.map((result) => [response(op, result), server, false] as const),
    ] as const) {
      expect({ op, frame, valid: side(frame) }).toEqual({ op, frame, valid: ok })
      expect(runtime(frame)).toBe(ok)
    }
  }
  const failure = { ...envelope, kind: "response", op: "turn.prompt", ok: false }
  expect(server({ ...failure, error: { code: "agent_busy", message: "busy" } })).toBe(true)
  expect(server({ ...failure, error: { code: "agent_busy" } })).toBe(false)
})

test("existing core event fixtures validate as event frames; unknown fields and internal frames do not", () => {
  for (const [type, data] of Object.entries(eventFixtures)) {
    const frame = {
      v: 1,
      kind: "event",
      daemonEpoch: "epoch-1",
      seq: 1,
      payload: { seq: 1, ts: 1, sessionId: "s1", type, data },
    }
    expect({ type, valid: server(frame), runtime: runtime(frame) }).toEqual({
      type,
      valid: true,
      runtime: true,
    })
    expect(server({ ...frame, payload: { ...frame.payload, extra: true } })).toBe(false)
  }
  const internal = [
    request("model.stream", operationFixtures["model.stream"].params),
    request("proxy.describe", {}),
    request("files.list", {}),
    { ...request("state.read", {}), channel: "files" },
    { v: 1, kind: "model.event", callId: "c1", seq: 1, event: { type: "start" } },
  ]
  for (const frame of internal)
    expect({ frame, valid: client(frame) || server(frame) }).toEqual({ frame, valid: false })
  expect(client({ ...exampleHello("/srv/project"), extra: true })).toBe(false)
  expect(client({ ...exampleHello("/srv/project"), v: 2 })).toBe(false)
})

let session: Awaited<ReturnType<typeof rawClientSession>>
let wire: WireLine[]
beforeAll(async () => {
  session = await rawClientSession()
  await exampleExchange(session)
  wire = session.wire
})
afterAll(async () => {
  await session?.close()
})

test("a hand-written raw JSON client attaches through the relay, reads state and receives turn events", () => {
  const frames = wire.map((line) => line.frame)
  const welcome = frames.find((frame) => frame.kind === "welcome")!
  expect(welcome.workspace).toBe(session.workspace)
  expect(welcome.capabilities).toContain("frontend.v1")
  expect(welcome.capabilities).toContain("model.remote-key")
  expect(frames.find((frame) => frame.kind === "reset")!.reason).toBe("fresh")
  const state = frames.find((frame) => frame.kind === "response" && frame.op === "state.read")!
  expect(state.ok).toBe(true)
  expect(state.result.cwd).toBe(session.workspace)
  const events = frames.filter((frame) => frame.kind === "event")
  expect(events.map((frame) => frame.seq)).toEqual(events.map((_, index) => events[0]!.seq + index))
  const types = events.map((frame) => frame.payload.type).filter(Boolean)
  expect(types).toContain("turn.start")
  expect(types).toContain("message.delta")
  expect(types).toContain("turn.end")
})

test("every real frame on that connection matches the published schema for its direction", () => {
  expect(wire.length).toBeGreaterThan(10)
  for (const { from, frame } of wire)
    expect({ from, kind: frame.kind, valid: from === "client" ? client(frame) : server(frame) }).toEqual({
      from,
      kind: frame.kind,
      valid: true,
    })
})

test("the relay refuses a newer protocol version and an invalid hello with typed reject frames", async () => {
  for (const [hello, code] of [
    [{ ...exampleHello("/srv/project"), v: 2 }, "incompatible_protocol"],
    [{ ...exampleHello("/srv/project"), client: "gui" }, "invalid_frame"],
  ] as const) {
    const refused = await rawClientSession()
    try {
      await refused.send(hello)
      const reject = await refused.next((frame) => frame.kind === "reject", "reject")
      expect(reject.error.code).toBe(code)
      expect(server(reject)).toBe(true)
    } finally {
      await refused.close()
    }
  }
})

const example = (file: string) => {
  const markdown = readFileSync(path.join(root, file), "utf8")
  const section = markdown.slice(
    markdown.indexOf("<!-- protocol-example:start -->"),
    markdown.indexOf("<!-- protocol-example:end -->"),
  )
  return [...section.matchAll(/<!-- (client|server) -->\s*```json\n([\s\S]*?)\n```/g)].map((match) => ({
    from: match[1] as "client" | "server",
    frame: JSON.parse(match[2]!),
  }))
}

test("the documented example exchange is valid and identical in every language", () => {
  const frames = example("docs/protocol.md")
  expect(
    frames.map(({ from, frame }) => `${from}:${frame.kind}:${frame.op ?? frame.payload?.type ?? ""}`),
  ).toEqual([
    "client:hello:",
    "server:welcome:",
    "server:reset:",
    "client:request:state.read",
    "server:response:state.read",
    "client:request:turn.prompt",
    "server:event:turn.start",
    "server:response:turn.prompt",
    "server:event:message.delta",
    "server:event:message.end",
    "server:event:turn.end",
    "client:ack:",
  ])
  for (const { from, frame } of frames) {
    expect({ kind: frame.kind, valid: from === "client" ? client(frame) : server(frame) }).toEqual({
      kind: frame.kind,
      valid: true,
    })
    expect(runtime(frame)).toBe(true)
  }
  for (const file of ["docs/zh/protocol.md", "docs/ja/protocol.md"]) expect(example(file)).toEqual(frames)
})

const coreEvent = (type: string, data: unknown) => ({
  v: 1,
  kind: "event",
  daemonEpoch: "epoch-1",
  seq: 1,
  payload: { seq: 1, ts: 1, sessionId: "s1", type, data },
})
const notification = (payload: unknown) => ({ v: 1, kind: "event", daemonEpoch: "epoch-1", seq: 1, payload })
const assistantWith = (block: unknown) => ({
  message: { role: "assistant", content: [block], model: { provider: "mock", model: "m" } },
})
const user = { role: "user", content: [{ type: "text", text: "hi" }] }

test("split union branches accept and reject exactly what the runtime does, value by value", () => {
  const cases: [unknown, boolean][] = [
    [coreEvent("message.delta", { kind: "text", text: "a" }), true],
    [coreEvent("message.delta", { kind: "thinking", text: "a" }), true],
    [coreEvent("message.delta", { kind: "thinking" }), false],
    [coreEvent("message.delta", { kind: "text", argsDelta: "{}", toolCallId: "c" }), false],
    [coreEvent("message.delta", { kind: "redacted", text: "a" }), false],
    ...["contentStart", "thinkingStart", "thinkingEnd"].flatMap((kind): [unknown, boolean][] => [
      [coreEvent("message.stream", { kind, index: 1 }), true],
      [coreEvent("message.stream", { kind, outputTokens: 1 }), false],
    ]),
    [coreEvent("message.stream", { kind: "end", outputTokens: 3 }), true],
    ...["queued", "injected", "dropped"].flatMap((state): [unknown, boolean][] => [
      [coreEvent("turn.steer", { message: user, state }), true],
      [coreEvent("turn.steer", { message: user, state, nextTurnId: "t2" }), false],
    ]),
    [coreEvent("turn.steer", { message: user, state: "promoted" }), false],
    ...["detach", "rewind", "unfocus"].flatMap((kind): [unknown, boolean][] => [
      [notification({ kind: "effect", effect: { kind, invocationId: "i1" } }), true],
      [notification({ kind: "effect", effect: { kind, id: "j1" } }), false],
    ]),
    [notification({ kind: "effect", effect: { kind: "view", view: "subagent", id: "a1" } }), true],
    [
      notification({ kind: "effect", effect: { kind: "focus", conversationId: "c", incarnation: "i" } }),
      true,
    ],
    [coreEvent("message.end", assistantWith({ type: "thinking", text: "t", redacted: true })), true],
    [coreEvent("message.end", assistantWith({ type: "toolCall", id: "c", name: "read", args: {} })), true],
    [coreEvent("message.end", assistantWith({ type: "thinking", text: "t", args: {} })), false],
    ...["accepted", "cancelled", "settled"].flatMap((status): [unknown, boolean][] => [
      [response("ui.respond", { status }), true],
      [response("ui.respond", { status, message: "m" }), false],
    ]),
    ...["invalid", "disconnected"].flatMap((status): [unknown, boolean][] => [
      [response("ui.respond", { status, message: "m" }), true],
      [response("ui.respond", { status }), false],
    ]),
  ]
  for (const [frame, ok] of cases) {
    expect({ frame, valid: server(frame), runtime: runtime(frame) }).toEqual({
      frame,
      valid: ok,
      runtime: ok,
    })
  }
  for (const [params, ok] of [
    ...["pause", "resume", "stop"].flatMap((action): [unknown, boolean][] => [
      [{ conversationId: "c", action }, true],
      [{ conversationId: "c", action, text: "x" }, false],
    ]),
    [{ conversationId: "c", action: "message", text: "x" }, true],
    [{ conversationId: "c", action: "message" }, false],
  ] as const) {
    const frame = request("conversations.control", params)
    expect({ params, valid: client(frame), runtime: runtime(frame) }).toEqual({
      params,
      valid: ok,
      runtime: ok,
    })
  }
})

test("every recorded response decodes through ResponseEnvelope and then x-operations[op].result", () => {
  const responses = wire.filter(({ frame }) => frame.kind === "response").map(({ frame }) => frame)
  expect(responses.length).toBeGreaterThan(1)
  const failure: (typeof responses)[number] = {
    ...envelope,
    kind: "response",
    op: "turn.prompt",
    ok: false,
    error: { code: "x", message: "" },
  }
  for (const frame of [...responses, failure]) {
    expect(valid(frame, def("ResponseEnvelope"))).toBe(true)
    const decoded = frame.ok
      ? valid(frame.result, bundle["x-operations"][frame.op].result)
      : valid(frame.error, def("Fault"))
    expect({ op: frame.op, decoded }).toEqual({ op: frame.op, decoded: true })
  }
  expect(valid({ ...failure, op: "model.stream" }, def("ResponseEnvelope"))).toBe(false)
  expect(valid({ ...failure, extra: 1 }, def("ResponseEnvelope"))).toBe(false)
})

test("ServerListOutput describes the amira-server list line", () => {
  const entry = {
    workspace: "/srv/project",
    protocol: 1,
    release: { version: "0.0.1", buildId: "b1", target: "bun-linux-x64-baseline" },
    daemonEpoch: "epoch-1",
  }
  expect(valid({ v: 1, workspaces: [] }, def("ServerListOutput"))).toBe(true)
  expect(valid({ v: 1, workspaces: [entry] }, def("ServerListOutput"))).toBe(true)
  expect(valid({ v: 1, workspaces: [{ ...entry, nonce: "n" }] }, def("ServerListOutput"))).toBe(false)
})
