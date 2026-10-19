import { afterEach, expect, test } from "bun:test"
import {
  type Ai,
  type AssistantMessage,
  createAi,
  createMockDialect,
  emptyUsage,
  type Message,
  type ModelError,
  type StreamEvent,
  userMessage,
} from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { summaryMessages } from "../src/compaction.ts"
import { EventBus } from "../src/event-bus.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const codes = ["proxy_reconnect_expired", "proxy_broker_lost", "proxy_retention_expired"] as const
const failure = (code: string): ModelError => ({ code, kind: "network", message: `Proxy lost: ${code}` })
const reply = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  model: { provider: "mock", model: "m" },
  stopReason: "end",
  usage: { ...emptyUsage(), input: 100 },
})
const history: Message[] = [
  userMessage("old"),
  reply("old reply"),
  userMessage("recent"),
  reply("recent reply"),
]

function setup(options: { messages?: Message[]; auto?: boolean; threshold?: number } = {}) {
  const mock = createMockDialect([{ text: "reconnected" }])
  const base = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 1 } }],
    retry: { retries: 0 },
  })
  const ai: Ai = { ...base }
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    bus,
    messages: options.messages ?? structuredClone(history),
    compaction: { auto: options.auto ?? true, threshold: options.threshold ?? 0, keepTurns: 1 },
    noticeRetryMs: [1],
  })
  cleanups.push(() => agent.dispose())
  return { ai, agent, events, mock, bus }
}

for (const code of codes) {
  test(`${code}: native compaction ends the turn without summary/model fallback or notice retry`, async () => {
    const { ai, agent, events, mock, bus } = setup()
    const error = failure(code)
    let compactions = 0
    ai.nativeCompaction = () => ({ dialect: "mock", methods: ["server"], layouts: ["tail"], midTurn: true })
    ai.compact = async () => {
      compactions++
      return { ok: false, error: error.message, failure: error, usage: emptyUsage(), tried: [] }
    }
    const result = await agent.prompt(userMessage("notice", { origin: "subagent", text: "notice" }))
    expect(compactions).toBe(1)
    expect(result).toMatchObject({ reason: "error", error: error.message, failure: { kind: "network" } })
    expect(mock.requests).toHaveLength(0)
    expect(agent.noticeRetry).toBeUndefined()
    await bus.flush()
    expect(events.filter((e) => e.type === "notice.retry")).toHaveLength(0)
    expect(events.findLast((e) => e.type === "turn.end")?.data).toMatchObject({
      reason: "error",
      failure: { kind: "network" },
    })
    ai.nativeCompaction = () => undefined
    mock.push({ text: "reconnected reply" })
    expect((await agent.prompt("try after reconnect")).reason).toBe("done")
    // The fresh user turn may compact and then make its ordinary model request again.
    expect(mock.requests).toHaveLength(2)
  })
}

test("a terminal summary failure does not proceed to the final model request", async () => {
  const { ai, agent } = setup()
  let requests = 0
  ai.stream = async function* () {
    requests++
    yield {
      type: "error",
      error: failure(codes[0]),
      retryable: false,
      message: { ...reply("partial summary"), stopReason: "error" },
    }
  }
  expect(await agent.prompt("continue")).toMatchObject({ reason: "error", failure: { kind: "network" } })
  expect(requests).toBe(1)
})

test("terminal proxy summary failure survives iterator cleanup without changing ordinary error precedence", async () => {
  const { ai, agent } = setup()
  const error = failure(codes[0])
  ai.stream = async function* () {
    yield { type: "error", error, retryable: false, message: { ...reply("partial"), stopReason: "error" } }
    throw new Error("adapter cleanup failure")
  }
  expect(await agent.prompt("continue")).toMatchObject({
    reason: "error",
    error: error.message,
    failure: { kind: "network" },
  })
})

test("checkpoint filling latches the failure instead of trying it again before the model call", async () => {
  const checkpoint = {
    kind: "checkpoint" as const,
    dialect: "mock",
    provider: "mock",
    model: "old",
    value: "opaque",
  }
  const messages = [...summaryMessages("", { provider: "mock", model: "old" }, checkpoint), ...history]
  const { ai, agent } = setup({ messages })
  ai.canReplay = () => false
  // Forks carry the original transcript through the AgentOptions.originals seam.
  await agent.dispose()
  const restored = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    messages,
    originals: (summary) => (summary === messages[0] ? history : undefined),
    compaction: { threshold: 0, keepTurns: 1 },
  })
  cleanups.push(() => restored.dispose())
  let requests = 0
  ai.stream = async function* () {
    requests++
    yield {
      type: "error",
      error: failure(codes[1]),
      retryable: false,
      message: { ...reply(""), stopReason: "error" },
    }
  }
  expect(await restored.prompt("continue")).toMatchObject({ reason: "error", failure: { kind: "network" } })
  expect(requests).toBe(1)
})

test("terminal streamed partial text is retained and incomplete tool calls never execute", async () => {
  const { ai, agent, events, bus } = setup({ messages: [], auto: false })
  let executed = 0
  agent.tools.register(
    defineTool({
      name: "danger",
      description: "",
      parameters: {},
      execute: async () => {
        executed++
        return textResult("ran")
      },
    }),
    "test",
  )
  ai.stream = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: "text.delta", text: "retained partial" }
    yield { type: "toolCall.delta", id: "incomplete", name: "danger", argsDelta: "{" }
    yield {
      type: "error",
      error: failure(codes[1]),
      retryable: false,
      message: {
        ...reply("retained partial"),
        stopReason: "error",
        content: [
          { type: "text", text: "retained partial" },
          { type: "toolCall", id: "incomplete", name: "danger", args: {} },
        ],
      },
    }
  }
  expect(await agent.prompt("go")).toMatchObject({ reason: "error", failure: { kind: "network" } })
  expect(executed).toBe(0)
  expect(agent.messages.at(-1)).toMatchObject({
    stopReason: "error",
    content: [{ type: "text", text: "retained partial" }],
  })
  await bus.flush()
  expect(events.findLast((e) => e.type === "message.end")?.data).toMatchObject({
    message: { content: [{ type: "text", text: "retained partial" }] },
  })
})

for (const code of codes) {
  test(`${code}: queued and late notices wait for the next user turn`, async () => {
    const { ai, agent, bus, mock } = setup({ messages: [], auto: false })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    ai.stream = async function* () {
      entered.resolve()
      await release.promise
      yield {
        type: "error",
        error: failure(code),
        retryable: false,
        message: { ...reply(""), stopReason: "error" },
      }
    }
    const turn = agent.prompt("go")
    await entered.promise
    agent.expectNotice().deliver(userMessage("queued"))
    release.resolve()
    expect((await turn).reason).toBe("error")
    expect(agent.noticeRetry).toBeUndefined()
    agent.expectNotice().deliver(userMessage("late"))
    await bus.flush()
    expect(agent.busy).toBe(false)
    expect(agent.waitingNotices).toBe(2)
    ai.stream = createAi({
      dialects: [mock],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }).stream
    expect((await agent.prompt("user resumes")).reason).toBe("done")
    expect(agent.waitingNotices).toBe(0)
  })
}

test("manual compaction failure does not wake notices into another reconnect wait", async () => {
  const { ai, agent, mock, bus } = setup()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  ai.nativeCompaction = () => ({ dialect: "mock", methods: ["server"], layouts: ["tail"], midTurn: true })
  ai.compact = async () => {
    entered.resolve()
    await release.promise
    const error = failure(codes[0])
    return { ok: false, error: error.message, failure: error, usage: emptyUsage(), tried: [] }
  }
  const compacting = agent.compact()
  await entered.promise
  agent.expectNotice().deliver(userMessage("notice during compaction"))
  release.resolve()
  expect(await compacting).toBe(false)
  await bus.flush()
  expect(agent.busy).toBe(false)
  expect(agent.waitingNotices).toBe(1)
  expect(mock.requests).toHaveLength(0)
})

test("overflow-triggered native compaction preserves the terminal transport failure", async () => {
  const { ai, agent } = setup({ threshold: 0.9 })
  let streams = 0
  // Stay below the automatic threshold until the provider reports a real overflow.
  agent.setModel({ ...agent.model, contextWindow: 1_000_000 })
  ai.stream = async function* () {
    streams++
    yield {
      type: "error",
      error: { kind: "context", code: "context_length_exceeded", message: "context too long" },
      retryable: false,
      message: { ...reply(""), stopReason: "error" },
    }
  }
  ai.nativeCompaction = () => ({ dialect: "mock", methods: ["server"], layouts: ["tail"], midTurn: true })
  ai.compact = async () => {
    const error = failure(codes[2])
    return { ok: false, error: error.message, failure: error, usage: emptyUsage(), tried: [] }
  }
  expect(await agent.prompt("continue")).toMatchObject({
    reason: "error",
    error: failure(codes[2]).message,
    failure: { kind: "network" },
  })
  expect(streams).toBe(1)
})
