import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import type { AnyEvent, ToolResultMessage } from "@amira/api"
import {
  Agent,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  TOOL_SEARCH,
  ToolRegistry,
  toolSearchExtension,
} from "@amira/core"
import { McpClient } from "../src/client.ts"
import type { ServerConfig } from "../src/config.ts"
import { HttpTransport } from "../src/http.ts"
import { createMcpExtension, type McpExtensionOptions } from "../src/index.ts"
import { StdioTransport, setPipeWorkerUrl } from "../src/stdio.ts"
import { startHttpServer } from "./fixtures/server.ts"

const FIXTURE = path.join(import.meta.dir, "fixtures", "server.ts")
// Spawning can stall for seconds on machines with aggressive antivirus.
const SLOW = 60_000

const http = startHttpServer(false)
const httpSse = startHttpServer(true)
afterAll(() => {
  http.stop()
  httpSse.stop()
})

function stdioServer(name: string, extra: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name,
    source: "test",
    type: "stdio",
    command: process.execPath,
    args: [FIXTURE, "stdio"],
    env: { FIXTURE_SECRET: "s3cret" },
    ...extra,
  } as ServerConfig
}

function httpServer(name: string, url: string, headers: Record<string, string> = {}): ServerConfig {
  return { name, source: "test", type: "http", url, headers }
}

async function harness(servers: ServerConfig[], steps: MockStep[] = [], opts: McpExtensionOptions = {}) {
  const mock = createMockDialect(steps)
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors, tools, cwd: import.meta.dir })
  await host.load(toolSearchExtension, "builtin:tool-search")
  const mcp = createMcpExtension({ config: { servers, problems: [] }, ...opts })
  expect(await host.load(mcp, "builtin:mcp")).toBe(true)
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd: import.meta.dir,
    systemPrompt: "sys",
    bus,
    interceptors,
    tools,
  })
  const errors = async () => {
    await bus.flush()
    return events.flatMap((e) => (e.type === "extension.error" ? [e.data.error] : []))
  }
  return { agent, mock, tools, mcp, errors }
}

/**
 * The rejection message. `expect(p).rejects` is avoided on purpose: while it waits, bun test
 * does not deliver worker messages, so replies from the pipe worker arrive only afterwards.
 */
function failure(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "(resolved)",
    (e) => (e instanceof Error ? e.message : String(e)),
  )
}

function resultText(m: ToolResultMessage | undefined): string {
  return (m?.content ?? []).map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`)).join("|")
}

function toolResults(agent: Agent): ToolResultMessage[] {
  return agent.messages.filter((m): m is ToolResultMessage => m.role === "toolResult")
}

test(
  "stdio: handshake, paginated listing, calls and server pings, off the main thread",
  async () => {
    let last = performance.now()
    let maxGap = 0
    const ticker = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 5)
    const t = new StdioTransport({
      argv: [process.execPath, FIXTURE, "stdio"],
      cwd: import.meta.dir,
      env: {},
    })
    const client = new McpClient(t)
    await client.connect({ timeoutMs: SLOW })
    clearInterval(ticker)
    // The spawn happened in the pipe worker; the main thread kept ticking.
    expect(maxGap).toBeLessThan(1000)
    expect(client.serverInfo).toEqual({ name: "fixture", version: "1.0.0" })
    const tools = await client.listTools({ timeoutMs: 5000 })
    expect(tools.length).toBe(13)
    expect(await client.callTool("echo", { text: "hi" }, { timeoutMs: 5000 })).toEqual({
      content: [{ type: "text", text: "echo: hi" }],
    })
    expect(await client.callTool("pinged", {}, { timeoutMs: 5000 })).toEqual({
      content: [{ type: "text", text: "true" }],
    })
    expect(await failure(client.callTool("nope", {}, { timeoutMs: 5000 }))).toContain("unknown tool nope")
    await client.close()
    expect(await failure(client.callTool("echo", { text: "x" }, { timeoutMs: 5000 }))).toContain(
      "connection closed",
    )
  },
  SLOW,
)

test(
  "tools are registered deferred as mcp__<server>__<tool> and found through tool_search",
  async () => {
    const { agent, mock, tools, mcp, errors } = await harness(
      [stdioServer("fx")],
      [
        {
          toolCalls: [{ id: "c1", name: TOOL_SEARCH, args: { names: ["mcp__fx__echo", "mcp__fx__image"] } }],
        },
        {
          toolCalls: [
            { id: "c2", name: "mcp__fx__echo", args: { text: "yo" } },
            { id: "c3", name: "mcp__fx__image", args: {} },
            { id: "c4", name: "mcp__fx__fail", args: {} },
            { id: "c5", name: "mcp__fx__env", args: { name: "FIXTURE_SECRET" } },
          ],
        },
        { text: "done" },
      ],
    )
    await mcp.settled()
    expect(await errors()).toEqual([])
    expect(mcp.servers()[0]).toMatchObject({ name: "fx", state: "ready" })
    expect(tools.deferred().map((t) => t.name)).toContain("mcp__fx__my_dotted_tool")
    expect(tools.get("mcp__fx__add")?.concurrency).toBe("parallel")
    expect(tools.get("mcp__fx__echo")?.concurrency).toBe("serial")

    await agent.prompt("use the fixture")
    const [first, second] = mock.requests
    expect(first!.tools.map((t) => t.name)).toEqual([TOOL_SEARCH])
    expect(first!.systemPrompt).toContain("- mcp__fx__echo: Echoes the text back.")
    expect(second!.tools.map((t) => t.name)).toEqual([TOOL_SEARCH, "mcp__fx__echo", "mcp__fx__image"])
    const [search, echo, image, fail, env] = toolResults(agent)
    expect(resultText(search)).toContain("## mcp__fx__echo")
    expect(resultText(echo)).toBe("echo: yo")
    expect(image!.content).toEqual([
      { type: "text", text: "a pixel" },
      { type: "image", mimeType: "image/png", data: expect.any(String) },
    ])
    expect(fail).toMatchObject({ isError: true, content: [{ type: "text", text: "it failed" }] })
    expect(resultText(env)).toBe("s3cret")
    await mcp.close()
    expect(tools.deferred()).toEqual([])
  },
  SLOW,
)

test(
  "servers outlive a session's end, so later sessions keep their tools",
  async () => {
    const { agent, tools, mcp } = await harness([stdioServer("fx")])
    await mcp.settled()
    agent.bus.emit("session.end", { reason: "exit" }, { sessionId: agent.sessionId })
    await agent.bus.flush()
    await new Promise((r) => setTimeout(r, 50))
    expect(mcp.servers()[0]).toMatchObject({ state: "ready" })
    expect(tools.get("mcp__fx__echo")).toBeDefined()
    await mcp.close()
  },
  SLOW,
)

test(
  "a tool call that times out is cancelled on the server",
  async () => {
    const { agent, mcp } = await harness(
      [stdioServer("fx", { timeoutMs: 300 })],
      [
        { toolCalls: [{ id: "c1", name: "mcp__fx__slow", args: { ms: 3000 } }] },
        { toolCalls: [{ id: "c2", name: "mcp__fx__cancelled", args: {} }] },
        { text: "done" },
      ],
    )
    await mcp.settled()
    await agent.prompt("go")
    const [slow, cancelled] = toolResults(agent)
    expect(slow).toMatchObject({ isError: true })
    expect(resultText(slow)).toContain("tools/call timed out after 300ms")
    expect(JSON.parse(resultText(cancelled)).length).toBe(1)
    await mcp.close()
  },
  SLOW,
)

test(
  "aborting a turn cancels the running MCP call",
  async () => {
    const { agent, mock, mcp } = await harness(
      [stdioServer("fx")],
      [{ toolCalls: [{ id: "c1", name: "mcp__fx__slow", args: { ms: 10_000 } }] }],
    )
    await mcp.settled()
    const started = performance.now()
    const turn = agent.prompt("go")
    setTimeout(() => agent.abort(), 300)
    expect((await turn).reason).toBe("aborted")
    expect(performance.now() - started).toBeLessThan(5000)
    mock.push({ toolCalls: [{ id: "c2", name: "mcp__fx__cancelled", args: {} }] }, { text: "ok" })
    await agent.prompt("which were cancelled?")
    expect(JSON.parse(resultText(toolResults(agent).at(-1))).length).toBe(1)
    await mcp.close()
  },
  SLOW,
)

test(
  "a failing server is reported without affecting the others; a crash unregisters its tools",
  async () => {
    const { agent, tools, mcp, errors } = await harness(
      [
        stdioServer("broken", { command: "amira-no-such-command-xyz", args: [] }),
        stdioServer("fx"),
        httpServer("nohttp", "http://127.0.0.1:9/mcp"),
      ],
      [{ toolCalls: [{ id: "c1", name: "mcp__fx__crash", args: {} }] }, { text: "ok" }],
    )
    await mcp.settled()
    const states = Object.fromEntries(mcp.servers().map((s) => [s.name, s.state]))
    expect(states).toEqual({ broken: "failed", fx: "ready", nohttp: "failed" })
    const errs = await errors()
    expect(errs.length).toBe(2)
    expect(errs.find((e) => e.includes('"broken"'))).toContain("could not start amira-no-such-command-xyz")
    expect(errs.find((e) => e.includes('"nohttp"'))).toBeDefined()
    expect(tools.get("mcp__fx__echo")).toBeDefined()

    await agent.prompt("crash it")
    expect(toolResults(agent)[0]).toMatchObject({ isError: true })
    for (let i = 0; i < 100 && mcp.servers()[1]!.state === "ready"; i++) await Bun.sleep(50)
    expect(mcp.servers()[1]!.state).toBe("failed")
    expect(tools.get("mcp__fx__echo")).toBeUndefined()
    const lost = (await errors()).find((e) => e.includes('"fx"'))
    expect(lost).toContain("disconnected")
    expect(lost).toContain("crashing on purpose")
    await mcp.close()
  },
  SLOW,
)

test(
  "tools/list_changed re-registers the server's tools",
  async () => {
    const { agent, tools, mcp } = await harness(
      [stdioServer("fx")],
      [{ toolCalls: [{ id: "c1", name: "mcp__fx__change_tools", args: {} }] }, { text: "ok" }],
    )
    await mcp.settled()
    expect(tools.get("mcp__fx__extra")).toBeUndefined()
    await agent.prompt("go")
    for (let i = 0; i < 100 && !tools.get("mcp__fx__extra"); i++) await Bun.sleep(20)
    expect(tools.get("mcp__fx__extra")?.exposure).toBe("deferred")
    await mcp.close()
  },
  SLOW,
)

test("streamable HTTP with JSON and with SSE replies, including notifications in the stream", async () => {
  const { agent, tools, mcp, errors } = await harness(
    [httpServer("plain", http.url), httpServer("sse", httpSse.url)],
    [
      {
        toolCalls: [
          { id: "c1", name: "mcp__plain__add", args: { a: 2, b: 3 } },
          { id: "c2", name: "mcp__sse__resources", args: {} },
          { id: "c3", name: "mcp__sse__structured", args: {} },
          { id: "c4", name: "mcp__sse__change_tools", args: {} },
          { id: "c5", name: "mcp__plain__pinged", args: {} },
        ],
      },
      { text: "ok" },
    ],
  )
  await mcp.settled()
  expect(await errors()).toEqual([])
  await agent.prompt("go")
  const [add, resources, structured] = toolResults(agent)
  expect(resultText(add)).toBe("5")
  expect(resultText(resources)).toBe(
    "Resource file:///a.txt:\nfile body|Resource: file:///b.bin (b.bin, application/octet-stream)|[audio audio/wav, 3 bytes, not shown]",
  )
  expect(JSON.parse(resultText(structured))).toEqual({ value: 42 })
  for (let i = 0; i < 100 && !tools.get("mcp__sse__extra"); i++) await Bun.sleep(20)
  expect(tools.get("mcp__sse__extra")).toBeDefined()
  await mcp.close()
})

test("HTTP errors fail the connection with the status; headers are sent", async () => {
  const good = new McpClient(
    new HttpTransport(`${http.url}?token=required`, { authorization: "Bearer secret" }),
  )
  await good.connect({ timeoutMs: 5000 })
  expect((await good.listTools({ timeoutMs: 5000 })).length).toBe(13)
  await good.close()
  const bad = new McpClient(new HttpTransport(`${http.url}?token=required`))
  expect(await failure(bad.connect({ timeoutMs: 5000 }))).toContain("HTTP 401")
})

test("an HTTP request is abortable", async () => {
  const client = new McpClient(new HttpTransport(httpSse.url))
  await client.connect({ timeoutMs: 5000 })
  const abort = new AbortController()
  const call = client.callTool("slow", { ms: 5000 }, { timeoutMs: 10_000, signal: abort.signal })
  setTimeout(() => abort.abort(), 100)
  expect(await failure(call)).toContain("aborted")
  const listed = await client.callTool("cancelled", {}, { timeoutMs: 5000 })
  expect(JSON.stringify(listed)).toContain("[2]")
  await client.close()
})

test(
  "a model call right after startup waits briefly for connecting servers",
  async () => {
    const { agent, mock, mcp } = await harness([stdioServer("fx")], [{ text: "a" }])
    // No settled(): the background connect has not even started yet.
    await agent.prompt("go")
    expect(mock.requests[0]!.systemPrompt).toContain("- mcp__fx__echo:")
    expect(mock.requests[0]!.systemPrompt).not.toContain("Still connecting")
    expect(mock.requests[0]!.tools.map((t) => t.name)).toEqual([TOOL_SEARCH])
    await mcp.close()
  },
  SLOW,
)

test(
  "past the startup wait, the model is told which servers are still connecting",
  async () => {
    const { agent, mock, mcp } = await harness([stdioServer("fx")], [{ text: "a" }], { startupWaitMs: 0 })
    await agent.prompt("go")
    expect(mock.requests[0]!.systemPrompt).toContain("# MCP servers\nStill connecting: fx.")
    await mcp.settled()
    mock.push({ text: "b" })
    await agent.prompt("again")
    expect(mock.requests[1]!.systemPrompt).not.toContain("Still connecting")
    await mcp.close()
  },
  SLOW,
)

test(
  "falls back to spawning on the main thread when the pipe worker cannot load",
  async () => {
    setPipeWorkerUrl(new URL("./fixtures/missing-worker.ts", import.meta.url).href)
    try {
      const client = new McpClient(
        new StdioTransport({ argv: [process.execPath, FIXTURE, "stdio"], cwd: import.meta.dir, env: {} }),
      )
      await client.connect({ timeoutMs: SLOW })
      expect(await client.callTool("echo", { text: "inline" }, { timeoutMs: 5000 })).toEqual({
        content: [{ type: "text", text: "echo: inline" }],
      })
      await client.close()
    } finally {
      setPipeWorkerUrl()
    }
  },
  SLOW,
)
