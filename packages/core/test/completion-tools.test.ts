import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type Dialect, type MockStep, type ModelRequest } from "@amira/ai"
import type { CompleteRequest } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { completeForAgent } from "../src/completion.ts"
import { SessionStore } from "../src/session-store.ts"
import { storedSessionUsage } from "../src/session-usage.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup(id = "openai-chat", steps?: MockStep[], dialect?: Dialect) {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-completion-tools-"))
  const mock = createMockDialect(
    steps ?? [
      { text: "answer", usage: { cost: 0.2 } },
      { text: "answer", usage: { cost: 0.2 } },
    ],
  )
  const ai = createAi({
    dialects: [{ ...mock, id }, ...(dialect ? [dialect] : [])],
    providers: [{ id: "test", dialect: id, baseUrl: "https://mock.invalid", keySource: "none" }],
    fetch: (() => {
      throw new Error("Unexpected network request")
    }) as unknown as typeof fetch,
    retry: { retries: 0 },
  })
  const store = SessionStore.create({ cwd: dir, dir })
  const tools = new ToolRegistry()
  let executed = 0
  for (const [name, exposure] of [
    ["read", "active"],
    ["loaded", "deferred"],
    ["unloaded", "deferred"],
    ["disabled", "active"],
    ["edit", "active"],
    ["apply_patch", "active"],
  ] as const) {
    tools.register(
      {
        name,
        description: `${name} description`,
        parameters: { type: "object" },
        exposure,
        async execute() {
          executed++
          return { content: [{ type: "text", text: "must not run" }] }
        },
      },
      "test",
    )
  }
  tools.setDisabled(["disabled"])
  const agent = new Agent({
    ai,
    model: ai.model("test/main"),
    cwd: dir,
    session: store,
    tools,
    systemPrompt: "Session system",
    messages: [{ role: "user", content: [{ type: "text", text: "Session history" }] }],
  })
  agent.loadTools(["loaded"])
  cleanups.push(async () => {
    await agent.dispose()
    store.release()
    rmSync(dir, { recursive: true, force: true })
  })
  const complete = (request: Omit<CompleteRequest, "model">) =>
    completeForAgent({
      ai,
      agent,
      model: agent.model,
      request,
      label: "tools test",
    })
  return { ai, agent, store, mock, complete, executed: () => executed }
}

const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "Side request" }] }]

for (const dialect of ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"]) {
  test(`${dialect} completion retains exactly the session's offered definitions only when requested`, async () => {
    const { agent, mock, complete, store, executed } = setup(dialect)
    const preview = await agent.preview()
    expect(preview.tools.map((tool) => tool.name)).toEqual(["read", "edit", "loaded"])
    const before = structuredClone(agent.messages)
    const request = { system: preview.systemPrompt, messages: preview.messages }
    const stripped = await complete(request)
    expect(stripped.toolsKept).toBe(false)
    expect(mock.requests[0]?.tools).toEqual([])
    expect(mock.requests[0]?.toolChoice).toBeUndefined()
    agent.interceptors.add("context.build", () => {
      throw new Error("Must not rebuild context")
    })
    const result = await complete({ ...request, keepSessionTools: true })
    expect(result.toolsKept).toBe(true)
    expect(result.text).toBe("answer")
    expect(mock.requests[1]).toMatchObject({
      systemPrompt: preview.systemPrompt,
      messages: preview.messages,
      tools: preview.tools,
      toolChoice: "none",
    })
    expect(agent.messages).toEqual(before)
    expect(executed()).toBe(0)
    expect(storedSessionUsage(store).knownCostUsd).toBeCloseTo(0.4)
  })
}

for (const [id, reason] of [
  ["openai-chat", "tool_choice 'none' is not supported"],
  ["openai-responses", "Unsupported parameter: tool_choice"],
  ["anthropic-messages", "tool_choice.type: none is not allowed"],
  ["google-gemini", "Invalid toolConfig.functionCallingConfig.mode: NONE"],
] as const) {
  test(`${id} falls back to stripped tools when the endpoint rejects the no-calls option`, async () => {
    const { mock, complete, store, executed } = setup(id, [
      { error: { status: 400, message: reason }, usage: { cost: 0.1 } },
      { text: "fallback answer", usage: { cost: 0.2 } },
    ])
    const result = await complete({ messages, system: "Explicit system", keepSessionTools: true })
    expect(result).toMatchObject({ text: "fallback answer", toolsKept: false, usage: { cost: 0.2 } })
    expect(mock.requests).toHaveLength(2)
    expect(mock.requests[0]?.tools.length).toBeGreaterThan(0)
    expect(mock.requests[0]?.toolChoice).toBe("none")
    expect(mock.requests[1]).toMatchObject({ tools: [], systemPrompt: "Explicit system", messages })
    expect(mock.requests[1]?.toolChoice).toBeUndefined()
    expect(storedSessionUsage(store).knownCostUsd).toBeCloseTo(0.3)
    expect(storedSessionUsage(store).complete).toBe(true)
    expect(executed()).toBe(0)
  })
}

for (const id of ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"]) {
  for (const text of ["answer", ""]) {
    test(`${id} never executes a returned call even when the no-calls option is ignored (${text || "no text"})`, async () => {
      const { complete, mock, executed, store, agent } = setup(id, [
        {
          text,
          toolCalls: [{ name: "read", args: {} }],
          usage: { input: 100, output: 5, cacheRead: 80, cacheWrite: 20, cost: 0.2 },
        },
      ])
      const before = structuredClone(agent.messages)
      const result = await complete({ messages, keepSessionTools: true })
      expect(result).toMatchObject({ text, toolsKept: true, message: { stopReason: "toolUse" } })
      expect(result.message.content.some((block) => block.type === "toolCall")).toBe(true)
      expect(result.usage).toMatchObject({ input: 100, output: 5, cacheRead: 80, cacheWrite: 20, cost: 0.2 })
      expect(mock.requests).toHaveLength(1)
      expect(executed()).toBe(0)
      expect(agent.messages).toEqual(before)
      expect(storedSessionUsage(SessionStore.open(store.file))).toMatchObject({
        knownCostUsd: 0.2,
        complete: true,
        usage: { input: 100, output: 5, cacheRead: 80, cacheWrite: 20 },
      })
    })
  }
}

for (const fallback of ["unknown dialect", "text tools", "no definitions", "explicit opt-out"]) {
  test(`completion strips tools for ${fallback} without injecting session context`, async () => {
    const { agent, complete, mock } = setup(fallback === "unknown dialect" ? "custom" : "openai-chat")
    if (fallback === "text tools")
      agent.model = { ...agent.model, caps: { ...agent.model.caps, tools: "none" } }
    if (fallback === "no definitions")
      agent.tools.setDisabled(agent.tools.list().map(({ tool }) => tool.name))
    const result = await complete({ messages, keepSessionTools: fallback !== "explicit opt-out" })
    expect(result.toolsKept).toBe(false)
    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0]).toMatchObject({ systemPrompt: "", messages, tools: [] })
    expect(mock.requests[0]?.toolChoice).toBeUndefined()
  })
}

for (const [status, message] of [
  [400, "Invalid model"],
  [401, "Unauthorized tool_choice"],
  [429, "Rate limited tool_choice"],
  [500, "Internal tool_choice error"],
] as const) {
  test(`completion does not strip/retry an unrelated ${status} failure`, async () => {
    const { complete, mock, store } = setup("openai-chat", [
      { error: { status, message }, usage: { cost: 0.2 } },
    ])
    await expect(complete({ messages, keepSessionTools: true })).rejects.toThrow(message)
    expect(mock.requests).toHaveLength(1)
    expect(storedSessionUsage(store).knownCostUsd).toBe(0.2)
  })
}

for (const status of [422, 501]) {
  test(`completion strips tools for a ${status} unsupported no-calls option`, async () => {
    const { complete, mock } = setup("openai-chat", [
      { error: { status, message: "tool_choice is unsupported" } },
      { text: "fallback" },
    ])
    expect(await complete({ messages, keepSessionTools: true })).toMatchObject({
      text: "fallback",
      toolsKept: false,
    })
    expect(mock.requests).toHaveLength(2)
  })
}

test("completion drains late rejected-attempt receipts before the stripped fallback and accounts both", async () => {
  const requests: ModelRequest[] = []
  const dialect: Dialect = {
    id: "openai-chat",
    async *stream(request) {
      requests.push(request)
      const message = (cost: number) => ({
        role: "assistant" as const,
        model: { provider: "test", model: "main" },
        content: [],
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost },
      })
      if (request.tools.length) {
        try {
          yield {
            type: "error",
            error: { status: 400, message: "Unsupported tool_choice" },
            retryable: false,
            message: message(1),
          }
        } finally {
          yield { type: "request.end", message: message(2) }
        }
      } else {
        yield { type: "done", message: { ...message(3), content: [{ type: "text", text: "fallback" }] } }
      }
    },
  }
  const { complete, store } = setup("openai-chat", [], dialect)
  expect(await complete({ messages, keepSessionTools: true })).toMatchObject({
    text: "fallback",
    toolsKept: false,
  })
  expect(requests).toHaveLength(2)
  expect(storedSessionUsage(SessionStore.open(store.file))).toMatchObject({ knownCostUsd: 5, complete: true })
})

test("a stripped fallback failure is surfaced without another fallback or lost spend", async () => {
  const { complete, mock, store } = setup("openai-chat", [
    { error: { status: 400, message: "Unsupported tool_choice" }, usage: { cost: 1 } },
    { error: { status: 400, message: "Invalid history" }, usage: { cost: 2 } },
  ])
  await expect(complete({ messages, keepSessionTools: true })).rejects.toThrow("Invalid history")
  expect(mock.requests).toHaveLength(2)
  expect(storedSessionUsage(store)).toMatchObject({ knownCostUsd: 3, complete: true })
})

test("cancellation while draining a rejected no-calls request never dispatches the stripped fallback", async () => {
  const abort = new AbortController()
  let calls = 0
  const dialect: Dialect = {
    id: "openai-chat",
    async *stream() {
      calls++
      yield {
        type: "error",
        error: { status: 400, message: "Unsupported tool_choice" },
        retryable: false,
        message: {
          role: "assistant",
          model: { provider: "test", model: "main" },
          content: [],
          usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: 1 },
        },
      }
      abort.abort()
    },
  }
  const { complete, store } = setup("openai-chat", [], dialect)
  await expect(complete({ messages, keepSessionTools: true, signal: abort.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(calls).toBe(1)
  expect(storedSessionUsage(store)).toMatchObject({ knownCostUsd: 1, complete: true })
})

for (const id of ["openai-responses", "anthropic-messages"]) {
  test(`${id} keeps the normal hosted-search definition under the same no-calls policy`, async () => {
    const { agent, complete, mock } = setup(id)
    agent.model = { ...agent.model, caps: { ...agent.model.caps, webSearch: true } }
    const result = await complete({ messages, keepSessionTools: true })
    expect(result.toolsKept).toBe(true)
    expect(mock.requests[0]).toMatchObject({ model: { caps: { webSearch: true } }, toolChoice: "none" })
  })
}

test("Gemini strips tools when hosted search cannot be disabled by functionCallingConfig NONE", async () => {
  const { agent, complete, mock } = setup("google-gemini")
  agent.model = { ...agent.model, id: "gemini-3-pro", caps: { ...agent.model.caps, webSearch: true } }
  expect(await complete({ messages, keepSessionTools: true })).toMatchObject({ toolsKept: false })
  expect(mock.requests[0]).toMatchObject({ tools: [], model: { caps: { webSearch: false } } })
})

test("a stripped fallback disables hosted search as well as session functions", async () => {
  const { agent, complete, mock } = setup("openai-responses", [
    { error: { status: 400, message: "Unsupported tool_choice" } },
    { text: "fallback" },
  ])
  agent.model = { ...agent.model, caps: { ...agent.model.caps, webSearch: true } }
  expect(await complete({ messages, keepSessionTools: true })).toMatchObject({ toolsKept: false })
  expect(mock.requests[0]?.model.caps.webSearch).toBe(true)
  expect(mock.requests[1]).toMatchObject({ tools: [], model: { caps: { webSearch: false } } })
})
