import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { EventBus } from "../src/event-bus.ts"
import { resolveToolName } from "../src/tool-names.ts"

const names = ["read_file", "write", "edit", "bash", "grep", "glob", "web_search"]

test("resolves names in order: exact, case, separators, then a close unambiguous match", () => {
  expect(resolveToolName("write", names)).toBe("write")
  expect(resolveToolName("Bash", names)).toBe("bash")
  expect(resolveToolName("readFile", names)).toBe("read_file")
  expect(resolveToolName("read-file", names)).toBe("read_file")
  expect(resolveToolName("WebSearch", names)).toBe("web_search")
  expect(resolveToolName("web_serch", names)).toBe("web_search")
  expect(resolveToolName("raed_file", names)).toBe("read_file")
})

test("refuses to guess when the match is ambiguous or too far", () => {
  // grep and grip are both one edit away from "grap".
  expect(resolveToolName("grap", ["grep", "grip"])).toBeUndefined()
  expect(resolveToolName("delete", names)).toBeUndefined()
  expect(resolveToolName("ed", names)).toBeUndefined()
  expect(resolveToolName("read", ["Read", "READ"])).toBeUndefined()
  expect(resolveToolName("read", ["read-x", "read_y"])).toBeUndefined()
  expect(resolveToolName("x", [])).toBeUndefined()
})

function setup(steps: MockStep[], retry = { retries: 0, baseDelayMs: 1 }) {
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }], retry })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const agent = new Agent({ ai, model: ai.model("mock/test"), cwd: process.cwd(), systemPrompt: "sys", bus })
  agent.tools.register(
    defineTool<{ path: string }>({
      name: "read_file",
      description: "read",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      execute: async (p) => textResult(`read ${p.path}`),
    }),
    "test",
  )
  return { agent, mock, bus, events }
}

test("a misspelled tool name runs the tool it meant, and history uses the real name", async () => {
  const { agent, bus, events } = setup([
    { toolCalls: [{ name: "ReadFile", args: { path: "a" }, id: "c1" }] },
    { text: "ok" },
  ])
  await agent.prompt("go")
  await bus.flush()
  const result = agent.messages[2]
  expect(result).toMatchObject({ role: "toolResult", toolName: "read_file", isError: false })
  expect(agent.messages[1]!.content[0]).toMatchObject({ type: "toolCall", name: "read_file" })
  const end = events.find((e) => e.type === "tool.execute.end")
  expect(end?.data).toMatchObject({ name: "read_file" })
})

test("an unknown tool is still reported as unknown", async () => {
  const { agent } = setup([{ toolCalls: [{ name: "launch_rocket", args: {}, id: "c1" }] }, { text: "ok" }])
  await agent.prompt("go")
  expect(agent.messages[2]).toMatchObject({ role: "toolResult", isError: true })
  expect(JSON.stringify(agent.messages[2])).toContain('Unknown tool \\"launch_rocket\\"')
})

test("retries show up as a status reason that clears when the reply streams", async () => {
  const { agent, bus, events } = setup(
    [{ error: { message: "HTTP 503: busy", retryable: true } }, { text: "hello" }],
    { retries: 3, baseDelayMs: 1 },
  )
  const r = await agent.prompt("go")
  await bus.flush()
  expect(r.reason).toBe("done")
  const statuses = events
    .filter((e) => e.type === "status.changed")
    .map((e) => (e.type === "status.changed" ? [e.data.status, e.data.reason] : []))
  expect(statuses).toEqual([
    ["working", undefined],
    ["working", "retrying (1/3)"],
    ["working", undefined],
    ["idle", undefined],
  ])
})
