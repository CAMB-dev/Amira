import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type Ai, createAi, createMockDialect, type MockStep, userMessage } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { SummaryError, summarize } from "../src/compaction.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function provider(steps: MockStep[], abort?: AbortController) {
  const mock = createMockDialect(steps)
  const base = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 1, baseDelayMs: abort ? 60_000 : 1, maxDelayMs: 60_000 },
  })
  const ai: Ai = {
    ...base,
    async *stream(request, signal) {
      for await (const event of base.stream(request, signal)) {
        yield event
        // Resume into the real retry sleep only after the consumer has seen the boundary.
        if (event.type === "retry") abort?.abort()
      }
    },
  }
  return { ai, mock }
}

const failed: MockStep = {
  error: { message: "temporary failure", retryable: true },
  usage: { input: 20, output: 2, cost: 0.2 },
}
const success: MockStep = { text: "summary", usage: { input: 30, output: 3, cost: 0.3 } }

async function conversation(ai: Ai) {
  const home = mkdtempSync(path.join(tmpdir(), "amira-turn-retry-usage-"))
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  const main = new Agent({ ai, model: ai.model("mock/main"), cwd: home, tools, tree, sections: [] })
  const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
  cleanups.push(async () => {
    await manager.drain()
    await main.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const owner = manager.forOwner("retry-test")
  const handle = await owner.openOrCreate(
    {
      key: "conversation",
      name: "Retry",
      cwd: home,
      model: "mock/owned",
      systemPrompt: "",
      callableTools: [],
    },
    { askUser: async () => undefined },
  )
  return { handle, owner, tree, main }
}

test("owned send retains the failed attempt as well as its successful retry, live and after release", async () => {
  const { ai, mock } = provider([failed, success])
  const { handle, owner, tree, main } = await conversation(ai)
  await handle.send("go")
  expect(mock.requests).toHaveLength(2)
  expect(handle.usage().own.knownCostUsd).toBeCloseTo(0.5)
  expect(handle.usage().own.usage.input).toBe(50)
  expect(tree.usage.cost).toBeCloseTo(0.5)
  expect(main.messages).toEqual([])
  await handle.release()
  const saved = await owner.read({ id: handle.id })
  expect(saved?.usage.own.knownCostUsd).toBeCloseTo(0.5)
  expect(saved?.usage.own.usage.input).toBe(50)
})

test("owned send aborted during retry backoff retains the failed receipt exactly once", async () => {
  const abort = new AbortController()
  const { ai, mock } = provider([failed, success], abort)
  const { handle, owner, tree } = await conversation(ai)
  await handle.send("go", { signal: abort.signal })
  expect(mock.requests).toHaveLength(1)
  expect(handle.usage().own.knownCostUsd).toBeCloseTo(0.2)
  expect(handle.usage().own.usage.input).toBe(20)
  expect(tree.usage.cost).toBeCloseTo(0.2)
  await handle.release()
  expect((await owner.read({ id: handle.id }))?.usage.own.knownCostUsd).toBeCloseTo(0.2)
})

test("owned send counts a newly opened retry that aborts with the same usage as the prior attempt", async () => {
  const abort = new AbortController()
  const { ai, mock } = provider([
    failed,
    () => {
      abort.abort()
      return { usage: { input: 20, output: 2, cost: 0.2 } }
    },
  ])
  const { handle, tree } = await conversation(ai)
  await handle.send("go", { signal: abort.signal })
  expect(mock.requests).toHaveLength(2)
  expect(handle.usage().own.knownCostUsd).toBeCloseTo(0.4)
  expect(handle.usage().own.usage.input).toBe(40)
  expect(tree.usage.cost).toBeCloseTo(0.4)
})

test("owned send does not certify a prior retry subtotal when the next adapter throws before reporting", async () => {
  const { ai, mock } = provider([
    failed,
    () => {
      throw new Error("adapter failure")
    },
  ])
  const { handle, owner, tree } = await conversation(ai)
  await expect(handle.send("go")).rejects.toThrow("adapter failure")
  expect(mock.requests).toHaveLength(2)
  expect(tree.usage.cost).toBeCloseTo(0.2)
  expect(handle.usage().own).toMatchObject({ knownCostUsd: 0.2, complete: false })
  await handle.release()
  expect((await owner.read({ id: handle.id }))?.usage.own).toMatchObject({
    knownCostUsd: 0.2,
    complete: false,
  })
})

test("summary retries count each provider attempt", async () => {
  const { ai, mock } = provider([failed, success])
  const result = await summarize(
    ai,
    ai.model("mock/summary"),
    [userMessage("old")],
    new AbortController().signal,
  )
  expect(result.summary).toBe("summary")
  expect(result.usage?.cost).toBeCloseTo(0.5)
  expect(result.usage?.input).toBe(50)
  expect(result.usageIncomplete).toBeUndefined()
  expect(mock.requests).toHaveLength(2)
})

test("summary counts a newly opened retry that aborts with the same usage as the prior attempt", async () => {
  const abort = new AbortController()
  const { ai, mock } = provider([
    failed,
    () => {
      abort.abort()
      return { usage: { input: 20, output: 2, cost: 0.2 } }
    },
  ])
  let failure: unknown
  try {
    await summarize(ai, ai.model("mock/summary"), [userMessage("old")], abort.signal)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(SummaryError)
  if (!(failure instanceof SummaryError)) throw failure
  expect(failure.usage?.cost).toBeCloseTo(0.4)
  expect(failure.usage?.input).toBe(40)
  expect(mock.requests).toHaveLength(2)
})

test("summary retry-backoff abort does not charge the repeated synthetic receipt twice", async () => {
  const abort = new AbortController()
  const { ai, mock } = provider([failed, success], abort)
  let failure: unknown
  try {
    await summarize(ai, ai.model("mock/summary"), [userMessage("old")], abort.signal)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(SummaryError)
  if (!(failure instanceof SummaryError)) throw failure
  expect(failure.message).toBe("aborted")
  expect(failure.usage?.cost).toBeCloseTo(0.2)
  expect(failure.usage?.input).toBe(20)
  expect(failure.usageIncomplete).toBe(false)
  expect(mock.requests).toHaveLength(1)
})
