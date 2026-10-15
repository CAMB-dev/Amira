import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { type Ai, createAi, createMockDialect, type MockStep } from "@amira/ai"
import { defineTool, type EventMap, type Settings, textResult } from "@amira/api"
import { Agent, type AgentOptions } from "../src/agent.ts"
import { validateSettings } from "../src/config/schema.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Fake availability is deliberate: core consumes resolved options, not endpoint/catalog rules. */
function setup(extra: Partial<AgentOptions> = {}, steps: MockStep[] = [{ text: "done" }], fallback = false) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-fast-core-"))
  const mock = createMockDialect(steps)
  const dialect = {
    ...mock,
    id: "anthropic-messages",
    async *stream(...args: Parameters<typeof mock.stream>) {
      if (fallback) {
        yield {
          type: "request.end" as const,
          message: {
            role: "assistant" as const,
            model: { provider: args[0].model.provider, model: args[0].model.id },
            content: [],
            usage: {
              input: 10_000,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              speed: "fast" as const,
              cost: 0.08,
            },
          },
        }
        yield { type: "fast.fallback" as const }
      }
      yield* mock.stream(...args)
    },
  }
  const backend = createAi({
    dialects: [dialect, { ...mock, id: "openai-responses" }, mock],
    providers: [{ id: "mock", dialect: dialect.id, baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const ai: Ai = {
    ...backend,
    model(ref) {
      const model = backend.model(ref)
      return {
        ...model,
        dialect:
          model.id === "priority" ? "openai-responses" : model.id === "wrong-dialect" ? "mock" : dialect.id,
        fast:
          model.id === "plain"
            ? false
            : model.id === "priority"
              ? { kind: "service-tier" as const, value: "priority" }
              : { kind: "anthropic-speed" as const },
      }
    },
  }
  const tree = new AgentTree({ ai, sections: () => [] })
  const agent = new Agent({ ai, model: ai.model("mock/fast"), cwd, tree, ...extra })
  cleanups.push(async () => {
    tree.abortAll("test cleanup")
    await agent.dispose()
    rmSync(cwd, { recursive: true, force: true })
  })
  return { agent, ai, tree, mock, cwd }
}

test("fast settings and custom options/prices are validated", () => {
  const settings = {
    fastMode: true,
    providers: {
      gateway: {
        models: [
          {
            id: "compatible",
            fast: { kind: "anthropic-speed" },
            cost: { input: 5, output: 25, fast: { input: 10, output: 50 } },
          },
          {
            id: "priority",
            fast: {
              kind: "service-tier",
              value: "priority",
              textOnly: true,
              responseHeader: "x-service-tier",
            },
          },
          { id: "plain", fast: false },
        ],
      },
    },
  } satisfies Settings
  expect(validateSettings(settings, "settings.json")).toEqual({ settings, warnings: [] })
  expect(() => validateSettings({ fastMode: "on" }, "settings.json")).toThrow("true or false")
})

test("fast mode defaults off, can be changed directly, and is omitted when off", async () => {
  const { agent, mock } = setup({}, [{ text: "one" }, { text: "two" }, { text: "three" }])
  expect(agent.fastMode).toBe(false)
  expect(agent.fastModeApplied).toBe(false)
  await agent.prompt("one")
  agent.fastMode = true
  expect(agent.fastModeApplied).toBe(true)
  await agent.prompt("two")
  agent.fastMode = false
  await agent.prompt("three")
  expect(mock.requests[0]).not.toHaveProperty("fastMode")
  expect(mock.requests[1]?.fastMode).toBe(true)
  expect(mock.requests[2]).not.toHaveProperty("fastMode")
})

test.each(["plain", "wrong-dialect"])(
  "requested fast mode survives a switch to %s but is not sent until supported again",
  async (id) => {
    const { agent, ai, mock } = setup({ fastMode: true }, [{ text: "one" }, { text: "two" }])
    agent.setModel(ai.model(`mock/${id}`))
    expect(agent.fastMode).toBe(true)
    expect(agent.fastModeApplied).toBe(false)
    await agent.prompt("one")
    expect(mock.requests[0]).not.toHaveProperty("fastMode")
    agent.setModel(ai.model("mock/fast"))
    expect(agent.fastModeApplied).toBe(true)
    await agent.prompt("two")
    expect(mock.requests[1]?.fastMode).toBe(true)
  },
)

test("lastSpeed reflects actual final usage, including standard fallback and absent speed", async () => {
  const { agent, mock } = setup({ fastMode: true }, [
    { text: "fast", usage: { speed: "fast" } },
    { text: "standard", usage: { speed: "standard" } },
    { text: "unknown" },
    { error: { message: "failed" }, usage: { speed: "standard" } },
    { text: "no usage" },
  ])
  expect(agent.lastSpeed).toBeUndefined()
  for (const speed of ["fast", "standard", undefined, "standard"] as const) {
    await agent.prompt("go")
    expect(agent.lastSpeed).toBe(speed)
    expect(agent.fastMode).toBe(true)
  }
  const stream = mock.stream.bind(mock)
  mock.stream = async function* (...args) {
    for await (const event of stream(...args)) {
      if (event.type === "done") delete event.message.usage
      yield event
    }
  }
  await agent.prompt("no usage")
  expect(agent.lastSpeed).toBeUndefined()
})

test("service-tier status follows actual usage, including downgrades and missing echoes", async () => {
  const { agent, ai, mock } = setup({ fastMode: true }, [
    { text: "priority", usage: { serviceTier: "priority", speed: "standard" } },
    { text: "downgraded", usage: { serviceTier: "default", speed: "fast" } },
    { text: "another tier", usage: { serviceTier: "flex" } },
    { text: "unknown" },
  ])
  agent.setModel(ai.model("mock/priority"))
  const statuses: { used: string | undefined; pricingUnknown: boolean | undefined }[] = []
  agent.bus.subscribe((event) => {
    if (event.type === "message.end")
      statuses.push({ used: agent.lastSpeed, pricingUnknown: agent.lastFastPricingUnknown })
  })
  for (const used of ["priority", "default", "flex", undefined]) {
    await agent.prompt("go")
    expect(agent.lastSpeed).toBe(used)
    expect(agent.lastFastPricingUnknown).toBe(used === "priority" || used === undefined ? true : undefined)
    expect(agent.fastModeApplied).toBe(true)
  }
  await agent.bus.flush()
  expect(statuses).toEqual([
    { used: "priority", pricingUnknown: true },
    { used: "default", pricingUnknown: undefined },
    { used: "flex", pricingUnknown: undefined },
    { used: undefined, pricingUnknown: true },
  ])
  expect(mock.requests.map((request) => request.fastMode)).toEqual([true, true, true, true])
})

test.each([undefined, "priority", "default"])(
  "restored Anthropic history preserves speed independently of tier %s",
  (serviceTier) => {
    const { agent } = setup({
      messages: [
        {
          role: "assistant",
          model: { provider: "mock", model: "fast" },
          content: [{ type: "text", text: "earlier reply" }],
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            speed: "fast",
            serviceTier,
            pricingUnknown: true,
          },
        },
      ],
    })
    expect(agent.lastSpeed).toBe("fast")
    expect(agent.lastFastPricingUnknown).toBe(true)
  },
)

test("Anthropic status trusts speed rather than its independent tier", async () => {
  const { agent } = setup({ fastMode: true }, [
    { text: "fast", usage: { speed: "fast", serviceTier: "standard" } },
  ])
  await agent.prompt("go")
  expect(agent.lastSpeed).toBe("fast")
})

test("restored service-tier history uses its producer's dialect after a model switch", () => {
  const { agent } = setup({
    messages: [
      {
        role: "assistant",
        model: { provider: "mock", model: "priority" },
        content: [{ type: "text", text: "reply" }],
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          speed: "standard",
          serviceTier: "default",
        },
      },
    ],
  })
  expect(agent.lastSpeed).toBe("default")
})

test("each final response updates speed before message.end, including tool-use replies", async () => {
  const { agent, mock } = setup({ fastMode: true }, [
    { toolCalls: [{ name: "check", args: {} }], usage: { speed: "fast" } },
    { text: "done" },
  ])
  agent.tools.register(
    defineTool({ name: "check", description: "", parameters: {}, execute: async () => textResult("ok") }),
    "test",
  )
  const speeds: (typeof agent.lastSpeed)[] = []
  agent.bus.subscribe((event) => {
    if (event.type === "message.end") speeds.push(agent.lastSpeed)
  })
  expect((await agent.prompt("go")).reason).toBe("done")
  await agent.bus.flush()
  expect(speeds).toEqual(["fast", undefined])
  expect(mock.requests.map((request) => request.fastMode)).toEqual([true, true])
})

test.each(["fast", "priority"])(
  "changing fast mode during a %s turn applies to its next request",
  async (id) => {
    const { agent, ai, mock } = setup({ fastMode: true }, [
      () => {
        agent.fastMode = false
        return { toolCalls: [{ name: "check", args: {} }] }
      },
      { text: "done" },
    ])
    agent.setModel(ai.model(`mock/${id}`))
    agent.tools.register(
      defineTool({ name: "check", description: "", parameters: {}, execute: async () => textResult("ok") }),
      "test",
    )
    expect((await agent.prompt("go")).reason).toBe("done")
    expect(mock.requests[0]?.fastMode).toBe(true)
    expect(mock.requests[1]).not.toHaveProperty("fastMode")
  },
)

test("fast fallback becomes the exact user notice without changing the preference", async () => {
  const { agent, mock, tree } = setup(
    { fastMode: true },
    [{ text: "done", usage: { speed: "standard" } }],
    true,
  )
  const notices: EventMap["extension.notice"][] = []
  agent.bus.subscribe((event) => {
    if (event.type === "extension.notice") notices.push(event.data)
  })
  expect((await agent.prompt("go")).reason).toBe("done")
  await agent.bus.flush()
  expect(notices).toEqual([
    {
      source: "fast",
      text: "fast mode rate-limited; this request ran at standard speed — cache miss",
      level: "warning",
    },
  ])
  expect(agent.fastModeApplied).toBe(true)
  expect(agent.lastSpeed).toBe("standard")
  expect(mock.requests[0]?.fastMode).toBe(true)
  expect(agent.retryUsage).toMatchObject([
    { label: "request retry", usage: { input: 10_000, speed: "fast", cost: 0.08 } },
  ])
  expect(tree.usage.input).toBeGreaterThanOrEqual(10_000)
  expect(agent.messages.filter((m) => m.role === "assistant")).toHaveLength(1)
})

test("fast fallback usage is persisted separately for cost reports", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-fast-usage-"))
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
  const store = SessionStore.create({ cwd: dir, dir: path.join(dir, "sessions") })
  const { agent } = setup(
    { fastMode: true, session: store },
    [{ text: "done", usage: { speed: "standard" } }],
    true,
  )
  await agent.prompt("go")
  expect(store.entries.filter((e) => e.type === "side_usage")).toMatchObject([
    { label: "request retry", usage: { input: 10_000, speed: "fast", cost: 0.08 } },
  ])
  expect(agent.retryUsage).toHaveLength(0)
  expect(agent.lastSpeed).toBe("standard")
})

test.each(["fresh", "fork"] as const)(
  "%s children inherit the requested preference only for a supported child model",
  async (context) => {
    const { agent, ai, tree, mock } = setup(
      { fastMode: true },
      Array.from({ length: 5 }, () => ({ text: "done" })),
    )
    // The parent's current model need not support the requested preference.
    agent.setModel(ai.model("mock/plain"))
    for (const id of ["fast", "priority", "plain", "wrong-dialect"]) {
      expect(
        (await tree.spawn(agent, { prompt: "work", model: `mock/${id}`, context }).result()).status,
      ).toBe("done")
    }
    agent.fastMode = false
    await tree.spawn(agent, { prompt: "work", model: "mock/fast", context }).result()
    expect(mock.requests.slice(0, 2).map((request) => request.fastMode)).toEqual([true, true])
    expect(mock.requests[1]?.model.fast).toEqual({ kind: "service-tier", value: "priority" })
    for (const request of mock.requests.slice(2)) expect(request).not.toHaveProperty("fastMode")
  },
)

test("owned conversations inherit the requested preference only for their supported model", async () => {
  const { agent, ai, tree, mock, cwd } = setup(
    { fastMode: true },
    Array.from({ length: 5 }, () => ({ text: "done" })),
  )
  agent.setModel(ai.model("mock/plain"))
  const manager = new OwnedConversationManager({
    ai,
    tools: agent.tools,
    tree,
    home: cwd,
    agent: () => agent,
  })
  cleanups.push(() => manager.drain())
  for (const id of ["fast", "priority", "plain", "wrong-dialect", "off"]) {
    if (id === "off") agent.fastMode = false
    const handle = await manager.forOwner("test").openOrCreate(
      {
        key: id,
        name: id,
        model: `mock/${id === "off" ? "fast" : id}`,
        cwd,
        systemPrompt: "",
        callableTools: [],
      },
      { askUser: async () => undefined },
    )
    await handle.send("go")
    await handle.release()
  }
  expect(mock.requests.slice(0, 2).map((request) => request.fastMode)).toEqual([true, true])
  expect(mock.requests[1]?.model.fast).toEqual({ kind: "service-tier", value: "priority" })
  for (const request of mock.requests.slice(2)) expect(request).not.toHaveProperty("fastMode")
})

test("the requested preference carries directly to a replacement agent", async () => {
  const { agent, ai, cwd } = setup({ fastMode: true })
  const next = new Agent({ ai, model: ai.model("mock/plain"), cwd })
  cleanups.push(() => next.dispose())
  next.fastMode = agent.fastMode
  expect(next.fastMode).toBe(true)
  expect(next.fastModeApplied).toBe(false)
  next.setModel(ai.model("mock/fast"))
  expect(next.fastModeApplied).toBe(true)
})
