// Regression tests for defects found in code review of the agent loop.
import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

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

test("extensions can run commands through the host", async () => {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  let output = ""
  await host.load(async (api) => {
    const run = await api.runCommand([process.execPath, "-e", "console.log('from ext')"], {
      cwd: process.cwd(),
      timeoutMs: 60_000,
      signal: new AbortController().signal,
    })
    output = run.output.trim()
  }, "runner")
  expect(output).toBe("from ext")
}, 60_000)

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
