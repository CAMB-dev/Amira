import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockReply, type ModelRequest } from "@amira/ai"
import { type AnyEvent, defineTool, RETURN_RESULT_TOOL, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { validateValue } from "../src/json-schema.ts"
import { AgentTree, SpawnError } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

function setup(reply: (req: ModelRequest) => MockReply, opts: { resultRetries?: number } = {}) {
  const mock = createMockDialect()
  for (let i = 0; i < 100; i++) mock.push(reply)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const tree = new AgentTree({ ai, sections: () => [{ name: "identity", text: "child" }], ...opts })
  const tools = new ToolRegistry()
  const root = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: process.cwd(),
    systemPrompt: "root",
    bus,
    tree,
    tools,
  })
  return { mock, bus, events, tree, tools, root }
}

const roleOf = (req: ModelRequest) => /ROLE (\w+)/.exec(req.systemPrompt)?.[1] ?? "root"
const lastText = (req: ModelRequest) => {
  const m = req.messages.at(-1)
  return m?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? ""
}
const findings = {
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1 },
    files: { type: "array", items: { type: "string" } },
    risk: { enum: ["low", "high"] },
  },
  required: ["summary", "files"],
  additionalProperties: false,
}

test("a child with a schema hands back a checked value through return_result, which ends its turn", async () => {
  const { tree, root, mock, bus, events } = setup((req) =>
    roleOf(req) === "a"
      ? { toolCalls: [{ name: RETURN_RESULT_TOOL, args: { summary: "two files", files: ["a.ts", "b.ts"] } }] }
      : { text: "unexpected" },
  )
  const child = tree.spawn(root, { prompt: "look", systemPrompt: "ROLE a", schema: findings })
  const r = await child.result()
  await bus.flush()
  expect(r.status).toBe("done")
  expect(r.value).toEqual({ summary: "two files", files: ["a.ts", "b.ts"] })
  expect(JSON.parse(r.text)).toEqual(r.value as object)
  expect(r.turns).toBeUndefined()
  // No model call after the result: the call ended the turn.
  const asked = mock.requests.filter((q) => roleOf(q) === "a")
  expect(asked).toHaveLength(1)
  // The tool is the schema itself, and the prompt says how to use it.
  const tool = asked[0]!.tools?.find((t) => t.name === RETURN_RESULT_TOOL)
  expect(tool?.parameters).toEqual(findings)
  expect(asked[0]!.systemPrompt).toContain(`calling the ${RETURN_RESULT_TOOL} tool`)
  expect(events.find((e) => e.type === "subagent.end")?.data).toMatchObject({ status: "done" })
  // The parent never sees the child's return_result.
  expect(root.tools.get(RETURN_RESULT_TOOL)).toBeUndefined()
})

test("a schema that is not an object's is taken as { value }", async () => {
  const { tree, root, mock } = setup(() => ({
    toolCalls: [{ name: RETURN_RESULT_TOOL, args: { value: [1, 2, 3] } }],
  }))
  const schema = { type: "array", items: { type: "integer" } }
  const r = await tree.spawn(root, { prompt: "count", schema }).result()
  expect(r).toMatchObject({ status: "done", value: [1, 2, 3] })
  const tool = mock.requests[0]!.tools?.find((t) => t.name === RETURN_RESULT_TOOL)
  expect(tool?.parameters).toEqual({ type: "object", properties: { value: schema }, required: ["value"] })
})

test("a value that does not fit is refused with the problems; a corrected call is taken", async () => {
  let calls = 0
  const { tree, root } = setup((req) => {
    calls++
    const last = req.messages.at(-1)
    if (last?.role === "toolResult" && last.isError) {
      return { toolCalls: [{ name: RETURN_RESULT_TOOL, args: { summary: "ok", files: [], risk: "low" } }] }
    }
    return { toolCalls: [{ name: RETURN_RESULT_TOOL, args: { summary: "", files: "a.ts", risk: "mid" } }] }
  })
  const child = tree.spawn(root, { prompt: "look", schema: findings })
  const r = await child.result()
  expect(r).toMatchObject({ status: "done", value: { summary: "ok", files: [], risk: "low" } })
  expect(calls).toBe(2)
})

test("a turn that ends without a result is asked again, and the child fails once the retries are spent", async () => {
  const { tree, root, mock } = setup(() => ({ text: "here is my answer in prose" }), { resultRetries: 2 })
  const r = await tree.spawn(root, { prompt: "look", schema: findings }).result()
  expect(r.status).toBe("error")
  expect(r.error).toContain("did not return a valid result after 3 attempts")
  expect(r.error).toContain(`without calling ${RETURN_RESULT_TOOL}`)
  expect(r.turns).toBe(3)
  // Two reminders, each shown as a notice.
  const reminders = mock.requests.slice(1).map(lastText)
  expect(reminders).toHaveLength(2)
  expect(reminders.every((t) => t.includes(`Call ${RETURN_RESULT_TOOL} now`))).toBe(true)
})

test("a reminder can bring the result in", async () => {
  const { tree, root } = setup((req) =>
    lastText(req).includes("You have not handed back")
      ? { toolCalls: [{ name: RETURN_RESULT_TOOL, args: { summary: "late", files: [] } }] }
      : { text: "prose" },
  )
  const r = await tree.spawn(root, { prompt: "look", schema: findings }).result()
  expect(r).toMatchObject({ status: "done", value: { summary: "late", files: [] }, turns: 2 })
})

test("calls that keep not fitting use up the attempts too", async () => {
  const { tree, root, mock } = setup(
    () => ({ toolCalls: [{ name: RETURN_RESULT_TOOL, args: { summary: 3 } }] }),
    {
      resultRetries: 1,
    },
  )
  const r = await tree.spawn(root, { prompt: "look", schema: findings }).result()
  expect(r.status).toBe("error")
  expect(r.error).toContain("after 2 attempts")
  // The tool's parameters are checked before it runs; the problems reach the error.
  expect(r.error).toContain('"summary" should be "string"')
  expect(mock.requests).toHaveLength(2)
})

test("return_result is never passed down, and a schema cannot go with persistent", async () => {
  const { tree, root, tools, mock } = setup((req) =>
    roleOf(req) === "outer"
      ? req.messages.at(-1)?.role === "toolResult"
        ? { toolCalls: [{ name: RETURN_RESULT_TOOL, args: { summary: "outer", files: [] } }] }
        : { toolCalls: [{ name: "sub", args: {} }] }
      : { text: "inner done" },
  )
  tools.register(
    defineTool({
      name: "sub",
      description: "sub",
      parameters: { type: "object", properties: {} },
      execute: async (_p, ctx) => {
        const r = await ctx.session!.spawn!({ prompt: "inner", systemPrompt: "ROLE inner" }).result()
        return textResult(r.text)
      },
    }),
    "t",
  )
  const r = await tree.spawn(root, { prompt: "go", systemPrompt: "ROLE outer", schema: findings }).result()
  expect(r).toMatchObject({ status: "done", value: { summary: "outer", files: [] } })
  const inner = mock.requests.find((q) => roleOf(q) === "inner")!
  expect(inner.tools?.some((t) => t.name === RETURN_RESULT_TOOL)).toBe(false)
  expect(() => tree.spawn(root, { prompt: "x", schema: findings, persistent: true })).toThrow(SpawnError)
})

test("validateValue reports where a value does not fit", () => {
  expect(validateValue(findings, { summary: "s", files: ["a"] })).toEqual([])
  expect(validateValue(findings, { files: [1], extra: true })).toEqual([
    'value is missing "summary"',
    "value.files[0] should be string, got integer",
    'value has an unexpected property "extra"',
  ])
  expect(validateValue({ type: "number", minimum: 0 }, -1)).toEqual(["value should be at least 0"])
  expect(validateValue({ anyOf: [{ type: "string" }, { type: "null" }] }, null)).toEqual([])
  expect(validateValue({ oneOf: [{ type: "number" }, { type: "integer" }] }, 2)[0]).toContain("more than one")
  expect(validateValue({ type: "string", pattern: "^a" }, "b")).toEqual(["value should match /^a/"])
})

test("each failed attempt counts once: a bad call and then prose in one turn is one attempt", async () => {
  const { tree, root, mock } = setup(
    (req) =>
      req.messages.at(-1)?.role === "toolResult"
        ? { text: "never mind, here it is in prose" }
        : { toolCalls: [{ name: RETURN_RESULT_TOOL, args: { summary: 3 } }] },
    { resultRetries: 2 },
  )
  const r = await tree.spawn(root, { prompt: "look", schema: findings }).result()
  expect(r.status).toBe("error")
  expect(r.error).toContain("after 3 attempts")
  expect(r.error).toContain('"summary" should be "string"')
  // Asked again exactly resultRetries times.
  expect(r.turns).toBe(3)
  expect(
    mock.requests.map(lastText).filter((t) => t.includes(`Call ${RETURN_RESULT_TOOL} now`)),
  ).toHaveLength(2)
})

test("a reminder turn that fails ends the child without anything sent again later", async () => {
  const { tree, root, mock, bus, events } = setup((req) =>
    lastText(req).includes("You have not handed back") ? { error: { message: "boom" } } : { text: "prose" },
  )
  const r = await tree.spawn(root, { prompt: "look", schema: findings }).result()
  expect(r).toMatchObject({ status: "error", error: "boom" })
  await Bun.sleep(30)
  await bus.flush()
  expect(events.some((e) => e.type === "notice.retry")).toBe(false)
  expect(mock.requests).toHaveLength(2)
  const end = events.findIndex((e) => e.type === "subagent.end")
  expect(events.slice(end).some((e) => e.type === "turn.start")).toBe(false)
})
