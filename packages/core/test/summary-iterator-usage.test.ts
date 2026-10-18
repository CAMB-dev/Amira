import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type Ai, createAi, createMockDialect, emptyUsage, userMessage } from "@amira/ai"
import { reportedUsage } from "../src/accounting-receipts.ts"
import { Agent } from "../src/agent.ts"
import { SummaryError, summarize } from "../src/compaction.ts"
import { conversationUsage } from "../src/owned-conversations-usage.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Boundary = "retry" | "request.end" | "done" | "none" | "error" | "done-cleanup" | "error-cleanup"

function provider(boundary: Boundary = "retry", failure: unknown = new Error("adapter failure")) {
  const mock = createMockDialect([
    {
      error: { message: "temporary failure", retryable: boundary !== "error" },
      usage: { input: 20, output: 2, cost: 0.2 },
    },
    { text: "summary", usage: { input: 30, output: 3, cost: 0.3 } },
  ])
  const base = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 1, baseDelayMs: 1, maxDelayMs: 1 },
  })
  const ai: Ai = {
    ...base,
    async *stream(request, signal) {
      if (boundary === "none") throw failure
      if (boundary.endsWith("-cleanup")) {
        const message = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "summary" }],
          model: { provider: request.model.provider, model: request.model.id },
          usage: { ...emptyUsage(), input: 20, output: 2, cost: 0.2 },
        }
        try {
          yield boundary === "done-cleanup"
            ? { type: "done", message }
            : {
                type: "error",
                message,
                error: { message: "temporary failure" },
                retryable: false,
              }
        } finally {
          yield {
            type: "request.end",
            message: { ...message, content: [], usage: { ...emptyUsage(), input: 30, output: 3, cost: 0.3 } },
          }
          // biome-ignore lint/correctness/noUnsafeFinally: reproduce a final receipt from failing cleanup.
          throw failure
        }
      }
      try {
        for await (const event of base.stream(request, signal)) {
          yield event
          if (event.type === boundary && boundary !== "done" && boundary !== "error") throw failure
        }
      } finally {
        // biome-ignore lint/correctness/noUnsafeFinally: reproduce an adapter's cleanup failure after done.
        if (boundary === "done") throw failure
      }
    },
  }
  return { ai, mock }
}

const scenarios: { boundary: Boundary; cost: number; input: number; incomplete: boolean }[] = [
  { boundary: "retry", cost: 0.2, input: 20, incomplete: true },
  { boundary: "request.end", cost: 0.2, input: 20, incomplete: true },
  { boundary: "done", cost: 0.5, input: 50, incomplete: true },
  { boundary: "none", cost: 0, input: 0, incomplete: true },
  { boundary: "error", cost: 0.2, input: 20, incomplete: false },
  { boundary: "done-cleanup", cost: 0.3, input: 30, incomplete: true },
  { boundary: "error-cleanup", cost: 0.3, input: 30, incomplete: true },
]

async function summaryFailure(ai: Ai): Promise<SummaryError> {
  let failure: unknown
  try {
    await summarize(ai, ai.model("mock/summary"), [userMessage("old")], new AbortController().signal)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(SummaryError)
  if (!(failure instanceof SummaryError)) throw failure
  return failure
}

for (const scenario of scenarios) {
  test(`summary failure at ${scenario.boundary} preserves reported usage without double counting`, async () => {
    const { ai } = provider(scenario.boundary)
    const failure = await summaryFailure(ai)
    expect(failure.message).toBe(scenario.boundary === "error" ? "temporary failure" : "adapter failure")
    expect(failure.usage?.cost ?? 0).toBeCloseTo(scenario.cost)
    expect(failure.usage?.input ?? 0).toBe(scenario.input)
    expect(failure.usageIncomplete).toBe(scenario.incomplete)
    if (scenario.boundary === "none") expect(failure.usage).toBeUndefined()
  })
}

test("an existing SummaryError from the iterator is preserved unchanged", async () => {
  const original = new SummaryError("already accounted", { ...emptyUsage(), input: 20, cost: 0.2 }, false)
  const { ai } = provider("retry", original)
  expect(await summaryFailure(ai)).toBe(original)
})

test("non-Error iterator failures still become incomplete SummaryErrors", async () => {
  const { ai } = provider("retry", "adapter failure")
  const failure = await summaryFailure(ai)
  expect(failure.message).toBe("adapter failure")
  expect(failure.usage?.cost).toBeCloseTo(0.2)
  expect(failure.usageIncomplete).toBe(true)
})

test("synchronous stream creation failures become incomplete SummaryErrors without invented usage", async () => {
  const { ai } = provider()
  const failure = await summaryFailure({
    ...ai,
    stream() {
      throw new Error("cannot open stream")
    },
  })
  expect(failure.message).toBe("cannot open stream")
  expect(failure.usage).toBeUndefined()
  expect(failure.usageIncomplete).toBe(true)
})

function conversation(ai: Ai, fill: boolean) {
  const directory = mkdtempSync(path.join(tmpdir(), "amira-summary-iterator-"))
  const store = SessionStore.create({
    cwd: directory,
    dir: directory,
    owned: {
      v: 1,
      owner: "test",
      spec: {
        key: "summary",
        name: "Summary",
        cwd: directory,
        model: "mock/summary",
        systemPrompt: "",
        callableTools: [],
      },
      runtimeTools: [],
    },
  })
  const old = store.appendMessage(userMessage("old"))
  const reply = store.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "old reply" }],
    model: { provider: "mock", model: "summary" },
    usage: reportedUsage(emptyUsage()),
  })
  if (fill) {
    store.append({
      type: "compaction",
      summary: "",
      replaces: [old, reply],
      checkpoint: {
        kind: "checkpoint",
        dialect: "mock",
        provider: "previous",
        host: "https://previous.invalid",
        model: "old",
        value: "encrypted checkpoint",
      },
    })
  }
  store.appendMessage(userMessage("new"))
  const tree = new AgentTree({ ai, sections: () => [] })
  const agent = new Agent({
    ai,
    tree,
    session: store,
    cwd: directory,
    model: ai.model("mock/summary"),
    sections: [],
    ownedConversation: "test",
    compaction: { auto: false },
  })
  cleanups.push(async () => {
    await agent.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  return { agent, tree, store }
}

for (const fill of [false, true]) {
  for (const scenario of scenarios) {
    test(`${fill ? "checkpoint filling" : "ordinary compaction"}: ${scenario.boundary} failure retains tree/live/reopened accounting`, async () => {
      const { ai } = provider(scenario.boundary)
      const { agent, tree, store } = conversation(ai, fill)
      const before = [...agent.messages]
      const failures: string[] = []
      agent.bus.subscribe((event) => {
        if (event.type === "compact.failed") failures.push(event.data.error)
      })
      expect(await agent.compact()).toBe(false)
      await agent.bus.flush()
      expect(failures.join("\n")).toContain(
        scenario.boundary === "error" ? "temporary failure" : "adapter failure",
      )
      expect(tree.usage.cost ?? 0).toBeCloseTo(scenario.cost)
      expect(tree.usage.input).toBe(scenario.input)
      expect(agent.compactionUsage).toHaveLength(scenario.cost ? 1 : 0)
      expect(agent.messages).toEqual(before)
      for (const source of [agent, SessionStore.open(store.file)]) {
        const snapshot = conversationUsage(source)
        expect(snapshot.own.knownCostUsd).toBeCloseTo(scenario.cost)
        expect(snapshot.own.usage.input).toBe(scenario.input)
        expect(snapshot.own.complete).toBe(!scenario.incomplete)
        expect(snapshot.total).toEqual(snapshot.own)
      }
      expect(store.entries.filter((entry) => entry.type === "compaction")).toHaveLength(fill ? 1 : 0)
      const receipt = store.entries.find((entry) => entry.type === "side_usage")
      if (scenario.cost) {
        expect(receipt?.accounting?.coverageIncomplete ?? false).toBe(scenario.incomplete)
        expect(receipt?.accounting?.knownCostUsd).toBeCloseTo(scenario.cost)
      } else expect(receipt).toBeUndefined()
    })
  }
}
