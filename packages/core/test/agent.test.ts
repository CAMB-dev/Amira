import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

function setup(steps: MockStep[]) {
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 128_000 } }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const agent = new Agent({ ai, model: ai.model("mock/test"), cwd: process.cwd(), systemPrompt: "sys", bus })
  return { agent, mock, bus, events }
}

const echo = defineTool<{ text: string }>({
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  concurrency: "parallel",
  execute: async (p) => textResult(`echo: ${p.text}`),
})

test("a text-only turn emits a well-formed event sequence", async () => {
  const { agent, bus, events } = setup([{ text: "hello there" }])
  const r = await agent.prompt("hi")
  await bus.flush()
  expect(r).toEqual({ reason: "done", steps: 1 })
  const types = events.map((e) => e.type).filter((t) => t !== "message.delta")
  expect(types).toEqual([
    "turn.start",
    "status.changed",
    "message.start",
    "message.stream",
    "message.end",
    "turn.end",
    "status.changed",
  ])
  expect(events.filter((e) => e.type === "message.delta").length).toBeGreaterThan(0)
  expect(new Set(events.map((e) => e.turnId)).size).toBe(1)
  expect(agent.messages.map((m) => m.role)).toEqual(["user", "assistant"])
  expect(agent.status).toBe("idle")
})

test("executes tool calls and feeds results back to the model", async () => {
  const { agent, mock } = setup([
    { toolCalls: [{ name: "echo", args: { text: "a" }, id: "c1" }] },
    (req) => ({ text: `saw ${req.messages.at(-1)?.role}` }),
  ])
  agent.tools.register(echo, "test")
  const r = await agent.prompt("go")
  expect(r).toEqual({ reason: "done", steps: 2 })
  expect(mock.requests[0]!.tools.map((t) => t.name)).toEqual(["echo"])
  const last = mock.requests[1]!.messages.at(-1)!
  expect(last).toEqual({
    role: "toolResult",
    toolCallId: "c1",
    toolName: "echo",
    content: [{ type: "text", text: "echo: a" }],
    isError: false,
  })
  expect(agent.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"])
})

test("parallel-safe tools run concurrently, results keep call order", async () => {
  const { agent } = setup([
    { toolCalls: [1, 2, 3].map((n) => ({ name: "slow", args: { n }, id: `c${n}` })) },
    { text: "done" },
  ])
  let running = 0
  let peak = 0
  agent.tools.register(
    defineTool<{ n: number }>({
      name: "slow",
      description: "",
      parameters: {},
      concurrency: "parallel",
      execute: async (p) => {
        running++
        peak = Math.max(peak, running)
        await Bun.sleep(30 - p.n * 5)
        running--
        return textResult(String(p.n))
      },
    }),
    "test",
  )
  await agent.prompt("go")
  expect(peak).toBe(3)
  const ids = agent.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId)
  expect(ids).toEqual(["c1", "c2", "c3"])
})

test("reports unknown tools, invalid JSON and blocked calls as tool errors", async () => {
  const { agent } = setup([
    {
      toolCalls: [
        { name: "nope", args: {}, id: "a" },
        { name: "echo", args: "{bad", id: "b" },
        { name: "echo", args: { text: "rm" }, id: "c" },
      ],
    },
    { text: "ok" },
  ])
  agent.tools.register(echo, "test")
  agent.interceptors.add("tool.call.before", (v) =>
    v.args.text === "rm" ? { action: "block", reason: "not allowed" } : { action: "pass" },
  )
  await agent.prompt("go")
  const results = agent.messages.filter((m) => m.role === "toolResult")
  expect(results.map((r) => r.isError)).toEqual([true, true, true])
  const texts = results.map((r) => (r.content[0] as { text: string }).text)
  expect(texts[0]).toContain('Unknown tool "nope"')
  expect(texts[1]).toContain("Invalid JSON")
  expect(texts[2]).toBe("Tool call blocked: not allowed")
})

test("tool.call.after can add to a result before the model and tool.execute.end see it", async () => {
  const { agent, mock, bus, events } = setup([
    {
      toolCalls: [
        { name: "echo", args: { text: "a" }, id: "c1" },
        { name: "echo", args: { text: "b" }, id: "c2" },
        { name: "nope", args: {}, id: "c3" },
      ],
    },
    { text: "done" },
  ])
  agent.tools.register(echo, "test")
  const seen: string[] = []
  agent.interceptors.add("tool.call.after", (v) => {
    seen.push(`${v.name}:${String(v.args.text)}:${v.rejected ?? "ran"}`)
    if (v.args.text !== "a") return { action: "block", reason: "ignored" }
    return {
      action: "modify",
      value: {
        ...v,
        result: { ...v.result, content: [...v.result.content, { type: "text", text: "lint: 1 problem" }] },
      },
    }
  })
  // A failing handler, or one that drops the content, leaves the result as it was.
  agent.interceptors.add("tool.call.after", () => {
    throw new Error("broken")
  })
  agent.interceptors.add("tool.call.after", (v) => ({
    action: "modify",
    value: { ...v, result: { isError: true } as unknown as typeof v.result },
  }))
  await agent.prompt("go")
  await bus.flush()
  // Rejected calls reach it too, marked as such.
  expect(seen.toSorted()).toEqual(["echo:a:ran", "echo:b:ran", "nope:undefined:unknownTool"])
  const results = mock.requests[1]!.messages.filter((m) => m.role === "toolResult")
  expect(results[0]!.content).toEqual([
    { type: "text", text: "echo: a" },
    { type: "text", text: "lint: 1 problem" },
  ])
  expect(results[1]!.content).toEqual([{ type: "text", text: "echo: b" }])
  const end = events.find((e) => e.type === "tool.execute.end" && e.data.toolCallId === "c1")
  expect(end?.type === "tool.execute.end" && end.data.result.content).toHaveLength(2)
})

test("context.build can rewrite what the model receives", async () => {
  const { agent, mock } = setup([{ text: "x" }])
  agent.interceptors.add("context.build", (v) => ({
    action: "modify",
    value: { ...v, systemPrompt: "changed" },
  }))
  await agent.prompt("go")
  expect(mock.requests[0]!.systemPrompt).toBe("changed")
  expect(agent.systemPrompt).toBe("sys")
})

test("abort during streaming ends the turn with aborted and keeps partial text", async () => {
  const { agent, bus, events } = setup([{ text: "a long streamed answer", delayMs: 20 }])
  const p = agent.prompt("go")
  setTimeout(() => agent.abort(), 50)
  const r = await p
  await bus.flush()
  expect(r.reason).toBe("aborted")
  expect(events.filter((e) => e.type === "turn.end")).toHaveLength(1)
  const last = agent.messages.at(-1)!
  expect(last.role).toBe("assistant")
  expect(agent.status).toBe("idle")
})

test("abort during tool execution fills missing tool results", async () => {
  const { agent } = setup([
    {
      toolCalls: [
        { name: "wait", args: {}, id: "w1" },
        { name: "wait", args: {}, id: "w2" },
      ],
    },
  ])
  agent.tools.register(
    defineTool({
      name: "wait",
      description: "",
      parameters: {},
      execute: (_p, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve(textResult("stopped", true)))
        }),
    }),
    "test",
  )
  const p = agent.prompt("go")
  setTimeout(() => agent.abort(), 30)
  const r = await p
  expect(r.reason).toBe("aborted")
  const results = agent.messages.filter((m) => m.role === "toolResult")
  expect(results.map((m) => m.toolCallId)).toEqual(["w1", "w2"])
  expect(results.every((m) => m.isError)).toBe(true)
})

test("model errors end the turn with error and pass through the error status", async () => {
  const { agent, bus, events } = setup([{ error: { message: "HTTP 500: boom", retryable: true } }])
  const r = await agent.prompt("go")
  await bus.flush()
  expect(r).toMatchObject({ reason: "error", steps: 1, error: "HTTP 500: boom" })
  expect(r.failure).toMatchObject({ kind: "other", summary: "Model request failed: boom" })
  const statuses = events.filter((e) => e.type === "status.changed").map((e) => e.data.status)
  expect(statuses).toEqual(["working", "error", "idle"])
  expect(agent.messages.map((m) => m.role)).toEqual(["user"])
})

test("rejects a second prompt while a turn is running", async () => {
  const { agent } = setup([{ text: "slow", delayMs: 20 }])
  const p = agent.prompt("one")
  await expect(agent.prompt("two")).rejects.toThrow(/already running/)
  await p
})

test("loads a .ts extension from outside the workspace via the virtual @amira/api module", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-ext-"))
  const file = path.join(dir, "hello.ts")
  await writeFile(
    file,
    `import { defineTool, textResult, API_VERSION } from "@amira/api"
export default function (api: any) {
  api.registerTool(defineTool({ name: "hello", description: "v" + API_VERSION, parameters: {}, execute: async () => textResult("hi") }))
}`,
  )
  const tools = new ToolRegistry()
  const errors: string[] = []
  const bus = new EventBus()
  bus.subscribe((e) => {
    if (e.type === "extension.error") errors.push(`${e.data.source}: ${e.data.error}`)
  })
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  expect(await host.loadFile(file)).toBe(true)
  await bus.flush()
  expect(errors).toEqual([])
  expect(tools.get("hello")?.description).toMatch(/^v\d/)
  // Loading the file again after an edit runs the edited code (/reload).
  host.unloadAll()
  await writeFile(
    file,
    `import { defineTool, textResult } from "@amira/api"
export default function (api: any) {
  api.registerTool(defineTool({ name: "hello", description: "edited", parameters: {}, execute: async () => textResult("hi") }))
}`,
  )
  expect(await host.loadFile(file)).toBe(true)
  expect(host.loaded).toEqual([file])
  expect(tools.get("hello")?.description).toBe("edited")
  expect(await host.loadFile(path.join(dir, "missing.ts"))).toBe(false)
  await bus.flush()
  expect(errors).toHaveLength(1)
})

test("tool call deltas carry the stable index from the dialect", async () => {
  const { agent, bus, events } = setup([{ toolCalls: [{ name: "echo", args: { text: "a" } }] }, { text: "" }])
  agent.tools.register(echo, "test")
  await agent.prompt("go")
  await bus.flush()
  const delta = events.find((e) => e.type === "message.delta" && e.data.kind === "toolCall")
  expect(delta?.type === "message.delta" && delta.data.kind === "toolCall" ? delta.data.index : -1).toBe(0)
})
