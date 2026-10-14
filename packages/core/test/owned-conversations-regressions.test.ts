import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep, userMessage } from "@amira/ai"
import { type Budget, type ConversationSpec, defineTool, type PendingNotice, textResult } from "@amira/api"
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
  maxConcurrent = 1,
  budget?: Budget,
  onStream?: (signal: AbortSignal) => void,
  maxParallelTools?: number,
) {
  const home = mkdtempSync(path.join(tmpdir(), "amira-owned-regression-"))
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [
      {
        ...mock,
        async *stream(request, context) {
          onStream?.(context.signal)
          yield* mock.stream(request, context)
        },
      },
    ],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, maxConcurrent, maxParallelTools, budget, sections: () => [] })
  const main = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: home,
    tools,
    tree,
    maxParallelTools,
    sections: [],
  })
  const managers: OwnedConversationManager[] = []
  const manager = () => {
    const value = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
    managers.push(value)
    return value
  }
  cleanups.push(async () => {
    await Promise.all(managers.map((value) => value.drain()))
    await main.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const spec: ConversationSpec = {
    key: "design",
    name: "Design",
    cwd: home,
    systemPrompt: "Research.",
    callableTools: [],
  }
  const runtime = { askUser: async () => undefined }
  return { home, mock, tree, main, tools, manager, spec, runtime }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("fixture did not reach its gate")
    await Bun.sleep(2)
  }
}

test("an unchanged spec with the default model reuses its key before and after restart", async () => {
  const f = fixture()
  const first = f.manager().forOwner("notes")
  const handle = await first.openOrCreate(f.spec, f.runtime)
  expect(await first.openOrCreate(f.spec, f.runtime)).toBe(handle)
  await handle.release()
  const reopened = await f.manager().forOwner("notes").openOrCreate(f.spec, f.runtime)
  expect(reopened.id).toBe(handle.id)
  expect(f.mock.requests).toHaveLength(0)
})

test("a creation interrupted before spec publication recovers its durable owner/key record", async () => {
  const f = fixture()
  const handle = await f.manager().forOwner("notes").openOrCreate(f.spec, f.runtime)
  await handle.release()
  // Equivalent on-disk state to a crash after session materialization but before spec publication.
  const namespace = path.join(f.home, "owned-conversations")
  const ownerDirectory = path.join(namespace, readdirSync(namespace)[0]!)
  rmSync(path.join(ownerDirectory, `${handle.id}.spec.json`))
  const recovered = await f.manager().forOwner("notes").openOrCreate(f.spec, f.runtime)
  expect(recovered.id).toBe(handle.id)
  expect(recovered.history()).toEqual([])
  expect(f.mock.requests).toHaveLength(0)
})

test("owned root sends queue behind shared host admission and can cancel without aborting the occupant", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture([
    { text: "main child", hold: { chunks: 0, until: gate }, usage: { input: 3 } },
    { text: "owned turn", usage: { input: 2 } },
  ])
  const mainChild = f.tree.spawn(f.main, { prompt: "main child" })
  await until(() => f.mock.requests.length === 1)
  const handle = await f.manager().forOwner("notes").openOrCreate(f.spec, f.runtime)
  const abort = new AbortController()
  const cancelled = handle.send("cancelled queued turn", { signal: abort.signal })
  await Bun.sleep(10)
  expect(f.mock.requests).toHaveLength(1)
  expect(handle.status().busy).toBe(true)
  abort.abort(new Error("cancel queued owned turn"))
  await expect(cancelled).rejects.toThrow("cancel queued owned turn")
  try {
    expect(handle.status()).toEqual({ state: "stopped", busy: false })
  } catch (error) {
    release()
    throw error
  }
  expect(mainChild.state).toBe("working")
  const sending = handle.send("admitted later")
  await Bun.sleep(10)
  expect(f.mock.requests).toHaveLength(1)
  release()
  expect((await mainChild.result()).status).toBe("done")
  await sending
  expect(f.mock.requests).toHaveLength(2)
  expect(f.tree.usage.input).toBe(5)
})

test("shared budget exhaustion stops other scopes and forbids another owned root turn", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture(
    [
      { text: "other scope", hold: { chunks: 0, until: gate } },
      { text: "expensive owned reply", usage: { input: 11 } },
    ],
    2,
    { tokens: 10 },
    (signal) => {
      // MockReply.hold deliberately ignores abort; release only when host cancellation arrives.
      signal.addEventListener("abort", release, { once: true })
    },
  )
  const mainChild = f.tree.spawn(f.main, { prompt: "main child" })
  await until(() => f.mock.requests.length === 1)
  const handle = await f.manager().forOwner("notes").openOrCreate(f.spec, f.runtime)
  await handle.send("spend the budget")
  await until(() => mainChild.state === "ended")
  expect((await mainChild.result()).status).toBe("aborted")
  expect(f.tree.usage.input).toBe(11)
  await expect(handle.send("must not start")).rejects.toThrow("budget")
  expect(handle.status()).toEqual({ state: "error", busy: false })
  expect(f.mock.requests).toHaveLength(2)
})

test("a failure after materialization rolls back the spec and lease before retry", async () => {
  const f = fixture()
  const owner = f.manager().forOwner("notes")
  const descriptor = Object.getOwnPropertyDescriptor(f.main, "providerSettings")!
  Object.defineProperty(f.main, "providerSettings", {
    configurable: true,
    get: () => {
      throw new Error("partial construction")
    },
  })
  try {
    await expect(owner.openOrCreate(f.spec, f.runtime)).rejects.toThrow("partial construction")
  } finally {
    Object.defineProperty(f.main, "providerSettings", descriptor)
  }
  const handle = await owner.openOrCreate(f.spec, f.runtime)
  expect(handle.history()).toEqual([])
  expect(f.mock.requests).toHaveLength(0)
  const group = handle.createGroup({ name: "Retained group" })
  await handle.release()
  expect(() => group.spawn({ prompt: "stale authority" })).toThrow("released")
  expect(f.mock.requests).toHaveLength(0)
})

function registerAsk(f: ReturnType<typeof fixture>) {
  const questions = [{ question: "Choose?", options: [{ label: "A", description: "First" }, { label: "B" }] }]
  f.tools.register(
    defineTool({
      name: "ask_user",
      description: "Ask the human",
      parameters: { type: "object" },
      execute: async (_args, context) => {
        if (!context.session?.askUser) throw new Error("missing asker")
        const outcome = await context.session.askUser(questions, context.signal)
        return { ...textResult("Question outcome"), details: { questions, outcome }, persistDetails: true }
      },
    }),
    "fixture",
  )
  return questions
}

test("the owner answers ask_user and its complete evidence persists across reopen", async () => {
  const f = fixture([
    { toolCalls: [{ name: "ask_user", id: "decision", args: {} }] },
    { text: "A confirmed" },
  ])
  const questions = registerAsk(f)
  const seen: string[] = []
  const runtime = {
    askUser: async (received: typeof questions, context: { sessionId: string; signal: AbortSignal }) => {
      expect(received).toEqual(questions)
      expect(context.signal.aborted).toBe(false)
      seen.push(context.sessionId)
      return [{ selected: ["A"] }]
    },
  }
  const owner = f.manager().forOwner("notes")
  const handle = await owner.openOrCreate({ ...f.spec, callableTools: ["ask_user"] }, runtime)
  await handle.send("Ask me")
  expect(seen).toEqual([handle.id])
  await handle.release()
  const reopened = await f.manager().forOwner("notes").open(handle.id, runtime)
  const result = reopened.history().find((message) => message.role === "toolResult")
  expect(result?.role === "toolResult" ? result.details : undefined).toEqual({
    questions,
    outcome: { answers: [{ selected: ["A"] }] },
  })
  expect(f.mock.requests).toHaveLength(2)
  expect(f.main.messages).toEqual([])
})

test("owner unload cancels a pending human callback even when the UI never settles", async () => {
  const f = fixture([{ toolCalls: [{ name: "ask_user", args: {} }] }])
  registerAsk(f)
  const lifetime = new AbortController()
  let requested = false
  let questionSignal: AbortSignal | undefined
  const manager = f.manager()
  const handle = await manager.forOwner("notes", lifetime.signal).openOrCreate(
    { ...f.spec, callableTools: ["ask_user"] },
    {
      askUser: async (_questions, { signal }) => {
        requested = true
        questionSignal = signal
        return new Promise(() => {})
      },
    },
  )
  const sending = handle.send("Ask me")
  await until(() => requested)
  lifetime.abort()
  await manager.releaseOwner("notes")
  await sending
  expect(questionSignal?.aborted).toBe(true)
  expect(f.mock.requests).toHaveLength(1)
  expect(f.main.status).toBe("idle")
  await expect(handle.send("stale")).rejects.toThrow("released")
})

test("background notices during the final reply or after stop never start another turn", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture([
    { toolCalls: [{ name: "prepare_notice", args: {} }] },
    { text: "finished", hold: { chunks: 0, until: gate } },
    { text: "explicit continuation" },
  ])
  const notices: PendingNotice[] = []
  const tool = defineTool({
    name: "prepare_notice",
    description: "Prepare background receipts",
    parameters: { type: "object" },
    execute: async (_args, context) => {
      if (!context.session?.expectNotice) throw new Error("missing receipt capability")
      notices.push(context.session.expectNotice(), context.session.expectNotice())
      return textResult("prepared")
    },
  })
  const handle = await f
    .manager()
    .forOwner("notes")
    .openOrCreate({ ...f.spec, callableTools: [tool.name] }, { ...f.runtime, extraTools: [tool] })
  const sending = handle.send("prepare")
  await until(() => f.mock.requests.length === 2)
  notices[0]!.deliver(userMessage("during final reply"))
  release()
  await sending
  await handle.stop()
  notices[1]!.deliver(userMessage("after stop"))
  await Bun.sleep(10)
  expect(f.mock.requests).toHaveLength(2)
  expect(handle.status()).toEqual({ state: "stopped", busy: false })
  await handle.send("continue explicitly")
  expect(f.mock.requests).toHaveLength(3)
  expect(JSON.stringify(f.mock.requests[2]!.messages)).toContain("during final reply")
  expect(JSON.stringify(f.mock.requests[2]!.messages)).toContain("after stop")
})

test("owned roots preserve the configured parallel-tool cap", async () => {
  const f = fixture(
    [
      {
        toolCalls: [
          { name: "read_one", args: {} },
          { name: "read_two", args: {} },
        ],
      },
      { text: "done" },
    ],
    1,
    undefined,
    undefined,
    1,
  )
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered: string[] = []
  for (const name of ["read_one", "read_two"])
    f.tools.register(
      defineTool({
        name,
        description: name,
        parameters: { type: "object" },
        concurrency: "parallel",
        traits: { readOnly: true },
        execute: async () => {
          entered.push(name)
          if (name === "read_one") await gate
          return textResult("read")
        },
      }),
      "fixture",
    )
  const handle = await f
    .manager()
    .forOwner("notes")
    .openOrCreate({ ...f.spec, callableTools: ["read_one", "read_two"] }, f.runtime)
  const sending = handle.send("read both")
  try {
    await until(() => entered.length >= 1)
    await Bun.sleep(10)
    expect(entered).toEqual(["read_one"])
  } finally {
    release()
  }
  await sending
  expect(entered).toEqual(["read_one", "read_two"])
})

test("host tool masks still block runtime-private tools even when the model emits an unoffered call", async () => {
  const f = fixture([{ toolCalls: [{ name: "read", args: {} }] }, { text: "refused" }])
  let calls = 0
  const read = defineTool({
    name: "read",
    description: "Owner read",
    parameters: { type: "object" },
    traits: { readOnly: true },
    execute: async () => {
      calls++
      return textResult("private read")
    },
  })
  const handle = await f
    .manager()
    .forOwner("notes")
    .openOrCreate({ ...f.spec, callableTools: ["read"] }, { ...f.runtime, extraTools: [read] })
  f.tools.setDisabled(["read"])
  await handle.send("try read")
  expect(calls).toBe(0)
  expect(f.mock.requests[0]!.tools).toEqual([])
  const result = handle.history().find((message) => message.role === "toolResult")
  expect(result?.role === "toolResult" ? result.isError : false).toBe(true)
})

test("a new owner instance gets an in-use error while the old instance is still draining", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture([{ text: "interrupted", hold: { chunks: 0, until: gate } }])
  const manager = f.manager()
  const handle = await manager.forOwner("notes").openOrCreate(f.spec, f.runtime)
  const sending = handle.send("held turn")
  await until(() => f.mock.requests.length === 1)
  const draining = manager.releaseOwner("notes")
  const nextOwner = manager.forOwner("notes")
  try {
    await expect(nextOwner.openOrCreate(f.spec, f.runtime)).rejects.toThrow("in use")
  } finally {
    release()
    await sending
    await draining
  }
  const reopened = await nextOwner.openOrCreate(f.spec, f.runtime)
  expect(reopened.id).toBe(handle.id)
  expect(reopened.status().busy).toBe(false)
})

test("owner unload cancels and drains an open-time lease acquisition before constructing a handle", async () => {
  const f = fixture()
  const manager = f.manager()
  const lifetime = new AbortController()
  const owner = manager.forOwner("notes", lifetime.signal)
  const opening = owner.openOrCreate(f.spec, f.runtime)
  // Attach a rejection handler without letting the assertion runner settle acquisition first.
  const outcome = opening.then(
    () => undefined,
    (error: unknown) => error,
  )
  lifetime.abort()
  await manager.releaseOwner("notes")
  const error = await outcome
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain("released")
  const fresh = await manager.forOwner("notes").openOrCreate(f.spec, f.runtime)
  expect(fresh.status()).toEqual({ state: "idle", busy: false })
  expect(f.mock.requests).toHaveLength(0)
})
