import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, type StreamEvent } from "../../packages/ai/src/index.ts"
import { type AnyEvent, defineTool, type ToolResult, textResult } from "../../packages/api/src/index.ts"
import { readCatalogCache } from "../../packages/cli/src/catalog.ts"
import {
  Agent,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  loadSettings,
  providersFromSettings,
  ToolRegistry,
} from "../../packages/core/src/index.ts"
import fixtureExtension from "./fixture-extension.ts"
import {
  createProvider,
  type Scenario,
  type ScriptedProvider,
  type ScriptedReply,
  setupFixtures,
} from "./provider.ts"

const directories: string[] = []
const providers: ScriptedProvider[] = []
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.stop()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function temporary() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amira-ui-walk-test-"))
  directories.push(directory)
  return directory
}

async function scripted(routes: Record<string, ScriptedReply[]>, token?: string) {
  const directory = await temporary()
  const file = path.join(directory, "scenario.json")
  const scenario: Scenario = { name: "test", description: "Local provider test", prompt: "go", routes }
  await writeFile(file, JSON.stringify(scenario))
  const provider = await createProvider(file, token)
  providers.push(provider)
  return provider
}

function client(provider: ScriptedProvider, retries = 0) {
  return createAi({
    providers: [
      {
        id: "ui-walk",
        dialect: "openai-chat",
        baseUrl: provider.baseUrl,
        headers: { Authorization: `Bearer ${provider.token}` },
      },
    ],
    retry: { retries, baseDelayMs: 1, maxDelayMs: 4 },
  })
}

async function completion(
  provider: ScriptedProvider,
  model = "main",
  systemPrompt = "[ui-walk-fixtures]",
  retries = 0,
) {
  const ai = client(provider, retries)
  const events: StreamEvent[] = []
  for await (const event of ai.stream({
    model: ai.model(`ui-walk/${model}`),
    systemPrompt,
    messages: [],
    tools: [],
  })) {
    events.push(event)
  }
  return events
}

async function post(provider: ScriptedProvider, model = "main", system = "[ui-walk-fixtures]") {
  return fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${provider.token}` },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "system", content: system }] }),
  })
}

test("provider authenticates every endpoint before parsing or advancing scripted cursors", async () => {
  const token = "test-session-secret"
  const provider = await scripted({ main: [{ text: "First reply" }, { text: "Second reply" }] }, token)
  for (const authorization of [undefined, "Bearer wrong-secret", token]) {
    for (const [endpoint, body] of [
      ["/models", undefined],
      ["/chat/completions", "not-json"],
      ["/chat/completions", JSON.stringify({ model: "unknown", messages: [] })],
      ["/chat/completions", JSON.stringify({ model: "main", messages: [] })],
    ]) {
      const response = await fetch(`${provider.baseUrl}${endpoint}`, {
        method: body === undefined ? "GET" : "POST",
        headers: authorization ? { Authorization: authorization } : {},
        ...(body === undefined ? {} : { body }),
      })
      expect([401, 403]).toContain(response.status)
      expect(provider.requests).toHaveLength(0)
    }
  }
  expect(provider.token).toBe(token)
  const first = await post(provider)
  expect(first.status).toBe(200)
  expect(await first.text()).toContain("First reply")
  const rejected = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong-secret" },
    body: JSON.stringify({ model: "main", messages: [] }),
  })
  expect([401, 403]).toContain(rejected.status)
  expect(provider.requests.map((request) => request.step)).toEqual([0])
  const second = await post(provider)
  expect(second.status).toBe(200)
  expect(await second.text()).toContain("Second reply")
  expect(provider.requests.map((request) => request.step)).toEqual([0, 1])
})

test("streams thinking, Unicode text, tool argument fragments and usage through the normal dialect", async () => {
  const provider = await scripted({
    main: [
      {
        thinking: "Inspect the fixture.",
        text: "## Hello, Zoë 李明\n",
        chunkSize: 2,
        toolCalls: [{ id: "read-1", name: "read", args: { path: "src/李明.ts", offset: 2 } }],
      },
    ],
  })
  const events = await completion(provider)
  expect(events.filter((event) => event.type === "text.delta").length).toBeGreaterThan(2)
  expect(events.some((event) => event.type === "thinking.start")).toBe(true)
  expect(events.some((event) => event.type === "thinking.end")).toBe(true)
  const done = events.at(-1)
  expect(done?.type).toBe("done")
  if (done?.type !== "done") throw new Error("Expected a complete streamed reply")
  expect(done.message.content).toEqual([
    { type: "thinking", text: "Inspect the fixture." },
    { type: "text", text: "## Hello, Zoë 李明\n" },
    { type: "toolCall", id: "read-1", name: "read", args: { path: "src/李明.ts", offset: 2 } },
  ])
  expect(done.message.stopReason).toBe("toolUse")
  expect(done.message.usage?.input).toBe(512)
  expect(provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
  expect(provider.requests).toHaveLength(1)
})

test("normal retries consume scripted failures then recover", async () => {
  const provider = await scripted({
    main: [
      { error: { status: 429, message: "fixture rate limit", retryAfter: 0 } },
      { error: { status: 503, message: "fixture unavailable" } },
      { text: "Recovered locally." },
    ],
  })
  const events = await completion(provider, "main", "", 2)
  expect(events.filter((event) => event.type === "retry")).toHaveLength(2)
  expect(events.at(-1)?.type).toBe("done")
  expect(provider.requests.map((request) => request.step)).toEqual([0, 1, 2])
})

test("a stream-body error retains partial text and does not retry an invalid request", async () => {
  const provider = await scripted({
    main: [
      {
        text: "Partial reply",
        streamError: { message: "fixture invalid request", code: "invalid_request_error" },
      },
    ],
  })
  const events = await completion(provider, "main", "", 2)
  const error = events.at(-1)
  expect(error?.type).toBe("error")
  if (error?.type !== "error") throw new Error("Expected a stream error")
  expect(error.retryable).toBe(false)
  expect(error.message.content).toEqual([{ type: "text", text: "Partial reply" }])
  expect(provider.requests).toHaveLength(1)
})

test("concurrent children have independent cursors and cannot consume the commander's script", async () => {
  const provider = await scripted({
    main: [{ text: "Commander" }],
    child: [{ text: "Child first" }, { text: "Child second" }],
  })
  const [a, b] = await Promise.all([
    completion(provider, "main", "[ui-walk-child:a]"),
    completion(provider, "main", "[ui-walk-child:b]"),
  ])
  for (const events of [a, b]) {
    const done = events.at(-1)
    expect(done?.type === "done" && done.message.content).toEqual([{ type: "text", text: "Child first" }])
  }
  await completion(provider, "main", "[ui-walk-child:a]")
  await completion(provider)
  expect(provider.requests.map(({ route, step }) => [route, step])).toEqual([
    ["child", 0],
    ["child", 0],
    ["child", 1],
    ["main", 0],
  ])
})

test("tools fail closed without fixture hooks and bad requests do not advance the script", async () => {
  const provider = await scripted({
    main: [{ toolCalls: [{ id: "call-1", name: "bash", args: { command: "never-run" } }] }],
  })
  expect((await post(provider, "main", "")).status).toBe(400)
  expect((await post(provider, "unknown")).status).toBe(404)
  expect(
    (await fetch(`${provider.baseUrl}/models`, { headers: { Authorization: `Bearer ${provider.token}` } }))
      .status,
  ).toBe(404)
  expect(provider.requests).toHaveLength(0)
  const valid = await post(provider)
  expect(valid.headers.get("content-type")).toBe("text/event-stream")
  expect(await valid.text()).toContain("never-run")
  expect(provider.requests[0]?.step).toBe(0)
})

test("setup writes only an isolated home with normal provider settings and a fresh offline catalog", async () => {
  const provider = await scripted({ main: [{ text: "Fixture" }] })
  const directory = await temporary()
  const home = path.join(directory, "home")
  const cwd = path.join(directory, "work")
  const setup = await setupFixtures(home, cwd, provider, "light")
  const loaded = loadSettings({ home, cwd })
  expect(loaded.warnings).toEqual([])
  expect(loaded.settings.model).toBe("ui-walk/main")
  expect(providersFromSettings(loaded.settings.providers)[0]?.baseUrl).toBe(provider.baseUrl)
  expect(loaded.settings.providers?.["ui-walk"]?.headers).toEqual({
    Authorization: `Bearer ${provider.token}`,
  })
  expect(providersFromSettings(loaded.settings.providers)[0]?.headers).toEqual({
    Authorization: `Bearer ${provider.token}`,
  })
  expect(loaded.settings.tui?.theme).toBe("light")
  expect(loaded.settings.sessions?.autoTitle).toBe(false)
  expect(setup.args).toEqual(["--no-packages", "--extension", setup.extensionPath, "--cwd", cwd])
  expect(setup.env.AMIRA_HOME).toBe(home)
  expect(setup.env.HOME).toBe(path.join(home, "user"))
  expect(setup.env.USERPROFILE).toBe(setup.env.HOME)
  expect(Object.keys(setup.env).filter((key) => /^AMIRA_|API_KEY|TOKEN|SECRET|PROXY/i.test(key))).toEqual([
    "AMIRA_HOME",
    "NO_PROXY",
  ])
  const cached = await readCatalogCache({ file: path.join(home, "cache", "models.json") })
  expect(cached.stale).toBe(false)
  expect(cached.catalog?.providers?.()).toEqual([])
  expect(await readFile(setup.extensionPath, "utf8")).toContain("tool.call.before")
})

test("setup refuses non-temporary paths and existing project configuration", async () => {
  const provider = await scripted({ main: [{ text: "Fixture" }] })
  const directory = await temporary()
  await expect(setupFixtures(path.parse(directory).root, directory, provider)).rejects.toThrow("temporary")
  const cwd = path.join(directory, "work")
  await mkdir(path.join(cwd, ".amira"), { recursive: true })
  const existing = path.join(cwd, ".amira", "settings.json")
  await writeFile(existing, '{"model":"must-not-be-read-as-settings"}')
  await expect(setupFixtures(path.join(directory, "home"), cwd, provider)).rejects.toThrow(
    "existing configuration",
  )
  expect(await readFile(existing, "utf8")).toBe('{"model":"must-not-be-read-as-settings"}')
})

test("fixture hooks block dangerous execution but preserve built-in-shaped success and error results", async () => {
  const result: ToolResult = { ...textResult("Canned read"), details: { path: "never-read", lines: 1 } }
  const provider = await scripted({
    main: [
      {
        toolCalls: [
          { id: "read-1", name: "read", args: { path: "never-read" }, result },
          {
            id: "shell-1",
            name: "bash",
            args: { command: "never-run" },
            result: textResult("Canned failure", true),
          },
          { id: "ask-1", name: "ask_user", args: {} },
        ],
      },
      { text: "Done" },
    ],
  })
  const directory = await temporary()
  const setup = await setupFixtures(path.join(directory, "home"), path.join(directory, "work"), provider)
  const settings = JSON.parse(await readFile(setup.settingsPath, "utf8"))
  const ai = client(provider)
  const bus = new EventBus()
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const host = new ExtensionHost({ bus, interceptors, tools, settings, cwd: directory })
  let executed = 0
  let asked = 0
  for (const name of ["read", "bash", "edit", "write", "web_fetch"]) {
    tools.register(
      defineTool({
        name,
        description: "Must not execute",
        parameters: { type: "object" },
        async execute() {
          executed++
          throw new Error("A dangerous tool executed")
        },
      }),
      "test",
    )
  }
  tools.register(
    defineTool({
      name: "ask_user",
      description: "Real question path",
      parameters: { type: "object" },
      async execute() {
        asked++
        return textResult("Answered through the real tool")
      },
    }),
    "test",
  )
  expect(await host.load(fixtureExtension, "ui-walk-fixture")).toBe(true)
  const agent = new Agent({
    ai,
    model: ai.model(provider.model),
    cwd: directory,
    systemPrompt: "sys",
    bus,
    tools,
    interceptors,
    fileRewindSettings: { enabled: false },
  })
  expect((await agent.prompt("go")).reason).toBe("done")
  await bus.flush()
  expect(executed).toBe(0)
  expect(asked).toBe(1)
  const ended = events.filter((event) => event.type === "tool.execute.end")
  expect(ended.map((event) => event.data.result.content)).toEqual([
    result.content,
    textResult("Canned failure", true).content,
    textResult("Answered through the real tool").content,
  ])
  expect(ended[0]?.data.result.details).toEqual(result.details)
  expect(ended[0]?.data.rejected).toBeUndefined()
  expect(ended[1]?.data.result.isError).toBe(true)
  expect(ended[1]?.data.rejected).toBeUndefined()
  await host.unload("ui-walk-fixture")
})

test("fixture hooks deny worktree agents and never fabricate success for unknown calls", async () => {
  const bus = new EventBus()
  const interceptors = new InterceptorRegistry()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({
    bus,
    interceptors,
    tools,
    settings: { extensions: { "ui-walk": { results: {} } } },
  })
  expect(await host.load(fixtureExtension, "ui-walk-fixture")).toBe(true)
  const ctx = { sessionId: "test", signal: new AbortController().signal }
  const call = {
    toolCallId: "unknown",
    name: "agent",
    args: { tasks: [{ title: "Never start worktree", isolation: "worktree" }] },
  }
  expect((await interceptors.run("tool.call.before", call, ctx)).blocked).toBe(true)
  const allowed = {
    ...call,
    args: { tasks: [{ title: "Scripted child task", isolation: "none", model: "ui-walk/child" }] },
  }
  expect((await interceptors.run("tool.call.before", allowed, ctx)).blocked).toBe(false)
  const bash = { toolCallId: "unknown", name: "bash", args: { command: "never-run" } }
  expect((await interceptors.run("tool.call.before", bash, ctx)).blocked).toBe(true)
  const after = {
    ...bash,
    cwd: process.cwd(),
    pending: [],
    rejected: "blocked" as const,
    result: textResult("Blocked", true),
  }
  expect((await interceptors.run("tool.call.after", after, ctx)).value.result).toEqual(after.result)
  await host.unload("ui-walk-fixture")
})

test("all five bundled scenarios parse and expose the expected routes", async () => {
  for (const name of ["transcript", "dialogs", "subagents", "long-output", "errors"]) {
    const provider = await createProvider(path.join(import.meta.dir, "scenarios", `${name}.json`))
    providers.push(provider)
    expect(provider.scenario.name).toBe(name)
    expect(provider.scenario.routes.main?.length).toBeGreaterThan(0)
  }
})
