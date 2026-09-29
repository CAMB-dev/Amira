import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type Message, type MockStep, NO_MODEL, userMessage } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent, type AgentOptions } from "../src/agent.ts"
import { splitHistory, summaryMessages } from "../src/compaction.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionStore } from "../src/session-store.ts"

async function setup(steps: MockStep[], extra: Partial<AgentOptions> = {}) {
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [
      { id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 1000 } },
      { id: "other", dialect: "mock", baseUrl: "" },
    ],
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-agent-session-"))
  const session = extra.session ?? SessionStore.create({ cwd: "/proj", dir })
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: "/proj",
    systemPrompt: "sys",
    bus,
    session,
    ...extra,
  })
  return { agent, ai, mock, bus, events, session }
}

const types = (events: AnyEvent[]) => events.map((e) => e.type)

test("every message is persisted as it is added and restores into a new agent", async () => {
  const { agent, session, ai } = await setup([
    { toolCalls: [{ name: "echo", args: { text: "a" }, id: "c1" }] },
    { text: "done" },
  ])
  agent.tools.register(
    defineTool<{ text: string }>({
      name: "echo",
      description: "echo",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: async (p) => textResult(p.text),
    }),
    "t",
  )
  await agent.prompt("go")
  const reopened = SessionStore.open(session.file)
  expect(reopened.restore().messages).toEqual(agent.messages)
  expect(reopened.model()).toEqual({ provider: "mock", model: "m" })

  const mock2 = createMockDialect([{ text: "again" }])
  ai.registerDialect(mock2)
  const resumed = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: "/proj",
    systemPrompt: "sys",
    session: reopened,
  })
  expect(resumed.sessionId).toBe(session.id)
  await resumed.prompt("more")
  expect(mock2.requests[0]!.messages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "toolResult",
    "assistant",
    "user",
  ])
  // Resuming with the same model does not record a model change again.
  expect(reopened.entries.filter((e) => e.type === "model_change").length).toBe(1)
})

test("a prompt's display is stored and in turn.start, but the model gets only the full text", async () => {
  const { agent, mock, session, events, bus } = await setup([{ text: "done" }])
  const display = { text: "/review-pr 123", note: "Loaded skill review-pr (3 lines)" }
  await agent.prompt(userMessage("the whole skill text", display))
  await bus.flush()
  expect(mock.requests[0]!.messages[0]).toEqual({
    role: "user",
    content: [{ type: "text", text: "the whole skill text" }],
  })
  const start = events.find((e) => e.type === "turn.start")
  expect(start?.type === "turn.start" && start.data.prompt.display).toEqual(display)
  const stored = SessionStore.open(session.file).restore().messages[0]
  expect(stored?.role === "user" && stored.display).toEqual(display)
  // The preview shows what the model gets, so no display either; the history keeps it.
  expect((await agent.preview()).messages[0]).toEqual(mock.requests[0]!.messages[0]!)
  expect(agent.messages[0]).toMatchObject({ display })
})

test("a session open in two agents: the second writer reports the conflict once", async () => {
  const { agent, ai, session } = await setup([{ text: "r1" }])
  await agent.prompt("q1")
  const mock2 = createMockDialect([{ text: "r2" }, { text: "other" }])
  ai.registerDialect(mock2)
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const twin = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: "/proj",
    bus,
    session: SessionStore.open(session.file),
  })
  await agent.prompt("q2")
  const r = await twin.prompt("from the twin")
  await bus.flush()
  expect(r.reason).toBe("done")
  const errors = events.filter((e) => e.type === "extension.error")
  expect(errors.length).toBe(1)
  expect(errors[0]!.data).toMatchObject({
    source: "session",
    error: expect.stringContaining("another process"),
  })
  expect(twin.messages.length).toBe(4)
  expect(SessionStore.open(session.file).restore().messages).toEqual(agent.messages)
})

test("setModel records a model_change and emits model.changed", async () => {
  const { agent, ai, session, bus, events, mock } = await setup([{ text: "x" }, { text: "y" }])
  await agent.prompt("hi")
  agent.setModel(ai.model("other/big"))
  agent.setModel(ai.model("other/big"))
  await agent.prompt("again")
  await bus.flush()
  const changes = events.filter((e) => e.type === "model.changed")
  expect(changes.map((e) => e.data)).toEqual([
    { from: { provider: "mock", model: "m" }, to: { provider: "other", model: "big" } },
  ])
  expect(mock.requests[1]!.model.id).toBe("big")
  expect(SessionStore.open(session.file).model()).toEqual({ provider: "other", model: "big" })
})

test("NO_MODEL is never recorded as the session's model; the model picked later is", async () => {
  const { agent, ai, session, bus, events, mock } = await setup([{ text: "x" }], { model: NO_MODEL })
  expect(session.model()).toBeUndefined()
  await agent.prompt("hi").catch(() => undefined)
  await bus.flush()
  expect(mock.requests).toHaveLength(0)
  expect(JSON.stringify(events)).toContain("no model selected; pick one with /model")
  agent.setModel(ai.model("other/big"))
  agent.setModel(NO_MODEL)
  const changes = session.entries.filter((e) => e.type === "model_change")
  expect(changes.map((e) => (e as { model: unknown }).model)).toEqual([{ provider: "other", model: "big" }])
})

test("system.build can edit sections before every model call", async () => {
  const { agent, mock } = await setup([{ text: "a" }], {
    sections: [
      { name: "identity", text: "I" },
      { name: "skills", text: "" },
    ],
  })
  agent.interceptors.add("system.build", (v) => ({
    action: "modify",
    value: { sections: v.sections.map((s) => (s.name === "skills" ? { ...s, text: "SKILLS" } : s)) },
  }))
  agent.setSection("role", "R")
  await agent.prompt("hi")
  expect(mock.requests[0]!.systemPrompt).toBe("I\n\nSKILLS\n\nR")
  expect(agent.systemPrompt).toBe("I\n\nR")
})

const big = { usage: { input: 900 } }

test("compacts before the next model call once the context passes the threshold", async () => {
  const { agent, mock, session, bus, events } = await setup([
    { text: "r1" },
    { text: "r2", ...big },
    { text: "SUMMARY OF r1" },
    { text: "r3" },
  ])
  await agent.prompt("q1")
  await agent.prompt("q2")
  await agent.prompt("q3")
  await bus.flush()
  // The third request is the summary call; it sees the older turn as a transcript.
  const summaryReq = mock.requests[2]!
  expect(summaryReq.tools).toEqual([])
  const transcript = (summaryReq.messages[0]!.content[0] as { text: string }).text
  expect(transcript).toContain("q1")
  expect(transcript).not.toContain("q3")
  const next = mock.requests[3]!.messages
  expect(next.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"])
  expect((next[0]!.content[0] as { text: string }).text).toContain("SUMMARY OF r1")
  expect(types(events).filter((t) => t.startsWith("compact."))).toEqual(["compact.start", "compact.end"])
  const start = events.find((e) => e.type === "compact.start")!
  expect(start.data).toMatchObject({ reason: "threshold", replacing: 2, kept: 3, tokens: 900 })
  expect(start.turnId).toBeDefined()

  // The file keeps the originals and restores to the compacted view.
  const reopened = SessionStore.open(session.file)
  expect(reopened.entries.filter((e) => e.type === "message").length).toBe(6)
  expect(reopened.restore().messages).toEqual(agent.messages)
})

test("resuming right after a compaction does not compact again", async () => {
  const { agent, ai, session } = await setup([{ text: "r1" }, { text: "r2", ...big }, { text: "S" }])
  await agent.prompt("q1")
  await agent.prompt("q2")
  expect(await agent.compact()).toBe(true)

  const mock2 = createMockDialect([{ text: "r3" }])
  ai.registerDialect(mock2)
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const resumed = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: "/proj",
    bus,
    session: SessionStore.open(session.file),
  })
  await resumed.prompt("q3")
  await bus.flush()
  expect(mock2.requests.length).toBe(1)
  expect(types(events).filter((t) => t.startsWith("compact."))).toEqual([])
})

test("only usage reported after the last compaction is restored", async () => {
  const { agent, session } = await setup([
    { text: "r1" },
    { text: "r2", ...big },
    { text: "S" },
    { text: "r3", ...big },
  ])
  await agent.prompt("q1")
  await agent.prompt("q2")
  expect(await agent.compact()).toBe(true)
  expect(session.restore().contextTokens).toBeUndefined()
  await agent.prompt("q3")
  expect(SessionStore.open(session.file).restore().contextTokens).toBe(900)
})

test("an interrupted reply without usage keeps the context of the reply before, also restored", async () => {
  let release!: () => void
  const until = new Promise<void>((r) => {
    release = r
  })
  const { agent, session } = await setup([
    { text: "r1", usage: { input: 400, output: 20, cacheRead: 0, cacheWrite: 0 } },
    { text: "a long reply that is cut short", hold: { chunks: 1, until } },
  ])
  await agent.prompt("q1")
  expect(agent.contextTokens).toBe(420)
  const turn = agent.prompt("q2")
  while (!agent.messages.some((m) => m.role === "user" && JSON.stringify(m).includes("q2")))
    await Bun.sleep(5)
  await Bun.sleep(20)
  agent.abort()
  release()
  await turn
  expect(agent.contextTokens).toBe(420)
  expect(SessionStore.open(session.file).restore().contextTokens).toBe(420)
})

test("compact.before can supply the summary; failures fall back and never break the turn", async () => {
  const { agent, mock, bus, events } = await setup([{ text: "r1" }, { text: "r2" }, { text: "r3" }])
  agent.interceptors.add("compact.before", () => {
    throw new Error("boom")
  })
  agent.interceptors.add("compact.before", (v) => ({ action: "modify", value: { ...v, summary: "custom" } }))
  await agent.prompt("q1")
  await agent.prompt("q2")
  expect(await agent.compact()).toBe(true)
  await agent.prompt("q3")
  await bus.flush()
  expect(mock.requests.length).toBe(3)
  expect((mock.requests[2]!.messages[0]!.content[0] as { text: string }).text).toContain("custom")
  const start = events.find((e) => e.type === "compact.start")!
  expect(start.data).toMatchObject({ reason: "manual" })
  expect(start.turnId).toBeUndefined()
})

test("a failed summary emits compact.failed and the turn continues uncompacted", async () => {
  const { agent, mock, bus, events } = await setup([
    { text: "r1" },
    { text: "r2", ...big },
    { error: { message: "summary broke" } },
    { text: "r3", ...big },
    { text: "r4" },
  ])
  agent.tools.register(
    defineTool({ name: "noop", description: "", parameters: {}, execute: async () => textResult("ok") }),
    "t",
  )
  await agent.prompt("q1")
  await agent.prompt("q2")
  const r = await agent.prompt("q3")
  await bus.flush()
  expect(r.reason).toBe("done")
  expect(events.filter((e) => e.type === "compact.failed").map((e) => e.data)).toEqual([
    { error: "summary broke" },
  ])
  expect(types(events).filter((t) => t.startsWith("compact."))).toEqual(["compact.start", "compact.failed"])
  expect(mock.requests[3]!.messages.length).toBe(5)
})

test("manual compaction with too little history reports why", async () => {
  const { agent, bus, events } = await setup([{ text: "r1" }])
  await agent.prompt("q1")
  expect(await agent.compact()).toBe(false)
  await bus.flush()
  expect(events.at(-1)).toMatchObject({ type: "compact.failed", data: { error: "nothing to compact yet" } })
})

test("a blocking compact.before cancels compaction", async () => {
  const { agent, bus, events } = await setup([{ text: "r1" }, { text: "r2" }])
  agent.interceptors.add("compact.before", () => ({ action: "block", reason: "not now" }))
  await agent.prompt("q1")
  await agent.prompt("q2")
  expect(await agent.compact()).toBe(false)
  await bus.flush()
  expect(agent.messages.length).toBe(4)
  expect(events.at(-1)?.data).toEqual({ error: "not now", blocked: true })
  expect(types(events)).not.toContain("compact.start")
})

test("manual compaction passes the user's instructions to the summary request", async () => {
  const { agent, mock } = await setup([{ text: "r1" }, { text: "r2" }, { text: "S" }])
  await agent.prompt("q1")
  await agent.prompt("q2")
  expect(await agent.compact("keep the API notes")).toBe(true)
  const request = (mock.requests[2]!.messages[0]!.content[0] as { text: string }).text
  expect(request).toContain("<transcript>")
  expect(request).toContain("The user asked for this summary: keep the API notes")
})

test("preview shows what the next model call would send, after the interceptors", async () => {
  const { agent } = await setup([
    { text: "r1", usage: { input: 40, output: 2, cacheRead: 0, cacheWrite: 0 } },
  ])
  agent.tools.register(
    defineTool({
      name: "noop",
      description: "does nothing",
      parameters: {},
      execute: async () => textResult(""),
    }),
    "t",
  )
  agent.interceptors.add("system.build", (v) => ({
    action: "modify",
    value: { sections: [...v.sections, { name: "extra", text: "EXTRA" }] },
  }))
  expect(agent.contextTokens).toBeUndefined()
  await agent.prompt("q1")
  expect(agent.contextTokens).toBe(42)
  const p = await agent.preview()
  expect(p.systemPrompt).toBe("sys\n\nEXTRA")
  expect(p.messages).toEqual(agent.messages)
  expect(p.tools.map((t) => t.name)).toEqual(["noop"])
  agent.interceptors.add("context.build", () => ({ action: "block", reason: "no" }))
  await expect(agent.preview()).rejects.toThrow("context.build blocked the request: no")
})

const noop = defineTool({
  name: "noop",
  description: "",
  parameters: {},
  execute: async () => textResult("ok"),
})
const step = (n: number, extra: object = {}) => ({
  toolCalls: [{ name: "noop", args: { n }, id: `c${n}` }],
  ...extra,
})
const text = (m: Message) => m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
/** Summary calls go out without tools; the agent's own calls offer the noop tool. */
const summaryCalls = (mock: ReturnType<typeof createMockDialect>) =>
  mock.requests.filter((r) => !r.tools.length)

test("a long single turn compacts its older steps, keeping the prompt and the latest steps", async () => {
  const { agent, mock, session } = await setup([
    step(1),
    step(2),
    step(3, big),
    { text: "SUMMARY" },
    { text: "done" },
  ])
  agent.tools.register(noop, "t")
  expect((await agent.prompt("q1")).reason).toBe("done")
  expect(summaryCalls(mock)).toHaveLength(1)
  const transcript = text(summaryCalls(mock)[0]!.messages[0]!)
  expect(transcript).toContain('{"n":1}')
  expect(transcript).not.toContain('{"n":2}')
  // The turn's prompt is given as context, outside the transcript that gets replaced.
  expect(transcript.split("<transcript>")[0]).toContain("q1")
  expect(transcript.split("<transcript>")[1]).not.toContain("q1")
  const next = mock.requests.at(-1)!.messages
  expect(next.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "toolResult",
    "assistant",
    "toolResult",
  ])
  expect(text(next[0]!)).toContain("SUMMARY")
  expect(text(next[2]!)).toBe("q1")
  expect(SessionStore.open(session.file).restore().messages).toEqual(agent.messages)
})

test("a compaction that leaves the context over the threshold is not repeated every step", async () => {
  const { agent, mock } = await setup([
    step(1),
    step(2),
    step(3, big),
    { text: "S1" },
    step(4, big),
    step(5, big),
    step(6, { usage: { input: 960 } }),
    { text: "S2" },
    { text: "done" },
  ])
  agent.tools.register(noop, "t")
  expect((await agent.prompt("q1")).reason).toBe("done")
  // S1 did not help (the next reply is still at 900), so the next summary waits for growth.
  const summaries = summaryCalls(mock).map((r) => text(r.messages[0]!))
  expect(summaries).toHaveLength(2)
  // The second summary folds the first one together with the steps since, never it alone.
  expect(summaries[1]).toContain("S1")
  expect(summaries[1]).toContain('{"n":4}')
  expect(text(agent.messages[0]!)).toContain("S2")
})

test("a turn over the threshold with nothing to fold yet compacts once enough steps exist", async () => {
  const { agent, mock } = await setup([
    step(1, big),
    step(2, big),
    step(3, big),
    { text: "SUMMARY" },
    { text: "done" },
  ])
  agent.tools.register(noop, "t")
  expect((await agent.prompt("q1")).reason).toBe("done")
  expect(summaryCalls(mock)).toHaveLength(1)
  expect(text(agent.messages[0]!)).toContain("SUMMARY")
})

test("splitHistory cuts whole older turns before folding the current one", () => {
  const model = { provider: "p", model: "m" }
  const u = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
  const call = (id: string) => ({
    role: "assistant" as const,
    model,
    content: [{ type: "toolCall" as const, id, name: "t", args: {} }],
  })
  const result = (id: string) => ({
    role: "toolResult" as const,
    toolCallId: id,
    toolName: "t",
    content: [],
    isError: false,
  })
  const h = [
    u("1"),
    call("a"),
    result("a"),
    u("2"),
    call("b"),
    result("b"),
    call("c"),
    result("c"),
    call("d"),
    result("d"),
  ]
  for (const keepTurns of [1, 2]) {
    expect(splitHistory(h, keepTurns)).toEqual({ older: h.slice(0, 3), kept: h.slice(3) })
  }
})

test("splitHistory never summarizes an earlier summary alone", () => {
  const model = { provider: "p", model: "m" }
  const [s, ack] = summaryMessages("old", model)
  const user = { role: "user" as const, content: [{ type: "text" as const, text: "q" }] }
  const call = (id: string) => ({
    role: "assistant" as const,
    model,
    content: [{ type: "toolCall" as const, id, name: "t", args: {} }],
  })
  const result = (id: string) => ({
    role: "toolResult" as const,
    toolCallId: id,
    toolName: "t",
    content: [],
    isError: false,
  })
  expect(splitHistory([s!, ack!, user, call("a"), result("a")])).toBeUndefined()
  expect(splitHistory([s!, ack!, user, call("a"), result("a"), call("b"), result("b")])).toBeUndefined()
  const long = [s!, ack!, user, call("a"), result("a"), call("b"), result("b"), call("c"), result("c")]
  expect(splitHistory(long)).toEqual({
    older: long.slice(0, 2).concat(long.slice(3, 5)),
    kept: [user, ...long.slice(5)],
    prompt: user,
  })
})

test("extension records are kept in the session file, per key, and come back on resume", async () => {
  let seen: unknown[] | undefined
  const { agent, session, ai } = await setup([
    { toolCalls: [{ name: "note", args: {}, id: "c1" }] },
    { text: "noted" },
  ])
  agent.tools.register(
    defineTool({
      name: "note",
      description: "note",
      parameters: { type: "object" },
      execute: async (_p, ctx) => {
        ctx.session!.data!.append("swarm", { key: "plan", value: "1. read" })
        ctx.session!.data!.append("other", 42)
        seen = ctx.session!.data!.read("swarm")
        return textResult("ok")
      },
    }),
    "t",
  )
  const record = { at: 1, nested: { list: [1, 2] } }
  agent.data.append("swarm", record)
  record.nested.list.push(3)
  await agent.prompt("go")
  expect(seen).toEqual([
    { at: 1, nested: { list: [1, 2] } },
    { key: "plan", value: "1. read" },
  ])
  const copy = agent.data.read("swarm")
  ;(copy[0] as { at: number }).at = 99
  expect(agent.data.read("swarm")[0]).toMatchObject({ at: 1 })
  // A resumed session reads them back from its file; its messages are unchanged.
  const resumed = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: "/proj",
    session: SessionStore.open(session.file),
  })
  expect(resumed.data.read("swarm")).toEqual(seen!)
  expect(resumed.data.read("other")).toEqual([42])
  expect(resumed.messages).toEqual(agent.messages)
  // Without a file they are kept in memory.
  const plain = new Agent({ ai, model: ai.model("mock/m"), cwd: "/proj" })
  plain.data.append("swarm", "x")
  expect(plain.data.read("swarm")).toEqual(["x"])
  expect(plain.data.read("none")).toEqual([])
})

const overflow = { error: { message: "HTTP 400: maximum context length is 1000 tokens", status: 400 } }

test("a request over the context window is compacted and sent again, once", async () => {
  const { agent, mock, bus, events } = await setup([
    { text: "r1" },
    { text: "r2" },
    overflow,
    { text: "SUM" },
    { text: "r3" },
  ])
  await agent.prompt("q1")
  await agent.prompt("q2")
  const r = await agent.prompt("q3")
  await bus.flush()
  expect(r.reason).toBe("done")
  expect(mock.requests).toHaveLength(5)
  const start = events.find((e) => e.type === "compact.start")!
  expect(start.data).toMatchObject({ reason: "overflow" })
  expect((mock.requests[4]!.messages[0]!.content[0] as { text: string }).text).toContain("SUM")
})

test("a request still over the window after compacting fails with what to do", async () => {
  const { agent, bus, events } = await setup([
    { text: "r1" },
    { text: "r2" },
    overflow,
    { text: "SUM" },
    overflow,
  ])
  await agent.prompt("q1")
  await agent.prompt("q2")
  const r = await agent.prompt("q3")
  await bus.flush()
  expect(r.reason).toBe("error")
  expect(r.failure).toMatchObject({ kind: "context" })
  expect(r.failure?.hint).toContain("/compact")
  expect(events.filter((e) => e.type === "compact.start")).toHaveLength(1)
  const end = events.findLast((e) => e.type === "turn.end")!
  expect(end.data).toMatchObject({ reason: "error", failure: { kind: "context" } })
})

test("with nothing to compact, an overflow says so at once", async () => {
  const { agent } = await setup([overflow])
  const r = await agent.prompt("q1")
  expect(r.failure?.kind).toBe("context")
  expect(r.failure?.hint).toContain("Nothing older to compact")
})

test("a retried request is announced with model.retry", async () => {
  const { agent, bus, events } = await setup([
    { error: { message: "HTTP 429: slow", status: 429, retryable: true } },
    { text: "ok" },
  ])
  await agent.prompt("q")
  await bus.flush()
  const retry = events.find((e) => e.type === "model.retry")
  expect(retry?.data).toMatchObject({ attempt: 1, maxRetries: 3, status: 429, kind: "rate" })
})
