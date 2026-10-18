import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  type Ai,
  type AssistantMessage,
  createAi,
  createMockDialect,
  emptyUsage,
  type MockStep,
  type StreamEvent,
} from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function conversation(ai: Ai) {
  const home = mkdtempSync(path.join(tmpdir(), "amira-fast-abort-"))
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  const main = new Agent({
    ai,
    model: ai.model("mock/main"),
    cwd: home,
    tools,
    tree,
    sections: [],
    fastMode: true,
  })
  const manager = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
  cleanups.push(async () => {
    await manager.drain()
    await main.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const owner = manager.forOwner("fast-abort-test")
  const handle = await owner.openOrCreate(
    { key: "test", name: "Test", cwd: home, model: "mock/owned", systemPrompt: "", callableTools: [] },
    { askUser: async () => undefined },
  )
  return { handle, owner, tree }
}

for (const input of [20, 30]) {
  test(`immediately aborted standard fallback retains both physical charges (${input}), live and reopened`, async () => {
    const abort = new AbortController()
    const steps: MockStep[] = [
      {
        error: { message: "Fast capacity exhausted", status: 429 },
        usage: { input: 20, output: 0, speed: "fast" },
      },
      () => {
        abort.abort()
        return { usage: { input, output: 0, speed: "standard" } }
      },
    ]
    const mock = createMockDialect(steps)
    const ai = createAi({
      dialects: [{ ...mock, id: "anthropic-messages" }],
      providers: [
        {
          id: "mock",
          dialect: "anthropic-messages",
          baseUrl: "",
          defaultModel: {
            fast: { kind: "anthropic-speed" },
            cost: { input: 10_000, output: 0, fast: { input: 10_000, output: 0 } },
          },
        },
      ],
      retry: { retries: 0 },
    })
    const { handle, owner, tree } = await conversation(ai)
    await handle.send("go", { signal: abort.signal })
    expect(mock.requests).toHaveLength(2)
    expect(tree.usage.cost).toBeCloseTo((20 + input) / 100)
    const live = handle.usage().own
    expect(live.knownCostUsd).toBeCloseTo((20 + input) / 100)
    expect(live.usage.input).toBe(20 + input)
    expect(live.complete).toBe(true)
    await handle.release()
    const saved = (await owner.read({ id: handle.id }))!.usage.own
    expect(saved.knownCostUsd).toBeCloseTo((20 + input) / 100)
    expect(saved.usage.input).toBe(20 + input)
    expect(saved.complete).toBe(true)
  })
}

for (const abortAt of ["retry", "fast.fallback"] as const) {
  test(`${abortAt} synthetic abort retains one physical charge, live and reopened`, async () => {
    const abort = new AbortController()
    const mock = createMockDialect([
      {
        error: { message: "Fast capacity exhausted", status: 429, retryable: true },
        usage: { input: 20, output: 0, cost: 0.2, speed: "fast" },
      },
      { text: "must not dispatch" },
    ])
    const base = createAi({
      dialects: [{ ...mock, id: "anthropic-messages" }],
      providers: [
        {
          id: "mock",
          dialect: "anthropic-messages",
          baseUrl: "",
          defaultModel: {
            fast: abortAt === "fast.fallback" ? { kind: "anthropic-speed" } : false,
            cost: { input: 10_000, output: 0, fast: { input: 10_000, output: 0 } },
          },
        },
      ],
      retry: { retries: 1, baseDelayMs: 60_000, maxDelayMs: 60_000 },
    })
    const ai: Ai = {
      ...base,
      async *stream(request, signal) {
        for await (const event of base.stream(request, signal)) {
          yield event
          if (event.type === abortAt) abort.abort()
        }
      },
    }
    const { handle, owner, tree } = await conversation(ai)
    await handle.send("go", { signal: abort.signal })
    expect(mock.requests).toHaveLength(1)
    expect(tree.usage.cost).toBeCloseTo(0.2)
    expect(handle.usage().own.knownCostUsd).toBeCloseTo(0.2)
    expect(handle.usage().own.complete).toBe(true)
    await handle.release()
    const saved = (await owner.read({ id: handle.id }))!.usage.own
    expect(saved.knownCostUsd).toBeCloseTo(0.2)
    expect(saved.complete).toBe(true)
  })
}

test("inert explicit fast fallback boundary retains an immediately aborted charge, live and reopened", async () => {
  const abort = new AbortController()
  const base = createAi({ providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const message = (input: number): AssistantMessage => ({
    role: "assistant",
    model: { provider: "mock", model: "owned" },
    content: [],
    usage: { ...emptyUsage(), input, cost: input / 100 },
  })
  const ai: Ai = {
    ...base,
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: "request.end", message: message(20) }
      yield { type: "fast.fallback" }
      yield { type: "request.start" }
      abort.abort()
      yield {
        type: "error",
        error: { message: "aborted", code: "aborted" },
        retryable: false,
        message: { ...message(30), stopReason: "aborted" },
      }
    },
  }
  const { handle, owner, tree } = await conversation(ai)
  await handle.send("go", { signal: abort.signal })
  expect(tree.usage.cost).toBeCloseTo(0.5)
  expect(handle.usage().own.knownCostUsd).toBeCloseTo(0.5)
  expect(handle.usage().own.complete).toBe(true)
  await handle.release()
  const saved = (await owner.read({ id: handle.id }))!.usage.own
  expect(saved.knownCostUsd).toBeCloseTo(0.5)
  expect(saved.complete).toBe(true)
})

for (const aborted of [false, true]) {
  test(`inert iterator throwing after request.end retains both charges (${aborted ? "aborted" : "error"}), live and reopened`, async () => {
    const abort = new AbortController()
    const base = createAi({ providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
    const message = (input: number): AssistantMessage => ({
      role: "assistant",
      model: { provider: "mock", model: "owned" },
      content: [],
      usage: { ...emptyUsage(), input, cost: input / 100 },
    })
    const ai: Ai = {
      ...base,
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "request.end", message: message(20) }
        yield { type: "retry", attempt: 1, maxRetries: 1, delayMs: 0, error: { message: "retry" } }
        yield { type: "request.start" }
        yield { type: "request.end", message: message(30) }
        if (aborted) abort.abort()
        throw new Error("adapter failure")
      },
    }
    const { handle, owner, tree } = await conversation(ai)
    const send = handle.send("go", { signal: abort.signal })
    if (aborted) await send
    else await expect(send).rejects.toThrow("adapter failure")
    expect(tree.usage.cost).toBeCloseTo(0.5)
    expect(handle.usage().own.knownCostUsd).toBeCloseTo(0.5)
    expect(handle.usage().own.usage.input).toBe(50)
    expect(handle.usage().own.complete).toBe(false)
    await handle.release()
    const saved = (await owner.read({ id: handle.id }))!.usage.own
    expect(saved.knownCostUsd).toBeCloseTo(0.5)
    expect(saved.usage.input).toBe(50)
    expect(saved.complete).toBe(false)
  })
}
