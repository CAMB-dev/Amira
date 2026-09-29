import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type AnyEvent, defineTool, type InterceptorMap, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"

function setup(steps: MockStep[]) {
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const agent = new Agent({ ai, model: ai.model("mock/test"), cwd: process.cwd(), systemPrompt: "sys", bus })
  return { agent, mock, bus, events }
}

const slow = defineTool<{ n: number }>({
  name: "slow",
  description: "",
  parameters: {},
  concurrency: "parallel",
  execute: async (p) => {
    await Bun.sleep(p.n * 15)
    return { ...textResult(`done ${p.n}`), details: { n: p.n } }
  },
})

test("tool.call.after can change a result: the model, the history and tool.execute.end see the change", async () => {
  const { agent, mock, bus, events } = setup([
    { toolCalls: [{ name: "slow", args: { n: 1 }, id: "c1" }] },
    { text: "ok" },
  ])
  agent.tools.register(slow, "test")
  const seen: InterceptorMap["tool.call.after"][] = []
  agent.interceptors.add("tool.call.after", (v) => {
    seen.push(v)
    const result = {
      ...v.result,
      content: [...v.result.content, { type: "text" as const, text: "lint: ok" }],
    }
    return { action: "modify", value: { ...v, result } }
  })
  await agent.prompt("go")
  await bus.flush()
  expect(seen[0]).toMatchObject({
    toolCallId: "c1",
    name: "slow",
    args: { n: 1 },
    cwd: process.cwd(),
    pending: [],
  })
  const sent = mock.requests[1]!.messages.at(-1)!
  expect(sent).toMatchObject({ role: "toolResult", content: [{ text: "done 1" }, { text: "lint: ok" }] })
  expect(agent.messages.at(-2)).toEqual(sent)
  const end = events.find((e) => e.type === "tool.execute.end")
  expect(end?.data).toMatchObject({
    result: { content: [{ text: "done 1" }, { text: "lint: ok" }], details: { n: 1 } },
  })
})

test("a rejected call starts, goes through tool.call.after, then ends, once each", async () => {
  const { agent, bus, events } = setup([
    { toolCalls: [{ name: "nope", args: {}, id: "n1" }] },
    { text: "ok" },
  ])
  const order: string[] = []
  bus.subscribe((e) => {
    if (e.type === "tool.execute.start" || e.type === "tool.execute.end") order.push(e.type)
  })
  agent.interceptors.add("tool.call.after", async (v) => {
    // Events are delivered asynchronously: let the start reach the subscriber first.
    await bus.flush()
    order.push(`after:${v.rejected}`)
    return { action: "pass" }
  })
  await agent.prompt("go")
  await bus.flush()
  expect(order).toEqual(["tool.execute.start", "after:unknownTool", "tool.execute.end"])
  expect(events.filter((e) => e.type === "tool.execute.end")).toHaveLength(1)
})

test("tool.call.after lists the calls of the same reply still waiting for a result", async () => {
  const { agent } = setup([
    {
      toolCalls: [
        { name: "slow", args: { n: 1 }, id: "a" },
        { name: "slow", args: { n: 3 }, id: "b" },
        { name: "nope", args: {}, id: "c" },
      ],
    },
    { text: "ok" },
  ])
  agent.tools.register(slow, "test")
  const pending: Record<string, string[]> = {}
  const rejected: Record<string, string | undefined> = {}
  agent.interceptors.add("tool.call.after", (v) => {
    pending[v.toolCallId] = v.pending.map((p) => p.toolCallId)
    rejected[v.toolCallId] = v.rejected
    return { action: "pass" }
  })
  await agent.prompt("go")
  // c is rejected at once (unknown tool) while a and b run; a returns before b.
  expect(pending).toEqual({ c: ["a", "b"], a: ["b"], b: [] })
  expect(rejected).toEqual({ a: undefined, b: undefined, c: "unknownTool" })
})

test("a failing tool.call.after handler, or one returning a broken result, leaves the result as it was", async () => {
  const { agent, mock } = setup([
    { toolCalls: [{ name: "slow", args: { n: 1 }, id: "c1" }] },
    { toolCalls: [{ name: "slow", args: { n: 1 }, id: "c2" }] },
    { text: "ok" },
  ])
  agent.tools.register(slow, "test")
  let calls = 0
  agent.interceptors.add("tool.call.after", (v) => {
    calls++
    if (v.toolCallId === "c1") throw new Error("boom")
    return { action: "modify", value: { ...v, result: { content: "nope" } as never } }
  })
  await agent.prompt("go")
  expect(calls).toBe(2)
  expect(mock.requests[1]!.messages.at(-1)).toMatchObject({ content: [{ text: "done 1" }], isError: false })
  expect(mock.requests[2]!.messages.at(-1)).toMatchObject({ content: [{ text: "done 1" }], isError: false })
})

test("an interrupt skips tool.call.after", async () => {
  const { agent } = setup([{ toolCalls: [{ name: "wait", args: {}, id: "w" }] }])
  let started: () => void = () => {}
  const running = new Promise<void>((r) => {
    started = r
  })
  agent.tools.register(
    defineTool({
      name: "wait",
      description: "",
      parameters: {},
      execute: (_p, ctx) =>
        new Promise((resolve) => {
          started()
          ctx.signal.addEventListener("abort", () => resolve(textResult("stopped", true)))
        }),
    }),
    "test",
  )
  let calls = 0
  agent.interceptors.add("tool.call.after", () => {
    calls++
    return { action: "pass" }
  })
  const turn = agent.prompt("go")
  await running
  agent.abort()
  expect((await turn).reason).toBe("aborted")
  expect(calls).toBe(0)
})

test("a call that fails before running passes through tool.call.after too, as blocked", async () => {
  const { agent, mock } = setup([{ toolCalls: [{ name: "odd", args: {}, id: "o1" }] }, { text: "ok" }])
  const odd = defineTool({
    name: "odd",
    description: "",
    parameters: {},
    execute: async () => textResult("ran"),
  })
  // Once the call is on its way, checking its arguments throws: it cannot run.
  let armed = false
  Object.defineProperty(odd, "parameters", {
    get() {
      if (armed) throw new Error("bad schema")
      return {}
    },
  })
  agent.tools.register(odd, "test")
  agent.interceptors.add("tool.call.before", () => {
    armed = true
    return { action: "pass" }
  })
  const seen: (string | undefined)[] = []
  agent.interceptors.add("tool.call.after", (v) => {
    seen.push(v.rejected)
    armed = false
    const content = [...v.result.content, { type: "text" as const, text: "seen" }]
    return { action: "modify", value: { ...v, result: { ...v.result, content } } }
  })
  await agent.prompt("go")
  expect(seen).toEqual(["blocked"])
  expect(mock.requests[1]!.messages.at(-1)).toMatchObject({
    isError: true,
    content: [{ text: "Tool call failed before running: bad schema" }, { text: "seen" }],
  })
})
