import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent, type AgentOptions } from "../src/agent.ts"
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
