import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type Ai, createAi, createMockDialect, emptyUsage, type Usage, userMessage } from "@amira/ai"
import { addAccountingUsage } from "../src/accounting-receipts.ts"
import {
  accountingAuxiliaryRecorded,
  accountingRecorded,
  unfinishedAccounting,
  withAccountingRequests,
} from "../src/accounting-requests.ts"
import { Agent } from "../src/agent.ts"
import { conversationUsage } from "../src/owned-conversations-usage.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture(base: Ai) {
  const directory = mkdtempSync(path.join(tmpdir(), "amira-attempt-fence-"))
  const store = SessionStore.create({ cwd: directory, dir: directory })
  const tree = new AgentTree({ ai: base, sections: () => [] })
  const agent = new Agent({
    ai: base,
    tree,
    session: store,
    cwd: directory,
    model: base.model("mock/test"),
    sections: [],
    compaction: { auto: false },
  })
  cleanups.push(async () => {
    await agent.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  return { agent, store, ai: withAccountingRequests(base, agent, () => ({ store })), tree }
}

function provider() {
  return createAi({
    dialects: [
      createMockDialect([
        { error: { message: "retry", retryable: true }, usage: { input: 20, output: 2, cost: 0.2 } },
        { text: "reply", usage: { input: 20, output: 2, cost: 0.2 } },
      ]),
    ],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 1, baseDelayMs: 1 },
  })
}

function book(agent: Agent, store: SessionStore, usage: Usage) {
  store.append({ type: "side_usage", model: { provider: "mock", model: "test" }, usage })
  accountingRecorded(agent, usage)
}

function request(ai: Ai) {
  return { model: ai.model("mock/test"), systemPrompt: "", messages: [], tools: [] }
}

function sharedUsageProvider(usage: Usage) {
  const base = provider()
  return {
    ...base,
    async *stream() {
      yield {
        type: "done" as const,
        message: {
          role: "assistant" as const,
          model: { provider: "mock", model: "test" },
          content: [],
          usage,
        },
      }
    },
  }
}

async function drain(ai: Ai): Promise<Usage> {
  let usage: Usage | undefined
  for await (const event of ai.stream(request(ai), new AbortController().signal)) {
    if (event.type === "done") usage = event.message.usage
  }
  if (!usage) throw new Error("mock omitted its receipt")
  return usage
}

test("concurrent requests on one agent do not share identical provider-owned usage receipts", async () => {
  const shared = { ...emptyUsage(), input: 20, output: 2, cost: 0.2 }
  const { ai, agent, store } = fixture(sharedUsageProvider(shared))
  const [first, second] = await Promise.all([drain(ai), drain(ai)])
  expect(first).not.toBe(second)
  book(agent, store, first)
  expect(unfinishedAccounting(store)).toHaveLength(1)
  expect(conversationUsage(SessionStore.open(store.file)).own.complete).toBe(false)
  book(agent, store, second)
  expect(unfinishedAccounting(store)).toHaveLength(0)
  expect(conversationUsage(store).own.knownCostUsd).toBeCloseTo(0.4)
  expect(conversationUsage(store).own.complete).toBe(true)
})

test("aggregate auxiliary settlement closes only the represented attempts", async () => {
  const shared = { ...emptyUsage(), input: 20, output: 2, cost: 0.2 }
  const { ai, agent, store } = fixture(sharedUsageProvider(shared))
  const first = await drain(ai)
  shared.input = 30
  shared.cost = 0.3
  const second = await drain(ai)
  const aggregate = addAccountingUsage(emptyUsage(), second)
  book(agent, store, aggregate)
  accountingAuxiliaryRecorded(agent, aggregate)
  expect(unfinishedAccounting(store)).toHaveLength(1)
  expect(conversationUsage(store).own.complete).toBe(false)
  book(agent, store, first)
  expect(unfinishedAccounting(store)).toHaveLength(0)
  expect(conversationUsage(store).own.knownCostUsd).toBeCloseTo(0.5)
  expect(conversationUsage(store).own.complete).toBe(true)
})

test("synthetic retry-backoff abort reuses its durable receipt without opening another attempt", async () => {
  const base = provider()
  const abort = new AbortController()
  const { ai, agent, store } = fixture({
    ...base,
    async *stream(request, signal) {
      for await (const event of base.stream(request, signal)) {
        yield event
        if (event.type === "retry") abort.abort()
      }
    },
  })
  let usage: Usage | undefined
  for await (const event of ai.stream(request(ai), abort.signal)) {
    if (event.type === "request.end") usage = event.message.usage
    if (event.type === "retry" && usage) book(agent, store, usage)
  }
  expect(unfinishedAccounting(store)).toHaveLength(0)
  expect(conversationUsage(store).own.knownCostUsd).toBeCloseTo(0.2)
  expect(conversationUsage(SessionStore.open(store.file)).own.complete).toBe(true)
})

test("identical retry usage cannot close the fence before the final attempt is durable", async () => {
  const { ai, agent, store } = fixture(provider())
  let previous: Usage | undefined
  let final: Usage | undefined
  for await (const event of ai.stream(request(ai), new AbortController().signal)) {
    if (event.type === "request.end") previous = event.message.usage
    if (event.type === "retry" && previous) book(agent, store, previous)
    if (event.type === "done") final = event.message.usage
  }
  expect(conversationUsage(store).own.knownCostUsd).toBeCloseTo(0.2)
  expect(conversationUsage(store).own.complete).toBe(false)
  expect(conversationUsage(SessionStore.open(store.file)).own.complete).toBe(false)
  book(agent, store, final!)
  expect(unfinishedAccounting(store)).toHaveLength(0)
  expect(conversationUsage(store).own.knownCostUsd).toBeCloseTo(0.4)
  expect(conversationUsage(SessionStore.open(store.file)).own.complete).toBe(true)
})

for (const partial of [
  { input: 20, outputReported: false, cost: undefined },
  { input: 20, output: 2, cost: undefined },
])
  test(`partial summary coverage (${partial.outputReported === false ? "output" : "cost"}) survives retry and reopen`, async () => {
    const base = createAi({
      dialects: [
        createMockDialect([
          { error: { message: "retry", retryable: true }, usage: partial },
          { text: "summary", usage: { input: 30, output: 3, cost: 0.3 } },
        ]),
      ],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      retry: { retries: 1, baseDelayMs: 1 },
    })
    const directory = mkdtempSync(path.join(tmpdir(), "amira-summary-coverage-"))
    const store = SessionStore.create({
      cwd: directory,
      dir: directory,
      owned: {
        v: 1,
        owner: "test",
        spec: {
          key: "test",
          name: "Test",
          cwd: directory,
          model: "mock/test",
          systemPrompt: "",
          callableTools: [],
        },
        runtimeTools: [],
      },
    })
    store.appendMessage(userMessage("seed"))
    const tree = new AgentTree({ ai: base, sections: () => [] })
    const agent = new Agent({
      ai: base,
      tree,
      session: store,
      cwd: directory,
      model: base.model("mock/test"),
      sections: [],
      ownedConversation: "test",
      messages: [
        userMessage("old"),
        {
          role: "assistant",
          content: [{ type: "text", text: "old reply" }],
          model: { provider: "mock", model: "test" },
        },
        userMessage("new"),
      ],
      compaction: { auto: false },
    })
    cleanups.push(async () => {
      await agent.dispose()
      rmSync(directory, { recursive: true, force: true })
    })
    expect(await agent.compact()).toBe(true)
    expect(conversationUsage(store).own.knownCostUsd).toBeCloseTo(0.3)
    expect(unfinishedAccounting(store)).toHaveLength(1)
    expect(store.entries.find((entry) => entry.type === "compaction")?.accounting?.coverageIncomplete).toBe(
      true,
    )
    expect(conversationUsage(store).own.complete).toBe(false)
    expect(conversationUsage(SessionStore.open(store.file)).own.complete).toBe(false)
  })
