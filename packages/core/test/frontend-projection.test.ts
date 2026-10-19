import { expect, test } from "bun:test"
import type { AnyEvent } from "@amira/api"
import { joinMessages } from "../src/agent/messages.ts"
import { EventBus } from "../src/event-bus.ts"
import { FrontendProjection } from "../src/frontend/projection.ts"

const meta = { sessionId: "root", turnId: "turn" }

test("capture retains emit-time partials, tool start and terminal result before subscriber loss", async () => {
  const bus = new EventBus()
  const projection = new FrontendProjection()
  const off = bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  bus.subscribe(() => {}, { maxQueue: 1 })
  bus.emit("message.start", { model: { provider: "mock", model: "test" } }, meta)
  for (let i = 0; i < 20; i++) bus.emit("message.delta", { kind: "text", text: `${i}` }, meta)
  expect(projection.snapshot().events.filter((event) => event.type === "message.delta")).toMatchObject([
    { data: { kind: "text", text: "012345678910111213141516171819" } },
  ])
  bus.emit("tool.execute.start", { toolCallId: "call", name: "fixture", args: { original: true } }, meta)
  const partial = { content: [{ type: "text" as const, text: "before" }] }
  bus.emit("tool.execute.update", { toolCallId: "call", name: "fixture", partial }, meta)
  partial.content[0]!.text = "mutated"
  expect(JSON.stringify(projection.snapshot())).toContain("before")
  expect(JSON.stringify(projection.snapshot())).not.toContain("mutated")
  bus.emit("tool.execute.end", { toolCallId: "call", name: "fixture", result: partial, durationMs: 1 }, meta)
  expect(
    projection.snapshot().events.filter((event) => event.type.startsWith("tool.execute.")),
  ).toMatchObject([
    { type: "tool.execute.start", data: { args: { original: true } } },
    { type: "tool.execute.end", data: { result: partial } },
  ])
  bus.emit(
    "message.end",
    { message: { role: "assistant", model: { provider: "mock", model: "test" }, content: [] } },
    meta,
  )
  expect(projection.snapshot().events.some((event) => event.type === "message.delta")).toBe(false)
  bus.emit("turn.end", { reason: "done", steps: 1 }, meta)
  expect(projection.snapshot().events).toEqual([])
  off()
  await bus.flush()
})

test("identical steers retain multiplicity and joined notices settle without phantom queued inputs", () => {
  const bus = new EventBus()
  const projection = new FrontendProjection()
  bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  const message = { role: "user" as const, content: [{ type: "text" as const, text: "same" }] }
  for (let i = 0; i < 2; i++) bus.emit("turn.steer", { message, state: "queued" }, meta)
  bus.emit("turn.steer", { message, state: "injected" }, meta)
  expect(projection.snapshot().events).toHaveLength(1)
  bus.emit("turn.steer", { message, state: "dropped" }, meta)
  const notices = ["one", "two"].map((text) => ({
    ...message,
    content: [{ type: "text" as const, text }],
    display: { text, origin: "notice" as const },
  }))
  for (const message of notices) bus.emit("turn.steer", { message, state: "queued" }, meta)
  bus.emit("turn.steer", { message: joinMessages(notices), state: "injected" }, meta)
  expect(projection.snapshot().events).toEqual([])
})

test("projection bounds fail explicitly instead of serving incomplete activity; session reset clears it", () => {
  const projection = new FrontendProjection({ bytes: 1024, events: 1 })
  const bus = new EventBus()
  bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  bus.emit("message.start", { model: { provider: "mock", model: "test" } }, meta)
  bus.emit("message.delta", { kind: "text", text: "overflow" }, meta)
  expect(projection.failed).toBe(true)
  expect(() => projection.snapshot()).toThrow("recovery")
  projection.clear()
  expect(projection.snapshot()).toEqual({ events: [] })
})

test("independent child identities and states survive interleaved lifecycle changes", () => {
  const projection = new FrontendProjection()
  const bus = new EventBus()
  bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  bus.emit("subagent.state", { childSessionId: "a", state: "paused", turns: 1 }, meta)
  bus.emit("subagent.state", { childSessionId: "b", state: "idle", turns: 2 }, meta)
  expect(projection.snapshot().events.map((event) => event.data)).toEqual([
    { childSessionId: "a", state: "paused", turns: 1 },
    { childSessionId: "b", state: "idle", turns: 2 },
  ])
  expect(projection.snapshot().events.every((event: AnyEvent) => event.ts > 0)).toBe(true)
})

test("partial snapshots coalesce deltas by block and stable tool index without changing source envelopes", () => {
  const projection = new FrontendProjection()
  let seq = 0
  const send = (event: Pick<AnyEvent, "type" | "data">) => {
    const source = { ...meta, ...event, seq: ++seq, ts: seq * 10 } as AnyEvent
    projection.capture(source)
    return source
  }
  send({ type: "message.start", data: { model: { provider: "mock", model: "test" } } })
  const request = send({ type: "message.stream", data: { kind: "request", thinkingDisplay: "raw" } })
  const thinking = send({ type: "message.stream", data: { kind: "thinkingStart", index: 0 } })
  const firstThought = send({ type: "message.delta", data: { kind: "thinking", text: "think " } })
  send({ type: "message.delta", data: { kind: "thinking", text: "twice" } })
  const thoughtEnd = send({ type: "message.stream", data: { kind: "thinkingEnd", index: 0 } })
  const content = send({ type: "message.stream", data: { kind: "contentStart", index: 1 } })
  const firstText = send({ type: "message.delta", data: { kind: "text", text: "hello " } })
  send({ type: "message.delta", data: { kind: "text", text: "world" } })
  const before = projection.snapshot()
  const tool = send({
    type: "message.delta",
    data: { kind: "toolCall", index: 2, toolCallId: "temporary", name: "read", argsDelta: '{"p":' },
  })
  const otherTool = send({
    type: "message.delta",
    data: { kind: "toolCall", index: 3, toolCallId: "other", name: "write", argsDelta: "{}" },
  })
  send({
    type: "message.delta",
    data: { kind: "toolCall", index: 2, toolCallId: "final", argsDelta: '"a"}' },
  })
  const hosted = send({
    type: "message.delta",
    data: {
      kind: "serverTool",
      block: { type: "serverTool", id: "search", name: "web", input: {}, status: "running" },
    },
  })
  send({
    type: "message.delta",
    data: {
      kind: "serverTool",
      block: { type: "serverTool", id: "search", name: "web", input: { query: "done" }, status: "done" },
    },
  })
  const lastContent = send({ type: "message.stream", data: { kind: "contentStart", index: 4 } })
  const lastText = send({ type: "message.delta", data: { kind: "text", text: "after" } })
  const events = projection.snapshot().events
  expect(events.map((event) => event.data)).toEqual([
    { model: { provider: "mock", model: "test" } },
    request.data,
    thinking.data,
    { kind: "thinking", text: "think twice" },
    thoughtEnd.data,
    content.data,
    { kind: "text", text: "hello world" },
    { kind: "toolCall", index: 2, toolCallId: "final", name: "read", argsDelta: '{"p":"a"}' },
    { kind: "toolCall", index: 3, toolCallId: "other", name: "write", argsDelta: "{}" },
    {
      kind: "serverTool",
      block: { type: "serverTool", id: "search", name: "web", input: { query: "done" }, status: "done" },
    },
    { kind: "contentStart", index: 4 },
    { kind: "text", text: "after" },
  ])
  // Aggregates occupy their first delta's position/time; structural timing is untouched.
  expect(
    events.filter((event) => event.type === "message.delta").map(({ seq, ts }) => ({ seq, ts })),
  ).toEqual([firstThought, firstText, tool, otherTool, hosted, lastText].map(({ seq, ts }) => ({ seq, ts })))
  expect<AnyEvent[]>(events.filter((event) => event.type === "message.stream")).toEqual([
    request,
    thinking,
    thoughtEnd,
    content,
    lastContent,
  ])
  expect(firstText.data).toEqual({ kind: "text", text: "hello " })
  expect(tool.data).toMatchObject({ toolCallId: "temporary", argsDelta: '{"p":' })
  expect(before.events).toHaveLength(7)
  expect(Object.isFrozen(events[3]!.data)).toBe(true)
})

test("overflow recovers when the affected message settles and preserves concurrent healthy partials", () => {
  const projection = new FrontendProjection({ bytes: 1800, events: 100 })
  const bus = new EventBus()
  const journal: AnyEvent[] = []
  bus.capture(
    (event) => {
      projection.capture(event)
      journal.push(event)
    },
    () => projection.fail(),
  )
  const healthy = { sessionId: "healthy", turnId: "healthy-turn" }
  bus.emit("message.start", { model: { provider: "mock", model: "test" } }, healthy)
  bus.emit("message.delta", { kind: "text", text: "keep " }, healthy)
  bus.emit("message.start", { model: { provider: "mock", model: "test" } }, meta)
  const overflow = bus.emit("message.delta", { kind: "text", text: "x".repeat(2000) }, meta)
  expect(journal).toHaveLength(4)
  expect(journal[3]).toBe(overflow)
  expect(projection.failed).toBe(true)
  expect(() => projection.snapshot()).toThrow("recovery")
  bus.emit("message.delta", { kind: "text", text: "working" }, healthy)
  bus.emit("message.delta", { kind: "text", text: "lost" }, meta)
  bus.emit(
    "message.end",
    { message: { role: "assistant", model: { provider: "mock", model: "test" }, content: [] } },
    meta,
  )
  expect(projection.failed).toBe(false)
  expect(projection.snapshot().events).toMatchObject([
    { sessionId: "healthy", type: "message.start" },
    { sessionId: "healthy", type: "message.delta", data: { text: "keep working" } },
  ])
  bus.emit("message.start", { model: { provider: "mock", model: "test" } }, meta)
  bus.emit("message.delta", { kind: "text", text: "new" }, meta)
  expect(JSON.stringify(projection.snapshot())).toContain("new")
})

test("turn completion recovers tool-state overflow without resetting other conversations", () => {
  const projection = new FrontendProjection({ bytes: 2000, events: 100 })
  const bus = new EventBus()
  bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  bus.emit("message.start", { model: { provider: "mock", model: "test" } }, { sessionId: "healthy" })
  bus.emit("tool.execute.start", { toolCallId: "huge", name: "read", args: { text: "x".repeat(2100) } }, meta)
  expect(projection.failed).toBe(true)
  bus.emit("turn.end", { reason: "done", steps: 1 }, meta)
  expect(projection.failed).toBe(false)
  expect(projection.snapshot().events).toMatchObject([{ sessionId: "healthy", type: "message.start" }])
})

test("oversized queued steers recover when dropped behind a hold without a turn-end event", () => {
  const projection = new FrontendProjection({ bytes: 1024, events: 100 })
  const bus = new EventBus()
  bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  const message = { role: "user" as const, content: [{ type: "text" as const, text: "x".repeat(2048) }] }
  for (let i = 0; i < 2; i++) bus.emit("turn.steer", { message, state: "queued" }, meta)
  expect(() => projection.snapshot()).toThrow("recovery")
  bus.emit("turn.steer", { message, state: "dropped" }, meta)
  expect(() => projection.snapshot()).toThrow("recovery")
  bus.emit("turn.steer", { message, state: "dropped" }, meta)
  expect(projection.failed).toBe(false)
  expect(projection.snapshot()).toEqual({ events: [] })
})

test("selection preserves current root and child partials but drops retired work with the same session id", () => {
  const projection = new FrontendProjection()
  const bus = new EventBus()
  bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  const retired = { sessionId: "root", turnId: "retired-turn" }
  const root = { sessionId: "root", turnId: "replacement-turn" }
  const child = { sessionId: "child", parentSessionId: "root", turnId: "child-turn" }
  bus.emit("compact.start", { reason: "manual", replacing: 1, kept: 0 }, retired)
  bus.emit("tool.execute.start", { toolCallId: "retired-tool", name: "fixture", args: {} }, retired)
  bus.emit(
    "message.start",
    { model: { provider: "mock", model: "test" } },
    { sessionId: "retired-child", turnId: "old" },
  )
  bus.emit(
    "message.delta",
    { kind: "text", text: "retired text" },
    { sessionId: "retired-child", turnId: "old" },
  )
  for (const owner of [root, child]) {
    bus.emit("turn.start", { prompt: { role: "user", content: [] } }, owner)
    bus.emit("message.start", { model: { provider: "mock", model: "test" } }, owner)
    bus.emit("message.delta", { kind: "text", text: "before " }, owner)
  }
  projection.reconcileTurns(
    new Map([
      [root.sessionId, root.turnId],
      [child.sessionId, child.turnId],
    ]),
  )
  for (const owner of [root, child]) bus.emit("message.delta", { kind: "text", text: "after" }, owner)
  const events = projection.snapshot().events
  expect(
    events.filter((event) => event.type === "message.delta").map((event) => [event.sessionId, event.data]),
  ).toEqual([
    ["root", { kind: "text", text: "before after" }],
    ["child", { kind: "text", text: "before after" }],
  ])
  expect(events.every((event) => event.turnId === root.turnId || event.turnId === child.turnId)).toBe(true)
})

test("selection keeps active overflow quarantined while retiring unrelated missing partials", () => {
  const projection = new FrontendProjection({ bytes: 1024, events: 100 })
  const bus = new EventBus()
  bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  for (const owner of [meta, { sessionId: "retired", turnId: "retired-turn" }]) {
    bus.emit("turn.start", { prompt: { role: "user", content: [] } }, owner)
    bus.emit("message.start", { model: { provider: "mock", model: "test" } }, owner)
    bus.emit("message.delta", { kind: "text", text: "x".repeat(2048) }, owner)
  }
  projection.reconcileTurns(new Map([[meta.sessionId, meta.turnId]]))
  expect(() => projection.snapshot()).toThrow("recovery")
  bus.emit("turn.end", { reason: "done", steps: 1 }, meta)
  expect(projection.snapshot()).toEqual({ events: [] })
})

test("oversized semantic state is resampled after work settles without poisoning healthy conversations", () => {
  const projection = new FrontendProjection({ bytes: 1024, events: 100 })
  const bus = new EventBus()
  bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  bus.emit("message.start", { model: { provider: "mock", model: "test" } }, { sessionId: "healthy" })
  bus.emit("message.delta", { kind: "text", text: "keep" }, { sessionId: "healthy" })
  bus.emit("status.changed", { status: "blocked", reason: "x".repeat(2048) }, meta)
  expect(projection.failed).toBe(true)
  bus.emit("status.changed", { status: "idle" }, meta)
  expect(projection.failed).toBe(false)
  expect(projection.snapshot().events.map((event) => event.data)).toEqual([
    { model: { provider: "mock", model: "test" } },
    { kind: "text", text: "keep" },
    { status: "idle" },
  ])
})

test("reset activity never carries a provider retry past its model attempt or turn", () => {
  const projection = new FrontendProjection()
  const bus = new EventBus()
  bus.capture(
    (event) => projection.capture(event),
    () => projection.fail(),
  )
  const retry = () =>
    bus.emit(
      "model.retry",
      { attempt: 1, maxRetries: 2, delayMs: 1000, error: "fixture", kind: "network" },
      meta,
    )
  bus.emit("message.start", { model: { provider: "mock", model: "test" } }, meta)
  retry()
  expect(projection.inFlightSnapshot().events.filter((event) => event.type === "model.retry")).toHaveLength(1)
  bus.emit("message.stream", { kind: "request" }, meta)
  expect(projection.inFlightSnapshot().events.filter((event) => event.type === "model.retry")).toHaveLength(0)
  retry()
  bus.emit(
    "message.end",
    { message: { role: "assistant", content: [], model: { provider: "mock", model: "test" } } },
    meta,
  )
  expect(projection.inFlightSnapshot().events.filter((event) => event.type === "model.retry")).toHaveLength(0)
  retry()
  bus.emit("turn.end", { reason: "aborted", steps: 1 }, meta)
  expect(projection.inFlightSnapshot().events.filter((event) => event.type === "model.retry")).toHaveLength(0)
})
