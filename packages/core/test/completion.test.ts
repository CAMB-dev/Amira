import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  addUsage,
  createAi,
  createMockDialect,
  type Dialect,
  emptyUsage,
  type ModelRequest,
  type StreamEvent,
} from "@amira/ai"
import type { Budget, ExtensionAPI, SessionControl } from "@amira/api"
import { unfinishedAccounting } from "../src/accounting-requests.ts"
import { Agent } from "../src/agent.ts"
import { completeForAgent } from "../src/completion.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { conversationUsage } from "../src/owned-conversations-usage.ts"
import { SessionStore } from "../src/session-store.ts"
import { storedSessionUsage } from "../src/session-usage.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(dialect: Dialect, retry = 0, budget?: Budget) {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-completion-"))
  const previous = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = path.join(dir, "home")
  const ai = createAi({
    dialects: [dialect],
    providers: [
      { id: "mock", dialect: dialect.id, baseUrl: "", defaultModel: { caps: { webSearch: true } } },
    ],
    retry: { retries: retry, baseDelayMs: 0 },
  })
  const tree = new AgentTree({ ai, maxConcurrent: 1, sections: () => [], budget })
  const store = SessionStore.create({ cwd: dir, dir })
  const agent = new Agent({
    ai,
    model: ai.model("mock/main"),
    cwd: dir,
    session: store,
    tree,
    sections: [],
    messages: [{ role: "user", content: [{ type: "text", text: "never inject this history" }] }],
  })
  const host = new ExtensionHost({
    ai,
    bus: new EventBus(),
    tools: new ToolRegistry(),
    interceptors: new InterceptorRegistry(),
    cwd: dir,
  })
  // Completion only uses the captured agent, not the session-control surface.
  host.setSessionControl({} as SessionControl, () => agent)
  let api!: ExtensionAPI
  await host.load((value) => {
    api = value
  }, "ext:completion-test")
  cleanups.push(async () => {
    host.unloadAll()
    tree.abortAll("test cleanup")
    await agent.dispose()
    store.release()
    if (previous === undefined) delete process.env.AMIRA_HOME
    else process.env.AMIRA_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { ai, tree, agent, store, api, host, dir }
}

const request = {
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "side only" }] }],
}

function receipt(request: ModelRequest, cost: number) {
  return {
    role: "assistant" as const,
    model: { provider: request.model.provider, model: request.model.id },
    content: [{ type: "text" as const, text: "done" }],
    usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost },
    stopReason: "end" as const,
  }
}

test("unbound completion charges every reported retry attempt without changing history", async () => {
  const mock = createMockDialect([
    { error: { message: "retry", retryable: true }, usage: { cost: 0.2 } },
    { text: "done", usage: { cost: 0.3 } },
  ])
  const { api, tree, agent, store } = await setup(mock, 1)
  const before = structuredClone(agent.messages)
  const result = await api.complete({ ...request, label: "spec generation" })
  expect(result.text).toBe("done")
  expect(result.usage?.cost).toBe(0.3)
  expect(tree.usage.cost).toBeCloseTo(0.5)
  expect(
    store.entries.filter((entry) => entry.type === "side_usage").map((entry) => entry.usage.cost),
  ).toEqual([0.2, 0.3])
  expect(agent.messages).toEqual(before)
})

test("omitted terminal optional metadata retains known spending without certifying coverage", async () => {
  const dialect: Dialect = {
    id: "omitted-metadata",
    async *stream(request) {
      const message = receipt(request, 2)
      yield {
        type: "request.end",
        message: { ...message, usage: { ...message.usage, webSearchRequests: 1, webSearchCost: 0.01 } },
      }
      yield { type: "done", message: { ...message, usage: { ...emptyUsage(), input: 10, output: 1 } } }
    },
  }
  const { api, agent, tree, store } = await setup(dialect)
  await api.complete(request)
  expect(tree.usage).toMatchObject({ input: 10, cost: 2, webSearchRequests: 1, webSearchCost: 0.01 })
  for (const source of [agent, store, SessionStore.open(store.file)]) {
    expect(conversationUsage(source).own).toMatchObject({ knownCostUsd: 2, complete: false })
  }
})

test("unbound completion charges a late terminal receipt before rejecting an abort", async () => {
  const abort = new AbortController()
  const dialect: Dialect = {
    id: "late",
    async *stream(request) {
      abort.abort()
      yield { type: "done", message: receipt(request, 0.4) }
    },
  }
  const { api, tree, store } = await setup(dialect)
  await expect(api.complete({ ...request, signal: abort.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(tree.usage.cost).toBe(0.4)
  expect(store.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(1)
})

test("the explicit target and model own text-only completion and durable label provenance", async () => {
  const mock = createMockDialect([{ text: "not JSON", usage: { cost: 0.2 } }])
  const { ai, agent, store } = await setup(mock)
  const model = ai.model("mock/owned")
  const before = structuredClone(agent.messages)
  const result = await completeForAgent({
    ai,
    agent,
    model: { ...model, caps: { ...model.caps, thinking: true }, maxOutput: 1000 },
    request: { ...request, system: "explicit system", maxTokens: 1, label: "  prototype\n variants  " },
    label: "owner",
  })
  expect(result.text).toBe("not JSON")
  expect(mock.requests).toHaveLength(1)
  expect(mock.requests[0]).toMatchObject({
    model: { id: "owned", caps: { webSearch: false } },
    messages: request.messages,
    systemPrompt: "explicit system",
    tools: [],
    maxTokens: 1000,
  })
  expect(mock.requests[0]?.messages).toHaveLength(1)
  expect(agent.model.id).toBe("main")
  expect(agent.messages).toEqual(before)
  expect(store.entries.filter((entry) => entry.type === "side_usage")).toMatchObject([
    { model: { provider: "mock", model: "owned" }, usage: { cost: 0.2 }, label: "prototype variants" },
  ])
  expect(storedSessionUsage(SessionStore.open(store.file))).toMatchObject({
    knownCostUsd: 0.2,
    complete: true,
  })
})

for (const retry of [false, true]) {
  test(`iterator failure ${retry ? "after retry" : "after request.end"} preserves side usage with unknown coverage`, async () => {
    const { ai, api, tree, store } = await setup(createMockDialect())
    ai.stream = async function* (request) {
      yield { type: "request.end", message: receipt(request, 0.2) }
      if (retry) yield { type: "retry", attempt: 1, maxRetries: 1, delayMs: 0, error: { message: "retry" } }
      throw new Error("adapter failure")
    }
    await expect(api.complete(request)).rejects.toThrow("adapter failure")
    expect(tree.usage.cost).toBeCloseTo(0.2)
    expect(storedSessionUsage(store)).toMatchObject({ knownCostUsd: 0.2, complete: false })
    expect(storedSessionUsage(SessionStore.open(store.file))).toMatchObject({
      knownCostUsd: 0.2,
      complete: false,
    })
  })
}

for (const terminal of ["done", "error"] as const) {
  test(`side completion drains reported cleanup corrections after ${terminal} before surfacing iterator failure`, async () => {
    const { ai, api, tree, store } = await setup(createMockDialect())
    ai.stream = async function* (request) {
      try {
        const message = receipt(request, 0.2)
        yield terminal === "done"
          ? { type: "done", message }
          : {
              type: "error",
              message,
              error: { message: "provider failure" },
              retryable: false,
            }
      } finally {
        yield { type: "request.end", message: receipt(request, 0.3) }
        // biome-ignore lint/correctness/noUnsafeFinally: exercise an adapter cleanup failure after a terminal event.
        throw new Error("cleanup failure")
      }
    }
    await expect(api.complete(request)).rejects.toThrow("cleanup failure")
    expect(tree.usage.cost).toBeCloseTo(0.3)
    expect(storedSessionUsage(SessionStore.open(store.file))).toMatchObject({
      knownCostUsd: 0.3,
      complete: false,
    })
  })
}

test("side-call receipt copies preserve the known subtotal of unpriced usage before an error", async () => {
  const { ai, api, store } = await setup(createMockDialect())
  ai.stream = async function* (request) {
    const message = {
      ...receipt(request, 0.2),
      usage: addUsage({ ...emptyUsage(), input: 10, cost: 0.2 }, { ...emptyUsage(), webSearchRequests: 1 }),
    }
    yield { type: "request.end", message }
    throw new Error("adapter failure")
  }
  await expect(api.complete(request)).rejects.toThrow("adapter failure")
  expect(storedSessionUsage(SessionStore.open(store.file))).toMatchObject({
    knownCostUsd: 0.2,
    complete: false,
  })
})

test("owned completion retains an observed retry charge when the following iterator throws", async () => {
  const { ai, agent, tree, dir } = await setup(createMockDialect())
  const manager = new OwnedConversationManager({
    ai,
    tree,
    tools: new ToolRegistry(),
    home: dir,
    agent: () => agent,
  })
  cleanups.push(() => manager.drain())
  const owner = manager.forOwner("project")
  const owned = await owner.openOrCreate(
    {
      key: "generate",
      name: "Generate",
      cwd: dir,
      model: "mock/owned",
      systemPrompt: "",
      callableTools: [],
    },
    { askUser: async () => undefined },
  )
  ai.stream = async function* (request) {
    yield { type: "request.end", message: receipt(request, 0.2) }
    yield { type: "retry", attempt: 1, maxRetries: 1, delayMs: 0, error: { message: "retry" } }
    throw new Error("owned adapter failure")
  }
  await expect(owned.complete(request)).rejects.toThrow("owned adapter failure")
  expect(owned.history()).toEqual([])
  expect(owned.usage().own).toMatchObject({ knownCostUsd: 0.2, complete: false })
  expect(tree.usage.cost).toBeCloseTo(0.2)
  await owned.release()
  expect((await owner.read({ key: owned.key }))?.usage.own).toMatchObject({
    knownCostUsd: 0.2,
    complete: false,
  })
})

test("a tree-less completion retains reported usage when its persisted receipt cannot be saved", async () => {
  const { ai, api, host, store, dir } = await setup(createMockDialect())
  const bare = new Agent({ ai, model: ai.model("mock/main"), cwd: dir, session: store, sections: [] })
  cleanups.push(() => bare.dispose())
  host.setSessionControl({} as SessionControl, () => bare)
  ai.stream = async function* (request) {
    writeFileSync(store.file, "damaged session header\n")
    yield { type: "done", message: receipt(request, 0.2) }
  }
  expect((await api.complete(request)).text).toBe("done")
  expect(conversationUsage(bare).own).toMatchObject({ knownCostUsd: 0.2, complete: false })
})

test("provider errors retain their reported charge before they throw", async () => {
  const mock = createMockDialect([{ error: { message: "provider failure" }, usage: { cost: 0.7 } }])
  const { api, tree, store } = await setup(mock)
  await expect(api.complete(request)).rejects.toThrow("provider failure")
  expect(tree.usage.cost).toBe(0.7)
  expect(storedSessionUsage(store)).toMatchObject({ knownCostUsd: 0.7, complete: true })
})

test("a repeated terminal receipt settles one attempt by delta, not twice", async () => {
  const dialect: Dialect = {
    id: "settlement",
    async *stream(request) {
      const message = receipt(request, 0.4)
      yield { type: "request.end", message }
      message.usage.cost = 0.3
      yield { type: "done", message }
    },
  }
  const { api, tree, store } = await setup(dialect)
  await api.complete(request)
  expect(tree.usage.cost).toBeCloseTo(0.3)
  expect(storedSessionUsage(SessionStore.open(store.file)).knownCostUsd).toBeCloseTo(0.3)
})

for (const correction of ["search", "tokens", "reported"] as const) {
  test(`completion persists a full ${correction} coverage revision rather than certifying its prior receipt`, async () => {
    const { ai, api, agent, store } = await setup(createMockDialect())
    ai.stream = async function* (request) {
      const message = receipt(request, 0.2)
      yield { type: "request.end", message }
      const usage =
        correction === "reported"
          ? { ...message.usage, outputReported: false }
          : addUsage(
              { ...message.usage, cost: 0.3 },
              { ...emptyUsage(), ...(correction === "search" ? { webSearchRequests: 1 } : { output: 2 }) },
            )
      yield { type: "done", message: { ...message, usage } }
    }
    await api.complete(request)
    const expected = correction === "reported" ? 0.2 : 0.3
    expect(storedSessionUsage(store)).toMatchObject({ knownCostUsd: expected, complete: false })
    expect(storedSessionUsage(SessionStore.open(store.file))).toMatchObject({
      knownCostUsd: expected,
      complete: false,
    })
    expect(conversationUsage(agent).own).toMatchObject({
      knownCostUsd: expected,
      complete: false,
    })
    expect(store.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(3)
  })
}

test("identical physical terminal revisions reuse their retained durable contribution", async () => {
  const { ai, api, store } = await setup(createMockDialect())
  ai.stream = async function* (request) {
    const message = receipt(request, 0.2)
    yield { type: "request.end", message }
    yield { type: "done", message: { ...message, usage: { ...message.usage } } }
  }
  await api.complete(request)
  expect(store.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(1)
  expect(unfinishedAccounting(store)).toHaveLength(0)
  expect(storedSessionUsage(SessionStore.open(store.file))).toMatchObject({
    knownCostUsd: 0.2,
    complete: true,
  })
})

test("an identical later observation cannot acknowledge a contribution whose append failed", async () => {
  const { ai, api, store } = await setup(createMockDialect())
  const append = store.append.bind(store)
  store.append = (entry) => {
    if (entry.type === "side_usage") throw new Error("simulated receipt write failure")
    return append(entry)
  }
  ai.stream = async function* (request) {
    const message = receipt(request, 0.2)
    yield { type: "request.end", message }
    yield { type: "done", message }
  }
  await api.complete(request)
  expect(unfinishedAccounting(store)).toHaveLength(1)
  expect(storedSessionUsage(SessionStore.open(store.file)).complete).toBe(false)
})

test("an abort during retry backoff does not charge the repeated attempt receipt twice", async () => {
  const { api, tree, ai, store } = await setup(createMockDialect())
  const abort = new AbortController()
  ai.stream = async function* (request): AsyncGenerator<StreamEvent> {
    const message = receipt(request, 0.2)
    yield { type: "request.end", message }
    yield { type: "retry", attempt: 1, maxRetries: 1, delayMs: 1000, error: { message: "retry" } }
    abort.abort()
    yield {
      type: "error",
      message: { ...message, stopReason: "aborted" },
      error: { code: "aborted", message: "aborted" },
      retryable: false,
    }
  }
  await expect(api.complete({ ...request, signal: abort.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(tree.usage.cost).toBe(0.2)
  expect(store.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(1)
})

test("an aborted attempt without usage is durably incomplete, never a fabricated free charge", async () => {
  const abort = new AbortController()
  const dialect: Dialect = {
    id: "unknown",
    async *stream(request) {
      abort.abort()
      const { usage: _usage, ...message } = receipt(request, 1)
      yield { type: "error", message, error: { code: "aborted", message: "aborted" }, retryable: false }
    },
  }
  const { api, tree, store } = await setup(dialect)
  await expect(api.complete({ ...request, signal: abort.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(tree.usage.pricingUnknown).toBe(true)
  const entries = store.entries.filter((entry) => entry.type === "side_usage")
  expect(entries).toHaveLength(1)
  expect(entries[0]?.usage.cost).toBeUndefined()
  expect(storedSessionUsage(SessionStore.open(store.file))).toMatchObject({
    complete: false,
    knownCostUsd: 0,
  })
})

test("pre-aborted and spent-tree calls make no provider request or accounting receipt", async () => {
  const mock = createMockDialect([{ text: "should not run" }])
  const { api, tree, agent, store } = await setup(mock, 0, { costUsd: 0.1 })
  const abort = new AbortController()
  abort.abort()
  await expect(api.complete({ ...request, signal: abort.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(mock.requests).toHaveLength(0)
  expect(store.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(0)
  tree.recordUsage(agent, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.2 })
  const before = store.entries.length
  await expect(api.complete(request)).rejects.toThrow("budget is spent")
  expect(store.entries).toHaveLength(before)
  expect(mock.requests).toHaveLength(0)
})

test("an inherited context interceptor can await unbound completion with one owned admission permit", async () => {
  const mock = createMockDialect([
    { text: "interceptor context", usage: { cost: 0.2 } },
    { text: "owned reply", usage: { cost: 0.3 } },
  ])
  const { ai, agent, api, tree, dir } = await setup(mock)
  const manager = new OwnedConversationManager({
    ai,
    tools: new ToolRegistry(),
    tree,
    home: dir,
    agent: () => agent,
  })
  cleanups.push(() => manager.drain())
  agent.interceptors.add(
    "context.build",
    async (value, { signal }) => {
      const result = await api.complete({ ...request, signal })
      return { action: "modify", value: { ...value, systemPrompt: result.text } }
    },
    { timeoutMs: 100 },
  )
  const owned = await manager
    .forOwner("project")
    .openOrCreate(
      { key: "design", name: "Design", cwd: dir, model: "mock/owned", systemPrompt: "", callableTools: [] },
      { askUser: async () => undefined },
    )
  await owned.send("owned prompt")
  expect(mock.requests).toHaveLength(2)
  expect(mock.requests[0]?.model.id).toBe("main")
  expect(mock.requests[1]).toMatchObject({ model: { id: "owned" }, systemPrompt: "interceptor context" })
  expect(owned.usage().own.knownCostUsd).toBe(0.3)
  expect(storedSessionUsage(agent.session!).knownCostUsd).toBe(0.2)
})

test("owned side requests share root admission, and a cancelled waiter never opens a stream", async () => {
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let requests = 0
  const dialect: Dialect = {
    id: "gated",
    async *stream(request) {
      requests++
      if (requests === 1) {
        entered.resolve()
        await finish.promise
      }
      yield { type: "done", message: receipt(request, 0.2) }
    },
  }
  const { ai, tree, agent, dir } = await setup(dialect)
  const ownedTree = new AgentTree({ ai, shared: tree })
  const store = SessionStore.create({ cwd: dir, dir })
  const owned = new Agent({
    ai,
    tree: ownedTree,
    model: ai.model("mock/owned"),
    cwd: dir,
    session: store,
    sections: [],
  })
  cleanups.push(async () => {
    finish.resolve()
    ownedTree.abortAll("test cleanup")
    await owned.dispose()
    ownedTree.releaseScope()
  })
  const main = tree.runRoot(agent, () => agent.prompt("main"), new AbortController().signal)
  await entered.promise
  const abort = new AbortController()
  const queued = completeForAgent({
    ai,
    agent: owned,
    model: owned.model,
    request,
    signal: abort.signal,
    label: "owned",
    admission: true,
  })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(requests).toBe(1)
  abort.abort()
  await expect(queued).rejects.toMatchObject({ name: "AbortError" })
  expect(store.entries.filter((entry) => entry.type === "side_usage")).toHaveLength(0)
  finish.resolve()
  await main
  await completeForAgent({ ai, agent: owned, model: owned.model, request, label: "owned", admission: true })
  expect(requests).toBe(2)
  expect(storedSessionUsage(store).knownCostUsd).toBe(0.2)
})

test.each(["signal", "unload"])(
  "%s cancellation of a side request leaves the active main turn alone",
  async (kind) => {
    const mainEntered = Promise.withResolvers<void>()
    const sideEntered = Promise.withResolvers<void>()
    const finishMain = Promise.withResolvers<void>()
    const dialect: Dialect = {
      id: "independent",
      async *stream(request, context) {
        const last = request.messages.at(-1)?.content[0]
        if (last?.type === "text" && last.text === "main question") {
          mainEntered.resolve()
          await finishMain.promise
          yield { type: "done", message: receipt(request, 0.5) }
          return
        }
        sideEntered.resolve()
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve()
          else context.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        yield { type: "done", message: receipt(request, 0.2) }
      },
    }
    const { api, agent, host, tree } = await setup(dialect)
    cleanups.push(async () => {
      finishMain.resolve()
    })
    const main = agent.prompt("main question")
    await mainEntered.promise
    const onTools = agent.execution.onTools
    const abort = new AbortController()
    const side = api.complete({ ...request, signal: abort.signal })
    await sideEntered.promise
    expect(agent.execution.onTools).toBe(onTools)
    if (kind === "unload") host.unloadAll()
    else abort.abort()
    await expect(side).rejects.toMatchObject({ name: "AbortError" })
    finishMain.resolve()
    expect((await main).reason).toBe("done")
    expect(tree.usage.cost).toBeCloseTo(0.7)
  },
)

test("a successful receipt exhausting the budget still returns, but admits no next request", async () => {
  const mock = createMockDialect([{ text: "done", usage: { cost: 0.2 } }])
  const { api, tree } = await setup(mock, 0, { costUsd: 0.1 })
  expect((await api.complete(request)).text).toBe("done")
  expect(tree.usage.cost).toBe(0.2)
  await expect(api.complete(request)).rejects.toThrow("budget is spent")
  expect(mock.requests).toHaveLength(1)
})
