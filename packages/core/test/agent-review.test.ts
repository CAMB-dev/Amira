// Regression tests for defects found in code review of the agent loop.
import { afterEach, expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { resetCommandWorker } from "@amira/proc"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnCondition } from "../../../scripts/spawn-test.ts"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

let commandAbort: AbortController | undefined
let commandRun: Promise<unknown> | undefined
afterEach(async () => {
  if (!commandAbort) return
  commandAbort.abort()
  let settled = false
  void Promise.allSettled(commandRun ? [commandRun] : []).then(() => (settled = true))
  try {
    await waitForSpawnCondition("agent extension command cleanup", () => settled)
  } finally {
    resetCommandWorker()
    commandAbort = undefined
    commandRun = undefined
  }
}, SPAWN_TEST_TIMEOUT_MS)

function setup(steps: MockStep[], abortGraceMs = 50) {
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const agent = new Agent({ ai, model: ai.model("mock/t"), cwd: ".", systemPrompt: "s", bus, abortGraceMs })
  return { agent, mock, bus, events }
}

/** Every assistant tool call must be answered by exactly one following toolResult. */
function expectValidHistory(agent: Agent) {
  const ids = agent.messages.flatMap((m) =>
    m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall").map((b) => b.id) : [],
  )
  const answered = agent.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId)
  expect(answered.sort()).toEqual(ids.sort())
  for (const m of agent.messages) if (m.role === "toolResult") expect(Array.isArray(m.content)).toBe(true)
}

const call = (name: string, args: Record<string, unknown> = {}, id?: string) => ({
  name,
  args,
  ...(id ? { id } : {}),
})

test("malformed tool results become error results and the next request still works", async () => {
  const { agent, mock } = setup([
    { toolCalls: [call("undef"), call("empty")] },
    { text: "recovered" },
    { text: "second turn" },
  ])
  agent.tools.register(
    defineTool({ name: "undef", description: "", parameters: {}, execute: async () => undefined as never }),
    "t",
  )
  agent.tools.register(
    defineTool({ name: "empty", description: "", parameters: {}, execute: async () => ({}) as never }),
    "t",
  )
  expect((await agent.prompt("go")).reason).toBe("done")
  expectValidHistory(agent)
  const results = agent.messages.filter((m) => m.role === "toolResult")
  expect(results.every((r) => r.isError)).toBe(true)
  expect((await agent.prompt("again")).reason).toBe("done")
  expect(mock.requests).toHaveLength(3)
})

test("a tool that throws produces an error result with its message", async () => {
  const { agent } = setup([{ toolCalls: [call("boom")] }, { text: "ok" }])
  agent.tools.register(
    defineTool({
      name: "boom",
      description: "",
      parameters: {},
      execute: async () => {
        throw new Error("kaput")
      },
    }),
    "t",
  )
  await agent.prompt("go")
  const r = agent.messages.find((m) => m.role === "toolResult")!
  expect(r.isError).toBe(true)
  expect((r.content[0] as { text: string }).text).toBe("Tool failed: kaput")
})

test("a tool that ignores abort is abandoned after the grace period", async () => {
  const { agent, bus, events } = setup([{ toolCalls: [call("stuck", {}, "s1")] }], 40)
  let late: (() => void) | undefined
  agent.tools.register(
    defineTool({
      name: "stuck",
      description: "",
      parameters: {},
      execute: (_p, ctx) =>
        new Promise((resolve) => {
          late = () => {
            ctx.update(textResult("late progress"))
            resolve(textResult("late"))
          }
        }),
    }),
    "t",
  )
  const p = agent.prompt("go")
  setTimeout(() => agent.abort(), 20)
  const r = await p
  expect(r.reason).toBe("aborted")
  expect(agent.status).toBe("idle")
  expectValidHistory(agent)

  // The abandoned tool finishing later must not leak into the next turn.
  late?.()
  await bus.flush()
  const turnIds = new Set(events.filter((e) => e.type === "turn.start").map((e) => e.turnId))
  expect(turnIds.size).toBe(1)
  expect(events.filter((e) => e.type === "tool.execute.update")).toHaveLength(0)
  expect(events.filter((e) => e.type === "tool.execute.end")).toHaveLength(1)
})

test("a hung tool.call.before interceptor does not delay an abort", async () => {
  const { agent } = setup([{ toolCalls: [call("echo")] }])
  agent.tools.register(
    defineTool({ name: "echo", description: "", parameters: {}, execute: async () => textResult("x") }),
    "t",
  )
  agent.interceptors.add("tool.call.before", () => new Promise(() => {}), { timeoutMs: 60_000 })
  const started = performance.now()
  const p = agent.prompt("go")
  setTimeout(() => agent.abort(), 20)
  expect((await p).reason).toBe("aborted")
  expect(performance.now() - started).toBeLessThan(1000)
  expectValidHistory(agent)
})

test("interceptor handlers receive a signal that fires on their own timeout", async () => {
  const r = new InterceptorRegistry({ defaultTimeoutMs: 20 })
  let aborted = false
  r.add("context.build", (_v, ctx) => {
    ctx.signal.addEventListener("abort", () => {
      aborted = true
    })
    return new Promise(() => {})
  })
  await r.run(
    "context.build",
    { systemPrompt: "", messages: [] },
    { sessionId: "s", signal: new AbortController().signal },
  )
  expect(aborted).toBe(true)
})

test("context.build block ends the turn with an error instead of being ignored", async () => {
  const { agent, mock } = setup([{ text: "never" }])
  agent.interceptors.add("context.build", () => ({ action: "block", reason: "quota" }))
  const r = await agent.prompt("go")
  expect(r).toEqual({ reason: "error", steps: 1, error: "context.build blocked the request: quota" })
  expect(mock.requests).toHaveLength(0)
})

test("rejected tool calls still emit paired start and end events with a reason", async () => {
  const { agent, bus, events } = setup([
    { toolCalls: [call("nope", {}, "a"), call("echo", { text: 1 }, "b")] },
    { text: "ok" },
  ])
  agent.tools.register(
    defineTool({
      name: "echo",
      description: "",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: async () => textResult("x"),
    }),
    "t",
  )
  await agent.prompt("go")
  await bus.flush()
  const starts = events.filter((e) => e.type === "tool.execute.start").map((e) => e.data.toolCallId)
  const ends = events.filter((e) => e.type === "tool.execute.end")
  expect(starts).toEqual(["a", "b"])
  expect(ends.map((e) => [e.data.toolCallId, e.data.rejected])).toEqual([
    ["a", "unknownTool"],
    ["b", "invalidArgs"],
  ])
  const text = (
    agent.messages.find((m) => m.role === "toolResult" && m.toolCallId === "b")!.content[0] as {
      text: string
    }
  ).text
  expect(text).toContain('parameter "text" should be "string"')
})

test("mixed batches: [parallel, serial, parallel, parallel] runs as [1] [2] [3,4]", async () => {
  const { agent } = setup([
    { toolCalls: [call("p", {}, "1"), call("s", {}, "2"), call("p", {}, "3"), call("p", {}, "4")] },
    { text: "" },
  ])
  const log: string[] = []
  const mk = (name: string, concurrency: "parallel" | "serial") =>
    defineTool({
      name,
      description: "",
      parameters: {},
      concurrency,
      execute: async (_p, ctx) => {
        log.push(`start ${ctx.toolCallId}`)
        await Bun.sleep(10)
        log.push(`end ${ctx.toolCallId}`)
        return textResult(ctx.toolCallId)
      },
    })
  agent.tools.register(mk("p", "parallel"), "t")
  agent.tools.register(mk("s", "serial"), "t")
  await agent.prompt("go")
  expect(log).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "start 4", "end 3", "end 4"])
})

test("a failing extension is rolled back completely, and unload removes everything", async () => {
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const interceptors = new InterceptorRegistry()
  const host = new ExtensionHost({ bus, interceptors, tools })
  let heard = 0
  const ok = await host.load((api) => {
    api.on("turn.end", () => {
      heard++
    })
    api.registerTool(
      defineTool({ name: "t1", description: "", parameters: {}, execute: async () => textResult("") }),
    )
    throw new Error("half way")
  }, "bad")
  expect(ok).toBe(false)
  expect(tools.get("t1")).toBeUndefined()
  bus.emit("turn.end", { reason: "done", steps: 0 }, { sessionId: "s" })
  await bus.flush()
  expect(heard).toBe(0)

  await host.load((api) => {
    api.registerTool(
      defineTool({ name: "t2", description: "", parameters: {}, execute: async () => textResult("") }),
    )
    api.intercept("context.build", () => ({ action: "block", reason: "x" }))
  }, "good")
  expect(tools.get("t2")).toBeDefined()
  expect(host.unload("good")).toBe(true)
  expect(tools.get("t2")).toBeUndefined()
  const out = await interceptors.run(
    "context.build",
    { systemPrompt: "", messages: [] },
    {
      sessionId: "s",
      signal: new AbortController().signal,
    },
  )
  expect(out.blocked).toBe(false)
})

test("tool registry: removing a middle override keeps the top one", () => {
  const reg = new ToolRegistry()
  const t = (description: string, override = true) =>
    defineTool({ name: "x", description, parameters: {}, override, execute: async () => textResult("") })
  reg.register(t("a", false), "A")
  const offB = reg.register(t("b"), "B")
  const offC = reg.register(t("c"), "C")
  offB()
  expect(reg.get("x")?.description).toBe("c")
  offC()
  expect(reg.get("x")?.description).toBe("a")
})

test(
  "extensions can run commands through the host",
  async () => {
    const host = new ExtensionHost({
      bus: new EventBus(),
      interceptors: new InterceptorRegistry(),
      tools: new ToolRegistry(),
    })
    const abort = new AbortController()
    commandAbort = abort
    try {
      let output = ""
      await host.load(async (api) => {
        const running = api.runCommand([process.execPath, "-e", "console.log('from ext')"], {
          cwd: process.cwd(),
          timeoutMs: 60_000,
          signal: abort.signal,
        })
        commandRun = running
        const run = await running
        output = run.output.trim()
      }, "runner")
      expect(output).toBe("from ext")
    } finally {
      abort.abort()
      host.unload("runner")
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test("parallel calls sharing a key run in order while other keys run alongside", async () => {
  const { agent } = setup([
    {
      toolCalls: [
        { name: "w", args: { path: "a", n: 1 }, id: "1" },
        { name: "w", args: { path: "b", n: 2 }, id: "2" },
        { name: "w", args: { path: "a", n: 3 }, id: "3" },
      ],
    },
    { text: "" },
  ])
  const log: string[] = []
  agent.tools.register(
    defineTool<{ path: string; n: number }>({
      name: "w",
      description: "",
      parameters: {},
      concurrency: "parallel",
      concurrencyKey: (p) => p.path,
      execute: async (p) => {
        log.push(`start ${p.n}`)
        await Bun.sleep(p.n === 1 ? 40 : 10)
        log.push(`end ${p.n}`)
        return textResult(String(p.n))
      },
    }),
    "t",
  )
  await agent.prompt("go")
  // 1 and 2 overlap; 3 (same file as 1) waits for 1.
  expect(log.indexOf("start 2")).toBeLessThan(log.indexOf("end 1"))
  expect(log.indexOf("start 3")).toBeGreaterThan(log.indexOf("end 1"))
  const ids = agent.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId)
  expect(ids).toEqual(["1", "2", "3"])
})

for (const blockedBy of ["interceptor", "plan", "approval"] as const) {
  test(`concurrency keys are not invoked for calls blocked by ${blockedBy}`, async () => {
    const { agent } = setup([{ toolCalls: [call("write", { path: "blocked" })] }, { text: "done" }])
    let keys = 0
    let executions = 0
    agent.tools.register(
      defineTool<{ path: string }>({
        name: "write",
        description: "",
        parameters: {},
        concurrency: "parallel",
        traits: { writesFiles: true },
        concurrencyKey: (args) => {
          keys++
          return args.path
        },
        execute: async () => {
          executions++
          return textResult("must not run")
        },
      }),
      "t",
    )
    if (blockedBy === "interceptor") {
      agent.interceptors.add("tool.call.before", () => ({ action: "block", reason: "blocked" }))
    } else if (blockedBy === "plan") {
      agent.permissions.setMode("plan")
    } else {
      // With no approver attached, an interceptor's question cannot be approved.
      agent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "check first" }))
    }
    await agent.prompt("go")
    expect(agent.messages.find((m) => m.role === "toolResult")?.rejected).toBe("blocked")
    expect(executions).toBe(0)
    expect(keys).toBe(0)
  })
}

test("authorized calls serialize by interceptor-transformed paths in request order", async () => {
  const { agent } = setup([
    { toolCalls: [call("write", { path: "first" }, "1"), call("write", { path: "second" }, "2")] },
    { text: "done" },
  ])
  const keys: string[] = []
  const log: string[] = []
  agent.interceptors.add("tool.call.before", (value) => ({
    action: "modify",
    value: { ...value, args: { path: "authorized" } },
  }))
  agent.tools.register(
    defineTool<{ path: string }>({
      name: "write",
      description: "",
      parameters: {},
      concurrency: "parallel",
      concurrencyKey: (args) => {
        keys.push(args.path)
        return args.path
      },
      execute: async (_args, context) => {
        log.push(`start ${context.toolCallId}`)
        await Bun.sleep(10)
        log.push(`end ${context.toolCallId}`)
        return textResult("done")
      },
    }),
    "t",
  )
  await agent.prompt("go")
  expect(keys).toEqual(["authorized", "authorized"])
  expect(log).toEqual(["start 1", "end 1", "start 2", "end 2"])
  expectValidHistory(agent)
})

test("an independent key runs while an earlier call is waiting on its interceptor", async () => {
  const { agent } = setup([
    { toolCalls: [call("write", { path: "a" }, "1"), call("write", { path: "b" }, "2")] },
    { text: "done" },
  ])
  const independent = Promise.withResolvers<void>()
  const log: string[] = []
  agent.interceptors.add("tool.call.before", async (value) => {
    if (value.toolCallId === "1") await independent.promise
    return { action: "pass" }
  })
  agent.tools.register(
    defineTool<{ path: string }>({
      name: "write",
      description: "",
      parameters: {},
      concurrency: "parallel",
      concurrencyKey: (args) => args.path,
      execute: async (_args, context) => {
        log.push(context.toolCallId)
        if (context.toolCallId === "2") independent.resolve()
        return textResult("done")
      },
    }),
    "t",
  )
  await agent.prompt("go")
  expect(log).toEqual(["2", "1"])
  expectValidHistory(agent)
})

test("aborting a same-key wait does not execute it after its abandoned predecessor returns", async () => {
  const { agent } = setup(
    [{ toolCalls: [call("write", { path: "same" }, "1"), call("write", { path: "same" }, "2")] }],
    10,
  )
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const log: string[] = []
  agent.tools.register(
    defineTool<{ path: string }>({
      name: "write",
      description: "",
      parameters: {},
      concurrency: "parallel",
      concurrencyKey: (args) => args.path,
      execute: async (_args, context) => {
        log.push(context.toolCallId)
        entered.resolve()
        await release.promise
        return textResult("done")
      },
    }),
    "t",
  )
  const prompted = agent.prompt("go")
  await entered.promise
  agent.abort()
  expect((await prompted).reason).toBe("aborted")
  expectValidHistory(agent)
  release.resolve()
  await Bun.sleep(20)
  expect(log).toEqual(["1"])
})

test("at most maxParallelTools calls run at once", async () => {
  const mock = createMockDialect([
    { toolCalls: Array.from({ length: 6 }, (_, i) => ({ name: "p", args: {}, id: `c${i}` })) },
    { text: "" },
  ])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const agent = new Agent({ ai, model: ai.model("mock/t"), cwd: ".", systemPrompt: "", maxParallelTools: 2 })
  expect(agent.maxParallelTools).toBe(2)
  let running = 0
  let peak = 0
  agent.tools.register(
    defineTool({
      name: "p",
      description: "",
      parameters: {},
      concurrency: "parallel",
      execute: async () => {
        running++
        peak = Math.max(peak, running)
        await Bun.sleep(15)
        running--
        return textResult("ok")
      },
    }),
    "t",
  )
  await agent.prompt("go")
  expect(peak).toBe(2)
  expect(agent.messages.filter((m) => m.role === "toolResult")).toHaveLength(6)
})

const counter = (concurrency: "parallel" | "serial") => {
  const state = { runs: 0 }
  const tool = defineTool({
    name: "count",
    description: "",
    parameters: {},
    concurrency,
    execute: async () => textResult(`run ${++state.runs}`),
  })
  return { state, tool }
}

test("a tool call id reused in a later step still runs, reports and keeps its own result", async () => {
  const { agent, bus, events } = setup([
    { toolCalls: [call("count", {}, "call_0")] },
    { toolCalls: [call("count", {}, "call_0")] },
    { text: "done" },
  ])
  const { state, tool } = counter("serial")
  agent.tools.register(tool, "t")
  expect((await agent.prompt("go")).reason).toBe("done")
  await bus.flush()
  expect(state.runs).toBe(2)
  const results = agent.messages.filter((m) => m.role === "toolResult")
  expect(results.map((r) => [r.isError, r.content])).toEqual([
    [false, [{ type: "text", text: "run 1" }]],
    [false, [{ type: "text", text: "run 2" }]],
  ])
  const tools = events.filter((e) => e.type.startsWith("tool.execute."))
  expect(tools.map((e) => e.type)).toEqual([
    "tool.execute.start",
    "tool.execute.end",
    "tool.execute.start",
    "tool.execute.end",
  ])
  expect(tools.some((e) => e.type === "tool.execute.end" && e.data.rejected)).toBe(false)
})

test("two calls with the same id in one batch each get their own result", async () => {
  const { agent } = setup([
    { toolCalls: [call("count", {}, "dup"), call("count", {}, "dup")] },
    { text: "ok" },
  ])
  const { state, tool } = counter("parallel")
  agent.tools.register(tool, "t")
  expect((await agent.prompt("go")).reason).toBe("done")
  expect(state.runs).toBe(2)
  const results = agent.messages.filter((m) => m.role === "toolResult")
  expect(results.map((r) => r.isError)).toEqual([false, false])
  expect(results.map((r) => (r.content[0] as { text: string }).text).sort()).toEqual(["run 1", "run 2"])
})

test("history repair answers a later call whose id an earlier, answered call used", async () => {
  const mock = createMockDialect([{ text: "ok" }])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const model = { provider: "mock", model: "t" }
  const agent = new Agent({
    ai,
    model: ai.model("mock/t"),
    cwd: ".",
    systemPrompt: "",
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "same", name: "x", args: {} }], model },
      {
        role: "toolResult",
        toolCallId: "same",
        toolName: "x",
        content: [{ type: "text", text: "1" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "toolCall", id: "same", name: "x", args: {} }], model },
    ],
  })
  await agent.prompt("next")
  expect(agent.messages.filter((m) => m.role === "toolResult")).toHaveLength(2)
})
