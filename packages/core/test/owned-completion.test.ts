import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep, userMessage } from "@amira/ai"
import type { Budget, ConversationSpec } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture(
  steps: MockStep[] = [],
  options: { retries?: number; maxConcurrent?: number; budget?: Budget; canExecute?: () => boolean } = {},
) {
  const home = mkdtempSync(path.join(tmpdir(), "amira-owned-complete-"))
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: options.retries ?? 0, baseDelayMs: 1, maxDelayMs: 1 },
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({
    ai,
    sections: () => [],
    maxConcurrent: options.maxConcurrent,
    budget: options.budget,
  })
  const main = new Agent({ ai, model: ai.model("mock/main"), cwd: home, tools, tree, sections: [] })
  const manager = new OwnedConversationManager({
    ai,
    tools,
    tree,
    home,
    agent: () => main,
    canExecute: options.canExecute,
  })
  cleanups.push(async () => {
    await manager.drain()
    await main.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const spec: ConversationSpec = {
    key: "project/spec",
    name: "Spec",
    cwd: home,
    model: "mock/owned",
    systemPrompt: "This history must not be injected.",
    callableTools: [],
  }
  const owner = manager.forOwner("project")
  const open = () => owner.openOrCreate(spec, { askUser: async () => undefined })
  return { home, mock, main, manager, tree, spec, owner, open }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("completion fixture did not reach its gate")
    await Bun.sleep(2)
  }
}

test("owned completion is fixed-model text-only work with unchanged history and durable provenance", async () => {
  const f = fixture([
    { text: "conversation reply", usage: { cost: 0.1 } },
    { text: "not valid JSON", usage: { input: 20, output: 4, cost: 0.2 } },
  ])
  const handle = await f.open()
  await handle.send("old history")
  const before = handle.history()
  const request = {
    messages: [userMessage("generate spec")],
    system: "Only this system prompt.",
    label: "project.spec",
    model: "mock/foreign",
  }
  // A runtime caller cannot smuggle a different model through the structural omission.
  const result = await handle.complete(request)
  expect(result.text).toBe("not valid JSON")
  expect(() => JSON.parse(result.text)).toThrow()
  expect(handle.history()).toEqual(before)
  expect(f.main.messages).toEqual([])
  expect(f.mock.requests[1]).toMatchObject({
    model: { id: "owned", caps: { webSearch: false } },
    systemPrompt: request.system,
    messages: request.messages,
    tools: [],
  })
  expect(handle.usage().own.knownCostUsd).toBeCloseTo(0.3)
  const live = handle.usage()
  await handle.release()
  expect((await f.owner.read({ key: handle.key }))?.usage).toEqual(live)
  const reopened = await f.open()
  expect(reopened.history()).toEqual(before)
  expect(reopened.usage()).toEqual(live)
})

test("retry and terminal errors retain every reported owned charge", async () => {
  const f = fixture(
    [
      { error: { message: "retry", retryable: true }, usage: { input: 5, cost: 0.1 } },
      { text: "ok", usage: { input: 10, cost: 0.2 } },
      { error: { message: "bad request" }, usage: { input: 3, cost: 0.05 } },
    ],
    { retries: 1 },
  )
  const handle = await f.open()
  expect((await handle.complete({ messages: [] })).text).toBe("ok")
  await expect(handle.complete({ messages: [] })).rejects.toThrow("bad request")
  expect(handle.usage().own.knownCostUsd).toBeCloseTo(0.35)
  expect(handle.usage().own.usage.input).toBe(18)
  expect(handle.history()).toEqual([])
  expect(f.mock.requests).toHaveLength(3)
})

for (const end of ["stop", "release", "unload"] as const) {
  test(`${end} cancels and physically drains completion, retaining reported late-abort usage`, async () => {
    let unblock!: () => void
    const gate = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const f = fixture([
      { text: "streaming response", hold: { chunks: 1, until: gate }, usage: { input: 9, cost: 0.4 } },
    ])
    const handle = await f.open()
    const operation = handle.complete({ messages: [userMessage("generate")] }).catch((error) => error)
    await until(() => f.mock.requests.length === 1)
    expect(handle.status().busy).toBe(true)
    for (const overlap of [
      () => handle.send("overlap"),
      () => handle.runTool("read", {}),
      () => handle.complete({ messages: [] }),
    ])
      await expect(overlap()).rejects.toThrow("busy")
    let drained = false
    const stopping = (
      end === "unload"
        ? f.manager.releaseOwner("project")
        : end === "release"
          ? handle.release()
          : handle.stop()
    ).then(() => {
      drained = true
    })
    await Bun.sleep(10)
    expect(drained).toBe(false)
    unblock()
    expect((await operation).name).toBe("AbortError")
    await stopping
    const snapshot =
      end === "stop" ? handle.usage() : (await f.manager.forOwner("project").read({ id: handle.id }))?.usage
    expect(snapshot?.own.knownCostUsd).toBe(0.4)
    expect(f.mock.requests).toHaveLength(1)
    expect(f.main.messages).toEqual([])
  })
}

test("initialization, pre-abort and exhausted shared budget reject before provider dispatch", async () => {
  let ready = false
  const f = fixture([], { canExecute: () => ready, budget: { costUsd: 0.5 } })
  const handle = await f.open()
  await expect(handle.complete({ messages: [] })).rejects.toThrow("initialization")
  ready = true
  const abort = new AbortController()
  abort.abort()
  await expect(handle.complete({ messages: [], signal: abort.signal })).rejects.toThrow()
  f.tree.recordUsage(f.main, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1 })
  await expect(handle.complete({ messages: [] })).rejects.toThrow("budget")
  expect(f.mock.requests).toHaveLength(0)
})

test("queued completion obeys shared admission and cancellation leaves other roots untouched", async () => {
  let unblock!: () => void
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const f = fixture([{ text: "main holds the slot", hold: { chunks: 1, until: gate } }], { maxConcurrent: 1 })
  const handle = await f.open()
  const mainTurn = f.tree.runRoot(f.main, () => f.main.prompt("main"), new AbortController().signal)
  await until(() => f.mock.requests.length === 1)
  const request = handle.complete({ messages: [] }).catch((error) => error)
  await Bun.sleep(10)
  expect(f.mock.requests).toHaveLength(1)
  await handle.stop()
  expect((await request).name).toBe("AbortError")
  expect(f.main.busy).toBe(true)
  unblock()
  await mainTurn
  expect(f.mock.requests).toHaveLength(1)
})

test("two owned callers and main are attributed independently under concurrent completion", async () => {
  const f = fixture([
    (request) => ({ text: request.model.id, usage: { cost: request.model.id === "owned" ? 0.2 : 0.3 } }),
    (request) => ({ text: request.model.id, usage: { cost: request.model.id === "owned" ? 0.2 : 0.3 } }),
    { text: "main", usage: { cost: 0.7 } },
  ])
  const first = await f.open()
  const second = await f.owner.openOrCreate(
    { ...f.spec, key: "project/prototype", model: "mock/variant" },
    { askUser: async () => undefined },
  )
  await Promise.all([
    first.complete({ messages: [] }),
    second.complete({ messages: [] }),
    f.main.prompt("unrelated"),
  ])
  expect(first.usage().total.knownCostUsd).toBe(0.2)
  expect(second.usage().total.knownCostUsd).toBe(0.3)
  expect(f.tree.usage.cost).toBeCloseTo(1.2)
})
