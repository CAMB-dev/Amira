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
