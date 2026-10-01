import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createAi,
  createMockDialect,
  type Dialect,
  type DialectCompactOutcome,
  type Message,
  type MockStep,
  type ModelRequest,
  type TextBlock,
} from "@amira/ai"
import type { AnyEvent, EventMap } from "@amira/api"
import { Agent, type AgentOptions } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"

type Script =
  | DialectCompactOutcome
  | ((req: ModelRequest, signal: AbortSignal) => Promise<DialectCompactOutcome>)

async function setup(steps: MockStep[], outcomes: Script[] = [], extra: Partial<AgentOptions> = {}) {
  const mock = createMockDialect(steps)
  const compactions: ModelRequest[] = []
  const dialect: Dialect = {
    id: "mock",
    stream: mock.stream,
    compaction: {
      methods: ["server"],
      layouts: ["tail", "recent-user"],
      midTurn: true,
      official: (baseUrl) => baseUrl.includes("srv.example"),
      async compact(_method, req, ctx) {
        compactions.push(structuredClone(req))
        const next = outcomes.shift()
        if (!next) return { ok: false, error: { message: "no script" }, unsupported: false, retryable: false }
        return typeof next === "function" ? next(req, ctx.signal) : next
      },
    },
  }
  const ai = createAi({
    dialects: [dialect],
    retry: { retries: 0 },
    providers: [
      {
        id: "mock",
        dialect: "mock",
        baseUrl: "https://srv.example/v1",
        defaultModel: { contextWindow: 1000, cost: { input: 1, output: 1 } },
      },
      {
        id: "other",
        dialect: "mock",
        baseUrl: "https://other.example",
        defaultModel: { contextWindow: 1000 },
      },
    ],
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-native-compaction-"))
  const session = SessionStore.create({ cwd: "/proj", dir })
  const tree = new AgentTree({ ai, sections: () => [{ name: "identity", text: "child" }] })
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: "/proj",
    systemPrompt: "sys",
    bus,
    session,
    tree,
    ...extra,
  })
  return { agent, ai, mock, compactions, events, session, bus, tree }
}

const big = { usage: { input: 900 } }
const checkpoint: DialectCompactOutcome = {
  ok: true,
  value: '{"type":"compaction","encrypted_content":"ENC"}',
  usage: { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0 },
}
const sigOf = (m: Message | undefined) => (m?.content[0] as TextBlock | undefined)?.signature
const textOf = (m: Message | undefined) => (m?.content[0] as TextBlock | undefined)?.text ?? ""
const ofType = <K extends keyof EventMap>(events: AnyEvent[], type: K) =>
  events.filter((e) => e.type === type).map((e) => e.data as EventMap[K])

test("the server compacts the older history; the checkpoint rides on the summary pair", async () => {
  const { agent, mock, compactions, events, session, bus, ai } = await setup(
    [{ text: "r1" }, { text: "r2", ...big }, { text: "r3" }],
    [checkpoint],
  )
  await agent.prompt("q1")
  await agent.prompt("q2")
  await agent.prompt("q3")
  await bus.flush()
  // No summary request: three replies, and one compaction request with the older turn.
  expect(mock.requests).toHaveLength(3)
  expect(compactions).toHaveLength(1)
  expect(compactions[0]!.messages.map(textOf)).toEqual(["q1", "r1"])
  expect(compactions[0]!.systemPrompt).toBe("sys")
  // The next request starts with the checkpoint, then the kept turns.
  const next = mock.requests[2]!.messages
  expect(next.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"])
  expect(sigOf(next[0])).toMatchObject({
    kind: "checkpoint",
    provider: "mock",
    host: "srv.example",
    model: "m",
  })
  expect(sigOf(next[1])).toEqual(sigOf(next[0]))
  expect(textOf(next[2])).toBe("q2")

  const start = ofType(events, "compact.start")[0]!
  expect(start).toMatchObject({ native: true, replacing: 2, kept: 3 })
  const end = ofType(events, "compact.end")[0]!
  expect(end).toMatchObject({
    summary: "",
    native: { provider: "mock", model: "m" },
    layout: "tail",
    model: { provider: "mock", model: "m" },
    usage: { input: 2000, output: 100 },
  })
  expect(end.usage?.cost).toBeCloseTo(0.0021)
  expect(end.fallback).toBeUndefined()

  // Stored with the entry; a resume rebuilds the same conversation, checkpoint included.
  const reopened = SessionStore.open(session.file)
  const entry = reopened.entries.find((e) => e.type === "compaction")!
  expect(entry).toMatchObject({
    summary: "",
    checkpoint: { kind: "checkpoint", model: "m" },
    usage: { input: 2000 },
  })
  expect(reopened.restore().messages).toEqual(agent.messages)
  const resumed = new Agent({ ai, model: agent.model, cwd: "/proj", session: reopened })
  expect(resumed.compactionInfo(resumed.messages[0]!)?.native).toEqual({ provider: "mock", model: "m" })
  expect(resumed.compactionUsage).toEqual([
    { model: { provider: "mock", model: "m" }, usage: end.usage!, native: true },
  ])
})

test("when the server cannot compact, the model writes a summary and the event says why", async () => {
  const { agent, mock, events, bus } = await setup(
    [
      { text: "r1" },
      { text: "r2", ...big },
      { text: "SUMMARY", usage: { input: 50, output: 5 } },
      { text: "r3" },
    ],
    [{ ok: false, error: { message: "HTTP 404: no" }, unsupported: true, retryable: false }],
  )
  await agent.prompt("q1")
  await agent.prompt("q2")
  await agent.prompt("q3")
  await bus.flush()
  expect(mock.requests).toHaveLength(4)
  expect(textOf(mock.requests[3]!.messages[0])).toContain("SUMMARY")
  expect(sigOf(mock.requests[3]!.messages[0])).toBeUndefined()
  const end = ofType(events, "compact.end")[0]!
  expect(end.native).toBeUndefined()
  expect(end.fallback).toBe("server: HTTP 404: no")
  expect(end.usage).toMatchObject({ input: 50, output: 5 })
  expect(agent.compactionUsage).toHaveLength(1)
})

test("/compact with instructions, or a compaction model, writes a text summary", async () => {
  const { agent, compactions } = await setup(
    [{ text: "r1" }, { text: "r2" }, { text: "S1" }, { text: "r3" }, { text: "S2" }],
    [checkpoint, checkpoint],
  )
  await agent.prompt("q1")
  await agent.prompt("q2")
  expect(await agent.compact("keep the file names")).toBe(true)
  expect(compactions).toHaveLength(0)
  const other = await setup([{ text: "r1" }, { text: "r2" }, { text: "S" }], [checkpoint])
  const withModel = new Agent({
    ai: other.ai,
    model: other.ai.model("mock/m"),
    cwd: "/proj",
    compaction: { model: other.ai.model("other/w") },
  })
  await withModel.prompt("q1")
  await withModel.prompt("q2")
  expect(await withModel.compact()).toBe(true)
  expect(other.compactions).toHaveLength(0)
})

test('the "recent-user" layout keeps the latest user messages before the checkpoint', async () => {
  const { agent, mock, compactions, session } = await setup(
    [{ text: "r1" }, { text: "r2", ...big }, { text: "r3" }],
    [checkpoint],
    { compaction: { layout: "recent-user" } },
  )
  await agent.prompt("q1")
  await agent.prompt("q2")
  await agent.prompt("q3")
  // Everything was compacted, the current prompt included.
  expect(compactions[0]!.messages.map(textOf)).toEqual(["q1", "r1", "q2", "r2", "q3"])
  const next = mock.requests[2]!.messages
  expect(next.map(textOf).slice(0, 3)).toEqual(["q1", "q2", "q3"])
  expect(sigOf(next[3])?.kind).toBe("checkpoint")
  expect(next).toHaveLength(5)
  const reopened = SessionStore.open(session.file)
  const entry = reopened.entries.find((e) => e.type === "compaction")!
  expect(entry.type === "compaction" && entry.retained).toHaveLength(3)
  expect(entry).toMatchObject({ layout: "recent-user" })
  expect(reopened.restore().messages).toEqual(agent.messages)
})

test("the budget of the recent-user layout drops the oldest user messages", async () => {
  const long = "x".repeat(4000)
  const { agent, mock } = await setup(
    [{ text: "r1" }, { text: "r2", ...big }, { text: "r3" }],
    [checkpoint],
    {
      compaction: { layout: "recent-user", keepUserTokens: 1200 },
    },
  )
  await agent.prompt(long)
  await agent.prompt(long)
  await agent.prompt("q3")
  const kept = mock.requests[2]!.messages
  expect(kept.map((m) => m.role)).toEqual(["user", "user", "user", "assistant"])
  expect(textOf(kept[1])).toBe("q3")
})

test("switching models writes a text summary of the checkpoint once; switching back uses the checkpoint", async () => {
  const { agent, ai, mock, session, events, bus } = await setup(
    [
      { text: "r1" },
      { text: "r2", ...big },
      { text: "r3" },
      { text: "WRITTEN SUMMARY", usage: { input: 70, output: 7 } },
      { text: "r4" },
      { text: "r5" },
      { text: "r6" },
    ],
    [checkpoint],
  )
  await agent.prompt("q1")
  await agent.prompt("q2")
  await agent.prompt("q3")
  agent.setModel(ai.model("other/x"))
  await agent.prompt("q4")
  await bus.flush()
  // The summary request reads the original messages the checkpoint stands for.
  const summaryReq = mock.requests[3]!
  expect(textOf(summaryReq.messages[0])).toContain("q1")
  expect(textOf(summaryReq.messages[0])).toContain("r1")
  // The other model sees the text and no checkpoint.
  const onOther = mock.requests[4]!.messages
  expect(textOf(onOther[0])).toContain("WRITTEN SUMMARY")
  expect(sigOf(onOther[0])).toBeUndefined()
  expect(ofType(events, "extension.notice").some((n) => n.text.includes("text summary"))).toBe(true)

  // Only once: the next turn on the other model writes nothing new.
  await agent.prompt("q5")
  expect(textOf(mock.requests[5]!.messages[0])).toContain("WRITTEN SUMMARY")

  // Back on the original model the checkpoint is sent again.
  agent.setModel(ai.model("mock/m"))
  await agent.prompt("q6")
  expect(sigOf(mock.requests[6]!.messages[0])?.kind).toBe("checkpoint")
  expect(mock.requests).toHaveLength(7)

  // The fill is stored: it replaces the original entry and keeps its checkpoint and cost.
  const reopened = SessionStore.open(session.file)
  const [first, fill] = reopened.entries.filter((e) => e.type === "compaction")
  expect(fill).toMatchObject({ fills: first!.id, replaces: [first!.id], summary: "WRITTEN SUMMARY" })
  expect(fill!.type === "compaction" && fill!.checkpoint?.model).toBe("m")
  expect(reopened.restore().messages).toEqual(agent.messages)
  expect(agent.compactionUsage.map((u) => [u.native ?? false, u.usage.input])).toEqual([
    [true, 2000],
    [false, 70],
  ])
})

test("a sub-agent forked onto another model writes a text summary from the parent's checkpoint", async () => {
  const { agent, mock, tree } = await setup(
    [{ text: "r1" }, { text: "r2" }, { text: "r3" }, { text: "FORK SUMMARY" }, { text: "child done" }],
    [checkpoint],
    { compaction: { auto: false } },
  )
  await agent.prompt("q1")
  await agent.prompt("q2")
  await agent.prompt("q3")
  expect(await agent.compact()).toBe(true)
  expect(sigOf(agent.messages[0])?.kind).toBe("checkpoint")
  // The child has no session entries for the forked messages: the parent tells what they stood for.
  const result = await tree.spawn(agent, { prompt: "child task", context: "fork", model: "other/x" }).result()
  expect(result.text).toBe("child done")
  expect(mock.requests).toHaveLength(5)
  const summaryReq = mock.requests[3]!
  expect(summaryReq.model.provider).toBe("other")
  expect(textOf(summaryReq.messages[0])).toContain("q1")
  expect(textOf(summaryReq.messages[0])).toContain("r1")
  const onChild = mock.requests[4]!.messages
  expect(textOf(onChild[0])).toContain("FORK SUMMARY")
  expect(sigOf(onChild[0])).toBeUndefined()
  expect(textOf(onChild.at(-1))).toBe("child task")
  // The parent keeps its checkpoint.
  expect(sigOf(agent.messages[0])?.kind).toBe("checkpoint")
})

test("a resumed session on another provider writes the summary from the session file", async () => {
  const first = await setup([{ text: "r1" }, { text: "r2", ...big }, { text: "r3" }], [checkpoint])
  await first.agent.prompt("q1")
  await first.agent.prompt("q2")
  await first.agent.prompt("q3")
  const reopened = SessionStore.open(first.session.file)
  const mock = createMockDialect([{ text: "FROM FILE" }, { text: "r4" }])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "elsewhere", dialect: "mock", baseUrl: "https://elsewhere.example" }],
  })
  const agent = new Agent({ ai, model: ai.model("elsewhere/m"), cwd: "/proj", session: reopened })
  await agent.prompt("q4")
  expect(textOf(mock.requests[0]!.messages[0])).toContain("q1")
  expect(textOf(mock.requests[1]!.messages[0])).toContain("FROM FILE")
})

test("aborting a server compaction leaves the conversation as it was", async () => {
  const started = Promise.withResolvers<void>()
  const hang: Script = (_req, signal) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () =>
        resolve({
          ok: false,
          error: { message: "aborted", code: "aborted" },
          unsupported: false,
          retryable: false,
        }),
      )
      started.resolve()
    })
  const { agent, events, bus } = await setup([{ text: "r1" }, { text: "r2" }], [hang])
  await agent.prompt("q1")
  await agent.prompt("q2")
  const before = [...agent.messages]
  const done = agent.compact()
  await started.promise
  agent.abort()
  expect(await done).toBe(false)
  await bus.flush()
  expect(agent.messages).toEqual(before)
  expect(ofType(events, "compact.failed")[0]?.error).toBe("aborted")
})
