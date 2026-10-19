import "../server/offline.ts"
import { describe, expect, test } from "bun:test"
import { encodeRemoteMessage, RemoteDecoder } from "../../src/remote/codec.ts"
import {
  REMOTE_LIMITS,
  REMOTE_OPERATIONS,
  type RemoteFrame,
  type RemoteMessage,
} from "../../src/remote/protocol.ts"
import { remoteSchema, validateRemoteFrame } from "../../src/remote-schema.ts"
import { hello, welcome } from "./loopback.ts"
import { operationFixtures, state } from "./schema-fixtures.ts"

const encode = new TextEncoder()
const event = (payload: string): RemoteMessage => ({
  v: 1,
  kind: "event",
  daemonEpoch: "epoch-1",
  seq: 1,
  payload: {
    seq: 1,
    ts: 1,
    sessionId: "s1",
    type: "command.output",
    data: { command: "fixture", level: "info", text: payload },
  },
})
const wire = (value: unknown) => encode.encode(`${JSON.stringify(value)}\n`)
const frames: RemoteMessage[] = [
  hello,
  welcome,
  { v: 1, kind: "reject", error: { code: "controller_busy", message: "Busy" } },
  ...REMOTE_OPERATIONS.map((op) => ({
    v: 1 as const,
    kind: "request" as const,
    channel: op === "model.stream" || op === "model.compact" ? ("model" as const) : ("control" as const),
    id: "op-1",
    controllerGeneration: 1,
    sessionGeneration: 1,
    op,
    params: operationFixtures[op].params,
  })),
  {
    v: 1,
    kind: "response",
    channel: "control",
    id: "op-1",
    op: "state.read",
    ok: true,
    result: state,
  },
  {
    v: 1,
    kind: "response",
    channel: "model",
    id: "op-1",
    op: "model.stream",
    ok: false,
    error: { code: "network", message: "Disconnected" },
  },
  { v: 1, kind: "cancel", channel: "model", id: "call-1" },
  event("😀世界"),
  { v: 1, kind: "model.event", callId: "call-1", seq: 1, event: { type: "text.delta", text: "hi" } },
  { v: 1, kind: "ack", channel: "model", id: "call-1", seq: 3 },
  { v: 1, kind: "ping", id: "p1" },
  { v: 1, kind: "pong", id: "p1" },
]

describe("remote codecs", () => {
  test("every envelope and operation roundtrips with fragmented Unicode and CRLF", () => {
    const decoder = new RemoteDecoder()
    const result: RemoteMessage[] = []
    for (const frame of frames) {
      const bytes = encode.encode(`${JSON.stringify(frame)}\r\n`)
      for (const byte of bytes) result.push(...decoder.push(Uint8Array.of(byte)))
    }
    decoder.finish()
    expect(result).toEqual(frames)
    expect(remoteSchema().oneOf).toHaveLength(13)
  })

  test("strict shapes, finite JSON and generation/ID validation", () => {
    const request = {
      v: 1,
      kind: "request",
      channel: "control",
      id: "op-1",
      controllerGeneration: 1,
      sessionGeneration: 1,
      op: "turn.abort",
      params: {},
    }
    for (const invalid of [
      { ...hello, extra: true },
      { ...hello, v: 2 },
      { ...hello, capabilities: [1] },
      { ...request, op: "arbitrary.method" },
      { ...request, sessionGeneration: -1 },
      { ...request, controllerGeneration: 1.5 },
      { ...request, id: "" },
      { ...request, id: "x".repeat(129) },
      { ...request, params: null },
      { ...request, params: { secret: undefined } },
      event(Number.NaN as unknown as string),
      { ...request, params: { date: new Date() } },
      { ...request, params: { fn: () => {} } },
      { ...request, params: { sparse: new Array(1) } },
      { ...hello, constructor: "not a schema property" },
      JSON.parse('{"v":1,"kind":"ping","id":"p","__proto__":{}}'),
      { ...request, params: Object.defineProperty({}, "toJSON", { value: () => "lossy" }) },
      { ...request, params: Object.defineProperty({}, "getter", { get: () => "lossy", enumerable: true }) },
      { ...request, params: { array: Object.assign([], { ignored: true }) } },
    ])
      expect(() => validateRemoteFrame(invalid)).toThrow()
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => validateRemoteFrame(event(cycle as unknown as string))).toThrow("finite JSON")
    let nested: unknown = 1
    for (let i = 0; i < 70; i++) nested = { nested }
    expect(() => validateRemoteFrame(event(nested as string))).toThrow("nesting")
  })

  test("malformed JSON, invalid UTF-8, banners, blank and unterminated lines fail closed", () => {
    for (const bytes of [
      encode.encode("{}\n"),
      encode.encode("welcome\n"),
      encode.encode("\n"),
      Uint8Array.of(0xff, 10),
      encode.encode('{"v":1,\n'),
    ]) {
      const decoder = new RemoteDecoder()
      expect(() => decoder.push(bytes)).toThrow()
      expect(() => decoder.push(wire(hello))).toThrow("failed")
    }
    const decoder = new RemoteDecoder()
    decoder.push(encode.encode(JSON.stringify(hello)))
    expect(() => decoder.finish()).toThrow("Incomplete")
  })

  test("partial Buffer input is copied, not retained as an externally mutable view", () => {
    const decoder = new RemoteDecoder()
    const bytes = Buffer.from('{"v":1,"kind":"ping","id":"p1"')
    decoder.push(bytes)
    bytes[bytes.indexOf("p1") + 1] = 50
    expect(decoder.push(encode.encode("}\n"))).toEqual([{ v: 1, kind: "ping", id: "p1" }])
    decoder.finish()
  })

  test("decoded JSON has a node bound as well as byte and nesting bounds", () => {
    expect(() =>
      validateRemoteFrame({ ...event(""), payload: Array(REMOTE_LIMITS.nodes).fill(null) }),
    ).toThrow("node limit")
  })

  test("line size is bounded even without a newline", () => {
    const decoder = new RemoteDecoder()
    expect(() => decoder.push(new Uint8Array(REMOTE_LIMITS.lineBytes + 1))).toThrow("line limit")
  })

  test("large logical messages use bounded ordered checksummed chunks", () => {
    const message = event("😀".repeat(150_000))
    const chunks = [...encodeRemoteMessage(message)]
    expect(chunks.length).toBeGreaterThan(1)
    const decoder = new RemoteDecoder()
    const result = chunks.flatMap((bytes) => {
      expect(bytes.length).toBeLessThanOrEqual(REMOTE_LIMITS.lineBytes + 1)
      return decoder.push(bytes)
    })
    decoder.finish()
    expect(result).toEqual([message])
    const damaged = JSON.parse(new TextDecoder().decode(chunks.at(-1)))
    damaged.sha256 = "0".repeat(64)
    const bad = new RemoteDecoder()
    for (const bytes of chunks.slice(0, -1)) bad.push(bytes)
    expect(() => bad.push(wire(damaged))).toThrow("Inconsistent")
    const missing = new RemoteDecoder()
    missing.push(chunks[0]!)
    expect(() => missing.finish()).toThrow("Incomplete")
    const reordered = new RemoteDecoder()
    expect(() => reordered.push(chunks[1]!)).toThrow("start at zero")
    const duplicate = new RemoteDecoder()
    duplicate.push(chunks[0]!)
    expect(() => duplicate.push(chunks[0]!)).toThrow("unordered")
  })

  test("checksums, chunk metadata, base64 and reassembly reservations are enforced", () => {
    const chunks = [...encodeRemoteMessage(event("x".repeat(300_000)))].map((bytes) =>
      JSON.parse(new TextDecoder().decode(bytes)),
    )
    for (const invalid of [
      { ...chunks[0], total: 0 },
      { ...chunks[0], total: 1000 },
      { ...chunks[0], bytes: REMOTE_LIMITS.logicalBytes + 1 },
      { ...chunks[0], data: "not base64" },
      { ...chunks[0], data: "eA==" },
    ])
      expect(() => new RemoteDecoder().push(wire(invalid))).toThrow()
    const badHash = new RemoteDecoder()
    expect(() => {
      for (const chunk of chunks) badHash.push(wire({ ...chunk, sha256: "0".repeat(64) }))
    }).toThrow("checksum")
    const bounded = new RemoteDecoder()
    for (let i = 0; i < REMOTE_LIMITS.transfers; i++)
      bounded.push(wire({ ...chunks[0], transferId: `t${i}` }))
    expect(() => bounded.push(wire({ ...chunks[0], transferId: "overflow" }))).toThrow("reassembly")
  })

  test("logical overflow is reported before any bytes are yielded", () => {
    expect(() => [...encodeRemoteMessage(event("x".repeat(REMOTE_LIMITS.logicalBytes)))]).toThrow(
      "Logical payload",
    )
    const nested = { v: 1, kind: "chunk" } as unknown as RemoteFrame
    expect(() => encodeRemoteMessage(nested as RemoteMessage)).toThrow()
  })
})
