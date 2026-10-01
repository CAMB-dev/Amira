import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type AnyEvent, defineTool, textResult } from "@amira/api"
import { createAi, createMockDialect, type MockStep } from "../../../packages/ai/src/index.ts"
import { Agent, EventBus, SessionStore, ToolRegistry } from "../../../packages/core/src/index.ts"
import { searchDeferred, TOOL_SEARCH, toolSearchTool } from "../src/tool-search.ts"

function setup(steps: MockStep[], tools = new ToolRegistry()) {
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: process.cwd(),
    systemPrompt: "sys",
    tools,
  })
  return { agent, mock }
}

const deferredTool = (name: string, description: string) =>
  defineTool<{ x: number }>({
    name,
    description,
    exposure: "deferred",
    parameters: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
    execute: async (p) => textResult(`${name}: ${p.x}`),
  })

const plain = defineTool({
  name: "plain",
  description: "always there",
  parameters: { type: "object" },
  execute: async () => textResult("ok"),
})

function registry() {
  const tools = new ToolRegistry()
  tools.register(plain, "test")
  tools.register(toolSearchTool, "test")
  tools.register(deferredTool("mcp__math__add", "Adds numbers.\nMore detail here."), "test")
  tools.register(deferredTool("mcp__web__fetch", "Fetches a web page."), "test")
  return tools
}

test("deferred tools are hidden from the tool list but named in the system prompt", async () => {
  const { agent, mock } = setup([{ text: "hi" }], registry())
  await agent.prompt("go")
  const req = mock.requests[0]!
  expect(req.tools.map((t) => t.name)).toEqual(["plain", TOOL_SEARCH])
  expect(req.systemPrompt.startsWith("sys\n\n# Deferred tools\n")).toBe(true)
  expect(req.systemPrompt).toContain("- mcp__math__add: Adds numbers.\n")
  expect(req.systemPrompt).not.toContain("More detail")
  expect(req.systemPrompt).toContain("- mcp__web__fetch: Fetches a web page.")
})

test("disabled deferred tools are left out of the listing", async () => {
  const tools = registry()
  tools.setDisabled(["mcp__web__fetch"])
  const { agent, mock } = setup([{ text: "hi" }], tools)
  await agent.prompt("go")
  expect(mock.requests[0]!.systemPrompt).toContain("- mcp__math__add:")
  expect(mock.requests[0]!.systemPrompt).not.toContain("mcp__web__fetch")
})

test("system.build sees the deferred-tools section, and tools registered meanwhile are listed", async () => {
  const tools = registry()
  const { agent, mock } = setup([{ text: "hi" }], tools)
  let seen = ""
  agent.interceptors.add("system.build", async (v) => {
    seen = v.sections.find((s) => s.name === "deferred-tools")?.text ?? ""
    tools.register(deferredTool("mcp__late__tool", "Registered while waiting."), "test")
    return { action: "pass" }
  })
  await agent.prompt("go")
  expect(seen).toContain("- mcp__math__add:")
  expect(seen).not.toContain("mcp__late__tool")
  expect(mock.requests[0]!.systemPrompt).toContain("- mcp__late__tool: Registered while waiting.")
})

test("without deferred tools there is no section and no tool_search", async () => {
  const tools = new ToolRegistry()
  tools.register(plain, "test")
  tools.register(toolSearchTool, "test")
  const { agent, mock } = setup([{ text: "hi" }], tools)
  await agent.prompt("go")
  expect(mock.requests[0]!.tools.map((t) => t.name)).toEqual(["plain"])
  expect(mock.requests[0]!.systemPrompt).toBe("sys")
})

test("tool_search loads tools for the next call and returns their schemas", async () => {
  const { agent, mock } = setup([
    { toolCalls: [{ id: "c1", name: TOOL_SEARCH, args: { query: "add" } }] },
    { toolCalls: [{ id: "c2", name: "mcp__math__add", args: { x: 2 } }] },
    { text: "done" },
  ])
  // Register after construction: the registry is live, not a snapshot.
  for (const { tool } of registry().all()) agent.tools.register(tool, "test")
  await agent.prompt("add something")
  const [first, second, third] = mock.requests
  expect(first!.tools.map((t) => t.name)).toEqual(["plain", TOOL_SEARCH])
  expect(second!.tools.map((t) => t.name)).toEqual(["plain", TOOL_SEARCH, "mcp__math__add"])
  expect(second!.tools[2]!.parameters).toEqual(agent.tools.get("mcp__math__add")!.parameters)
  const searchResult = second!.messages.at(-1)!
  expect(searchResult.role).toBe("toolResult")
  const text =
    searchResult.role === "toolResult" && searchResult.content[0]?.type === "text"
      ? searchResult.content[0].text
      : ""
  expect(text).toContain("## mcp__math__add")
  expect(text).toContain('"required": [\n    "x"\n  ]')
  expect(third!.messages.at(-1)).toMatchObject({
    role: "toolResult",
    content: [{ text: "mcp__math__add: 2" }],
  })
  expect(agent.loadedTools).toEqual(["mcp__math__add"])
  // The prompt listing stays stable after loading, so the prefix remains cacheable.
  expect(third!.systemPrompt).toBe(first!.systemPrompt)
})

test("loading is per session", async () => {
  const tools = registry()
  const a = setup(
    [{ toolCalls: [{ id: "c1", name: TOOL_SEARCH, args: { names: ["mcp__web__fetch"] } }] }, { text: "ok" }],
    tools,
  )
  const b = setup([{ text: "ok" }], tools)
  await a.agent.prompt("go")
  await b.agent.prompt("go")
  expect(a.mock.requests[1]!.tools.map((t) => t.name)).toContain("mcp__web__fetch")
  expect(b.mock.requests[0]!.tools.map((t) => t.name)).not.toContain("mcp__web__fetch")
})

test("unregistered tools drop out of the loaded set's offer", async () => {
  const tools = new ToolRegistry()
  const off = tools.register(deferredTool("gone", "temporary"), "test")
  const { agent, mock } = setup([{ text: "a" }, { text: "b" }], tools)
  expect(agent.loadTools(["gone", "missing", "gone"])).toEqual(["gone", "missing"])
  await agent.prompt("one")
  off()
  await agent.prompt("two")
  expect(mock.requests[0]!.tools.map((t) => t.name)).toEqual(["gone"])
  expect(mock.requests[1]!.tools).toEqual([])
  expect(mock.requests[1]!.systemPrompt).toBe("sys")
})

test("tools loaded before they register are offered once they do", async () => {
  const tools = new ToolRegistry()
  tools.register({ ...deferredTool("active_one", "x"), exposure: "active" }, "test")
  const { agent, mock } = setup([{ text: "a" }, { text: "b" }], tools)
  expect(agent.loadTools(["mcp__fx__add", "active_one"])).toEqual(["mcp__fx__add"])
  await agent.prompt("one")
  tools.register(deferredTool("mcp__fx__add", "adds"), "mcp")
  await agent.prompt("two")
  expect(mock.requests[0]!.tools.map((t) => t.name)).toEqual(["active_one"])
  expect(mock.requests[1]!.tools.map((t) => t.name)).toEqual(["active_one", "mcp__fx__add"])
  expect(agent.loadedTools).toEqual(["mcp__fx__add"])
})

test("tool_search reports misses with the available names", async () => {
  const { agent, mock } = setup(
    [{ toolCalls: [{ id: "c1", name: TOOL_SEARCH, args: { query: "zebra" } }] }, { text: "ok" }],
    registry(),
  )
  await agent.prompt("go")
  const last = mock.requests[1]!.messages.at(-1)!
  expect(last).toMatchObject({ role: "toolResult", isError: true })
  expect(JSON.stringify(last)).toContain("mcp__math__add, mcp__web__fetch")
  expect(agent.loadedTools).toEqual([])
})

test("searchDeferred ranks name hits over description hits and honours select:", () => {
  const info = (name: string, description: string) => ({ name, description, parameters: {}, loaded: false })
  const tools = [
    info("alpha", "works with web pages"),
    info("web_get", "gets things"),
    info("other", "nothing"),
  ]
  expect(searchDeferred(tools, "web", 5).map((t) => t.name)).toEqual(["web_get", "alpha"])
  expect(searchDeferred(tools, "web", 1).map((t) => t.name)).toEqual(["web_get"])
  expect(searchDeferred(tools, "select:other, ALPHA,nope", 5).map((t) => t.name)).toEqual(["other", "alpha"])
  expect(searchDeferred(tools, "Other", 5).map((t) => t.name)).toEqual(["other"])
})

async function storedSession(steps: MockStep[], tools: ToolRegistry) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-deferred-"))
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const session = SessionStore.create({ cwd: "/proj", dir })
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: "/proj",
    systemPrompt: "",
    tools,
    session,
  })
  return { agent, ai, session }
}

function resume(ai: ReturnType<typeof createAi>, file: string, tools: ToolRegistry) {
  const mock = createMockDialect([{ text: "again" }])
  ai.registerDialect(mock)
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: "/proj",
    tools,
    bus,
    session: SessionStore.open(file),
  })
  return { agent, mock, bus, events }
}

test("tools loaded with tool_search are offered again after resuming the session", async () => {
  const { agent, ai, session } = await storedSession(
    [{ toolCalls: [{ name: TOOL_SEARCH, args: { names: ["mcp__math__add"] } }] }, { text: "loaded" }],
    registry(),
  )
  await agent.prompt("load it")
  expect(agent.loadedTools).toEqual(["mcp__math__add"])

  const resumed = resume(ai, session.file, registry())
  expect(resumed.agent.loadedTools).toEqual(["mcp__math__add"])
  await resumed.agent.prompt("use it")
  await resumed.bus.flush()
  expect(resumed.mock.requests[0]!.tools.map((t) => t.name)).toEqual(["plain", TOOL_SEARCH, "mcp__math__add"])
  expect(resumed.events.filter((e) => e.type === "extension.error")).toEqual([])
})

test("a restored tool that no longer exists is dropped with a note", async () => {
  const { agent, ai, session } = await storedSession(
    [{ toolCalls: [{ name: TOOL_SEARCH, args: { names: ["mcp__web__fetch"] } }] }, { text: "loaded" }],
    registry(),
  )
  await agent.prompt("load it")
  const tools = new ToolRegistry()
  tools.register(plain, "test")
  const resumed = resume(ai, session.file, tools)
  await resumed.agent.prompt("go")
  await resumed.bus.flush()
  expect(resumed.agent.loadedTools).toEqual([])
  expect(resumed.events.filter((e) => e.type === "extension.error").map((e) => e.data)).toEqual([
    {
      source: "session",
      error: "tools loaded earlier in this session are no longer available: mcp__web__fetch",
    },
  ])
})
