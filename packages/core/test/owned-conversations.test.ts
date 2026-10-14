import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { type ConversationRuntime, type ConversationSpec, defineTool, textResult } from "@amira/api"
import { Agent, type AgentOptions } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { listSessions } from "../src/session-list.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"
import { readTrace } from "../src/trace-reader.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup(steps: MockStep[] = [], options: Pick<AgentOptions, "compaction" | "callableTools"> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "amira-owned-"))
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  const tree = new AgentTree({ ai, sections: () => [] })
  let main = new Agent({ ai, model: ai.model("mock/test"), cwd: home, tools, tree, sections: [], ...options })
  const manager = () => {
    const result = new OwnedConversationManager({ ai, tools, tree, home, agent: () => main })
    cleanups.push(() => result.drain())
    return result
  }
  cleanups.push(async () => {
    await main.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const spec: ConversationSpec = {
    key: "project/design",
    name: "Design",
    cwd: home,
    model: "mock/test",
    systemPrompt: "Research only.",
    callableTools: [],
  }
  const runtime: ConversationRuntime = { askUser: async () => undefined }
  return {
    home,
    mock,
    ai,
    tools,
    tree,
    manager,
    spec,
    runtime,
    main: () => main,
    switchMain: (agent: Agent) => {
      main = agent
    },
  }
}

test("owner/key creation is durable and reopen is inert outside root enumeration", async () => {
  const f = setup([{ text: "saved answer" }])
  const manager = f.manager()
  const owner = manager.forOwner("project-extension")
  const handle = await owner.openOrCreate(f.spec, f.runtime)
  expect(f.mock.requests).toHaveLength(0)
  expect(await owner.openOrCreate(f.spec, f.runtime)).toBe(handle)
  handle.data.append("project.attachment", { value: "before the first turn" })
  await handle.release()
  const reopened = await f.manager().forOwner("project-extension").open(handle.id, f.runtime)
  expect(reopened.id).toBe(handle.id)
  expect(reopened.data.read("project.attachment")).toEqual([{ value: "before the first turn" }])
  expect(reopened.history()).toEqual([])
  expect(f.mock.requests).toHaveLength(0)
  await reopened.send("Continue explicitly")
  expect(reopened.history().map((message) => message.role)).toEqual(["user", "assistant"])
  expect(listSessions(f.home, path.join(f.home, "sessions"))).toEqual([])
  await reopened.release()
  const next = await manager.forOwner("project-extension").open(handle.id, f.runtime)
  expect(next.history().map((message) => message.role)).toEqual(["user", "assistant"])
  expect(f.mock.requests).toHaveLength(1)
  await expect(handle.send("stale")).rejects.toThrow("released")
})

test("two hosts cannot share a writer, and foreign owners or incompatible specs fail closed", async () => {
  const f = setup()
  const first = f.manager().forOwner("one")
  const second = f.manager().forOwner("one")
  const handle = await first.openOrCreate(f.spec, f.runtime)
  await expect(second.openOrCreate(f.spec, f.runtime)).rejects.toThrow("in use")
  await expect(f.manager().forOwner("two").open(handle.id, f.runtime)).rejects.toThrow("owner")
  await expect(first.openOrCreate({ ...f.spec, cwd: path.dirname(f.home) }, f.runtime)).rejects.toThrow(
    "spec",
  )
  await expect(first.openOrCreate({ ...f.spec, callableTools: ["write"] }, f.runtime)).rejects.toThrow("spec")
  await handle.release()
  const reopened = await second.openOrCreate(f.spec, f.runtime)
  expect(reopened.id).toBe(handle.id)
  expect(f.mock.requests).toHaveLength(0)
})

test("runtime extras are validated, required on reopen, and cannot escape the saved callable ceiling", async () => {
  const f = setup([
    {
      toolCalls: [
        { id: "write-call", name: "write", args: {} },
        { id: "shell-call", name: "bash", args: {} },
        { id: "agent-call", name: "agent", args: {} },
        { id: "research-call", name: "research", args: {} },
      ],
    },
    { text: "done" },
  ])
  const called: string[] = []
  for (const name of ["read", "write", "bash", "agent"]) {
    f.tools.register(
      defineTool({
        name,
        description: name,
        parameters: { type: "object" },
        execute: async () => {
          called.push(name)
          return textResult("ok")
        },
      }),
      "test",
    )
  }
  const research = defineTool({
    name: "research",
    description: "Research",
    traits: { readOnly: true },
    parameters: { type: "object" },
    execute: async (_args, context) => {
      if (!context.session) throw new Error("missing bound session")
      called.push(context.session.sessionId)
      return textResult("research result")
    },
  })
  const runtime = { ...f.runtime, extraTools: [research] }
  const spec = { ...f.spec, callableTools: ["read", "research"] }
  const owner = f.manager().forOwner("project")
  await expect(
    owner.openOrCreate(spec, { ...runtime, extraTools: [{ ...research, name: "write" }] }),
  ).rejects.toThrow("extra tool")
  await expect(
    owner.openOrCreate(spec, { ...runtime, extraTools: [{ ...research, traits: { writesFiles: "paths" } }] }),
  ).rejects.toThrow("extra tool")
  const handle = await owner.openOrCreate(spec, runtime)
  await handle.send("Try tools")
  expect(called).toEqual([handle.id])
  await handle.release()
  await expect(owner.open(handle.id, f.runtime)).rejects.toThrow("missing")
  const reopened = await owner.open(handle.id, runtime)
  expect(reopened.id).toBe(handle.id)
  expect(f.mock.requests).toHaveLength(2)
})

test("direct human asks cancel on stop; scoped events, immutable history and explicit continuation survive", async () => {
  const f = setup([{ toolCalls: [{ id: "question", name: "ask_user", args: {} }] }, { text: "continued" }])
  const questions = [{ question: "Choose?", options: [{ label: "A", description: "First" }, { label: "B" }] }]
  f.tools.register(
    defineTool({
      name: "ask_user",
      description: "Ask",
      parameters: { type: "object" },
      execute: async (_args, context) => {
        if (!context.session?.askUser) throw new Error("missing direct asker")
        const outcome = await context.session.askUser(questions, context.signal)
        return { ...textResult(JSON.stringify(outcome)), details: { questions, outcome } }
      },
    }),
    "test",
  )
  let asked!: () => void
  const ready = new Promise<void>((resolve) => {
    asked = resolve
  })
  let askSignal: AbortSignal | undefined
  let source = ""
  const handle = await f
    .manager()
    .forOwner("project")
    .openOrCreate(
      { ...f.spec, callableTools: ["ask_user"] },
      {
        askUser: async (received, context) => {
          expect(received).toEqual(questions)
          source = context.sessionId
          askSignal = context.signal
          asked()
          // A hostile/abandoned UI need not settle for host cleanup to finish.
          return new Promise(() => {})
        },
      },
    )
  const events: AnyEvent[] = []
  const iterator = handle.events[Symbol.asyncIterator]()
  const collect = (async () => {
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      events.push(next.value)
    }
  })()
  const turn = handle.send("Ask me")
  await ready
  expect(source).toBe(handle.id)
  expect(handle.status()).toEqual({ state: "blocked", busy: true })
  await expect(handle.send("concurrent")).rejects.toThrow()
  await handle.stop("cancel the question")
  await turn
  expect(askSignal?.aborted).toBe(true)
  expect(handle.status()).toEqual({ state: "stopped", busy: false })
  await handle.send("Continue")
  const history = handle.history()
  expect(Object.isFrozen(history)).toBe(true)
  expect(Object.isFrozen(history[0])).toBe(true)
  expect(Object.isFrozen(history[0]?.content)).toBe(true)
  expect(history.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "toolResult",
    "user",
    "assistant",
  ])
  expect(f.mock.requests).toHaveLength(2)
  await handle.release()
  await collect
  expect(events.some((event) => event.type === "status.changed" && event.data.status === "blocked")).toBe(
    true,
  )
  expect(events.every((event) => event.sessionId === handle.id)).toBe(true)
  expect(events.map((event) => event.seq)).toEqual(
    [...events.map((event) => event.seq)].sort((a, b) => a - b),
  )
})

test("owned work and groups stay bound across main replacement and cannot stop main children", async () => {
  const f = setup([
    { toolCalls: [{ id: "main-gate", name: "wait", args: {} }] },
    { toolCalls: [{ id: "owned-gate", name: "wait", args: {} }] },
    { toolCalls: [{ id: "owned-root-gate", name: "wait", args: {} }] },
    { text: "owned continues", usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0.02 } },
  ])
  const entered: string[] = []
  const gates: (() => void)[] = []
  f.tools.register(
    defineTool({
      name: "wait",
      description: "Wait",
      traits: { readOnly: true },
      parameters: { type: "object" },
      execute: async (_args, context) => {
        entered.push(context.session?.sessionId ?? "missing")
        await new Promise<void>((resolve) => {
          gates.push(resolve)
          context.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return textResult("unblocked")
      },
    }),
    "test",
  )
  const mainChild = f.tree.spawn(f.main(), { prompt: "Main child", persistent: true })
  while (entered.length < 1) await Bun.sleep(0)
  const manager = f.manager()
  const handle = await manager
    .forOwner("project")
    .openOrCreate({ ...f.spec, callableTools: ["wait"] }, f.runtime)
  const group = handle.createGroup({ name: "Research", maxAgents: 1 })
  const child = group.spawn({ prompt: "Design child", persistent: true })
  while (entered.length < 2) await Bun.sleep(0)
  expect(group.info().parentSessionId).toBe(handle.id)
  expect(child.parentSessionId).toBe(handle.id)
  expect(f.tree.children.map((entry) => entry.id)).toEqual([mainChild.id])
  await handle.stop("stop owned only")
  expect((await child.result()).status).toBe("aborted")
  expect(mainChild.state).toBe("working")
  expect(group.info().state).toBe("ended")
  const ownedTurn = handle.send("Keep running across replacement")
  while (entered.length < 3) await Bun.sleep(0)
  const oldMain = f.main()
  const nextMain = new Agent({
    ai: f.ai,
    model: f.ai.model("mock/test"),
    cwd: f.home,
    tools: f.tools,
    tree: f.tree,
    sections: [],
  })
  f.switchMain(nextMain)
  // Main replacement owns only its own live tree, not the saved conversation's tree.
  await oldMain.dispose("switch")
  expect(mainChild.state).toBe("ended")
  expect(handle.status()).toEqual({ state: "working", busy: true })
  gates[2]?.()
  await ownedTurn
  handle.data.append("binding", { id: handle.id })
  expect(nextMain.data.read("binding")).toEqual([])
  expect(f.tree.usage.output).toBe(7)
  expect(f.tree.usage.cost).toBe(0.02)
  expect(handle.history().at(-1)?.role).toBe("assistant")
  await handle.release()
  expect(nextMain.status).toBe("idle")
})

test("owner abort and drain release leases and invalidate retained capabilities", async () => {
  const f = setup()
  const manager = f.manager()
  const abort = new AbortController()
  const owner = manager.forOwner("project", abort.signal)
  const handle = await owner.openOrCreate(f.spec, f.runtime)
  abort.abort()
  await manager.releaseOwner("project")
  await expect(handle.send("unloaded")).rejects.toThrow("released")
  await expect(owner.open(handle.id, f.runtime)).rejects.toThrow()
  const freshOwner = manager.forOwner("project")
  const reopened = await freshOwner.open(handle.id, f.runtime)
  await manager.drain()
  await expect(freshOwner.open(handle.id, f.runtime)).rejects.toThrow("released")
  await expect(reopened.send("exit")).rejects.toThrow("released")
  const otherHost = f.manager().forOwner("project")
  expect((await otherHost.open(handle.id, f.runtime)).id).toBe(handle.id)
})

test("history retains compacted originals rather than returning the model context", async () => {
  const f = setup(
    [
      { text: "original answer", usage: { input: 200000, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      { text: "short summary" },
      { text: "second answer" },
    ],
    { compaction: { auto: true, keepTurns: 1 } },
  )
  const handle = await f.manager().forOwner("project").openOrCreate(f.spec, f.runtime)
  const iterator = handle.events[Symbol.asyncIterator]()
  const compacted: AnyEvent[] = []
  const collect = (async () => {
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      if (next.value.type === "compact.end") compacted.push(next.value)
    }
  })()
  await handle.send("original question")
  await handle.send("second question")
  expect(f.mock.requests).toHaveLength(3)
  expect(JSON.stringify(f.mock.requests[2]?.messages)).not.toContain("original question")
  expect(handle.history().map((message) => message.content)).toEqual([
    [{ type: "text", text: "original question" }],
    [{ type: "text", text: "original answer" }],
    [{ type: "text", text: "second question" }],
    [{ type: "text", text: "second answer" }],
  ])
  const id = handle.id
  await handle.release()
  await collect
  expect(compacted).toHaveLength(1)
  const reopened = await f.manager().forOwner("project").open(id, f.runtime)
  expect(reopened.history()).toHaveLength(4)
  expect(f.mock.requests).toHaveLength(3)
})

test("release flushes an owned trace without tracing through the main bus", async () => {
  const f = setup([{ text: "answer", usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 } }])
  const mainEvents: AnyEvent[] = []
  f.main().bus.subscribe((event) => {
    mainEvents.push(event)
  })
  const handle = await f.manager().forOwner("project").openOrCreate(f.spec, f.runtime)
  await handle.send("question")
  await handle.release()
  const files = readdirSync(f.home, { recursive: true }).filter(
    (file) => typeof file === "string" && file.endsWith(".trace.jsonl"),
  )
  expect(files).toHaveLength(1)
  const file = files[0]
  if (typeof file !== "string") throw new Error("missing trace file")
  const trace = await readTrace(path.join(f.home, file.replace(/\.trace\.jsonl$/, "")))
  expect(trace.some((record) => record.type === "model")).toBe(true)
  expect(trace.some((record) => record.type === "turn")).toBe(true)
  expect(mainEvents).toEqual([])
})
