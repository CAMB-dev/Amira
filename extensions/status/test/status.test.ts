import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import statusExtension, { formatContext, formatCost, formatTokens, tokensPerSecond } from "../src/index.ts"

test("formats token counts compactly, rounding before picking the unit", () => {
  expect([999, 1234, 9_999, 45_600, 999_950, 2_500_000].map(formatTokens)).toEqual([
    "999",
    "1.2k",
    "10k",
    "46k",
    "1.0M",
    "2.5M",
  ])
})

function setup() {
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  const ai = createAi({
    dialects: [createMockDialect([{ text: "hi", usage: { input: 1200, output: 30, cacheRead: 800 } }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m1"), cwd: "/work/proj", systemPrompt: "", bus })
  return { bus, host, agent }
}

const texts = (host: ExtensionHost) => host.status.snapshot().map((i) => [i.id, i.align, i.text])

test("fills the status bar from session and workspace events", async () => {
  const { bus, host, agent } = setup()
  expect(await host.load(statusExtension, "builtin:status")).toBe(true)
  agent.start("startup")
  await bus.flush()
  expect(texts(host)).toEqual([
    ["model", "left", "mock/m1"],
    ["place", "right", "proj"],
  ])

  bus.emit(
    "workspace.changed",
    { cwd: "/work/proj", repoRoot: "/work/proj", branch: "main" },
    { sessionId: "s" },
  )
  await agent.prompt("go")
  await bus.flush()
  expect(texts(host)).toEqual([
    ["model", "left", "mock/m1"],
    ["tokens", "right", "ctx 2.0k/128k (2%) · out 30"],
    ["place", "right", "proj ⎇ main"],
  ])

  bus.emit(
    "workspace.changed",
    { cwd: "/work/proj", repoRoot: "/work/proj", head: "abc1234" },
    { sessionId: "s" },
  )
  await bus.flush()
  expect(host.status.snapshot().find((i) => i.id === "place")?.text).toBe("proj ⎇ @abc1234")
})

test("shows activity while working or blocked, and resets counters on clear", async () => {
  const { bus, host, agent } = setup()
  await host.load(statusExtension, "builtin:status")
  const activity = () => host.status.snapshot().find((i) => i.id === "activity")?.text
  bus.emit("status.changed", { status: "blocked", reason: "approve bash" }, { sessionId: "s" })
  await bus.flush()
  expect(activity()).toBe("waiting: approve bash")
  bus.emit("status.changed", { status: "working" }, { sessionId: "s" })
  await bus.flush()
  expect(activity()).toBe("working")

  await agent.prompt("go")
  await bus.flush()
  expect(host.status.snapshot().some((i) => i.id === "tokens")).toBe(true)
  agent.start("clear")
  await bus.flush()
  expect(host.status.snapshot().some((i) => i.id === "tokens")).toBe(false)
})

test("a user extension can override a single built-in item, and unloading restores it", async () => {
  const { bus, host, agent } = setup()
  await host.load(statusExtension, "builtin:status")
  agent.start("startup")
  await bus.flush()
  expect(
    await host.load((api) => {
      api.registerStatusItem({ id: "model", override: true, tone: "warning", text: () => "custom" })
    }, "user"),
  ).toBe(true)
  expect(host.status.snapshot()[0]).toEqual({ id: "model", align: "left", tone: "warning", text: "custom" })
  host.unload("user")
  expect(host.status.snapshot()[0]?.text).toBe("mock/m1")
  // Without override: true, a duplicate id fails that extension only.
  expect(
    await host.load((api) => {
      api.registerStatusItem({ id: "model", text: () => "clash" })
    }, "clash"),
  ).toBe(false)
  expect(host.status.snapshot()[0]?.text).toBe("mock/m1")
})

test("render requests are coalesced, and unload triggers a redraw", async () => {
  const { bus, host } = setup()
  const renders: AnyEvent[] = []
  bus.subscribe((e) => void renders.push(e), { types: ["ui.render"] })
  await host.load((api) => {
    api.registerStatusItem({ id: "a", text: () => "a" })
    api.registerStatusItem({ id: "b", text: () => "b" })
    for (let i = 0; i < 50; i++) api.requestRender()
  }, "x")
  await Bun.sleep(5)
  await bus.flush()
  expect(renders).toHaveLength(1)
  host.unload("x")
  await Bun.sleep(5)
  await bus.flush()
  expect(renders).toHaveLength(2)
})

test("bad item texts are skipped or sanitized, and defaults apply", async () => {
  const { host } = setup()
  await host.load((api) => {
    api.registerStatusItem({ id: "num", text: () => 42 as never })
    api.registerStatusItem({ id: "nl", order: 5, text: () => "two\nlines\x1b[31m" })
    api.registerStatusItem({ id: "first", order: -1, text: () => "x" })
    api.registerStatusItem({
      id: "throws",
      text: () => {
        throw new Error("x")
      },
    })
  }, "t")
  expect(host.status.snapshot()).toEqual([
    { id: "first", align: "left", tone: "default", text: "x" },
    { id: "nl", align: "left", tone: "default", text: "two lines [31m" },
  ])
})

test("context shows use against the window, and speed is timed from the first delta", () => {
  expect(formatContext(12_300, 128_000)).toBe("12k/128k (10%)")
  expect(formatContext(500, undefined)).toBe("500")
  expect(tokensPerSecond(84, 1000, 3000)).toBe(42)
  expect(tokensPerSecond(10, 1000, 1100)).toBeUndefined()
  expect(tokensPerSecond(0, 1000, 5000)).toBeUndefined()
})

test("the status bar shows the speed of the last reply", async () => {
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  await host.load(statusExtension, "builtin:status")
  const meta = { sessionId: "s" }
  const model = { provider: "p", model: "m" }
  bus.emit("message.start", { model, contextWindow: 1_000_000 }, meta)
  bus.emit("message.delta", { kind: "text", text: "a" }, meta)
  await Bun.sleep(250)
  bus.emit(
    "message.end",
    {
      message: {
        role: "assistant",
        content: [],
        model,
        usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
      },
    },
    meta,
  )
  await bus.flush()
  const items = Object.fromEntries(host.status.snapshot().map((i) => [i.id, i.text]))
  expect(items.tokens).toBe("ctx 1.1k/1.0M (0%) · out 100")
  expect(items.speed).toMatch(/tok\/s$/)
})

test("formats costs to a tenth of a cent", () => {
  expect([0, 0.0001, 0.0123, 0.4567, 1.234, 25].map(formatCost)).toEqual([
    "$0.000",
    "<$0.001",
    "$0.012",
    "$0.457",
    "$1.23",
    "$25.00",
  ])
})

test("the session cost adds up the replies that have one, and a retry shows as activity", async () => {
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  await host.load(statusExtension, "builtin:status")
  const meta = { sessionId: "s" }
  const model = { provider: "p", model: "m" }
  const end = (cost?: number) =>
    bus.emit(
      "message.end",
      {
        message: {
          role: "assistant",
          content: [],
          model,
          usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, ...(cost ? { cost } : {}) },
        },
      },
      meta,
    )
  const item = (id: string) => host.status.snapshot().find((i) => i.id === id)?.text
  end()
  await bus.flush()
  expect(item("tokens")).toBe("ctx 1.1k · out 100")
  end(0.004)
  end(0.008)
  await bus.flush()
  expect(item("tokens")).toBe("ctx 1.1k · out 300 · $0.012")

  bus.emit("status.changed", { status: "working", reason: "retrying (2/3)" }, meta)
  await bus.flush()
  expect(item("activity")).toBe("retrying (2/3)")
})
