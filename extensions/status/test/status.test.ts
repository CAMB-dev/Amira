import { expect, test } from "bun:test"
import { createAi, createMockDialect, NO_MODEL } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import statusExtension, {
  contextTone,
  formatContext,
  formatCost,
  formatTokens,
  placeLabel,
} from "../src/index.ts"

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
  return { bus, host, agent, ai }
}

const texts = (host: ExtensionHost) => host.status.snapshot().map((i) => [i.id, i.align, i.text])
const item = (host: ExtensionHost, id: string) => host.status.snapshot().find((i) => i.id === id)

test("shows (no model) until one is picked, and follows a model switch at once", async () => {
  const { bus, host, agent, ai } = setup()
  await host.load(statusExtension, "builtin:status")
  const model = () => item(host, "model")?.text
  agent.setModel(NO_MODEL)
  agent.start("startup")
  await bus.flush()
  expect(model()).toBe("(no model)")
  agent.setModel(ai.model("mock/m2"))
  await bus.flush()
  // The provider is left out; /status names it.
  expect(model()).toBe("m2")
})

test("fills the status from session and workspace events, built-ins first by priority", async () => {
  const { bus, host, agent } = setup()
  expect(await host.load(statusExtension, "builtin:status")).toBe(true)
  agent.start("startup")
  await bus.flush()
  expect(texts(host)).toEqual([
    ["model", "left", "m1"],
    ["place", "right", "proj"],
  ])

  bus.emit(
    "workspace.changed",
    { cwd: "/work/proj", repoRoot: "/work/proj", branch: "main", dirty: true },
    { sessionId: "s" },
  )
  await agent.prompt("go")
  await bus.flush()
  expect(texts(host)).toEqual([
    ["model", "left", "m1"],
    ["context", "right", "ctx 2.0k/128k (2%)"],
    ["place", "right", "main*"],
  ])
  expect(host.status.snapshot().map((i) => [i.id, i.priority])).toEqual([
    ["model", 40],
    ["context", 30],
    ["place", 10],
  ])

  bus.emit(
    "workspace.changed",
    { cwd: "/work/proj", repoRoot: "/work/proj", head: "abc1234" },
    { sessionId: "s" },
  )
  await bus.flush()
  expect(item(host, "place")?.text).toBe("@abc1234")
})

test("the place is the branch, marked when dirty or a worktree; the folder outside a repository", () => {
  expect(placeLabel({ cwd: "/w/proj" })).toBe("proj")
  expect(placeLabel({ cwd: "/w/proj/sub", repoRoot: "/w/proj" })).toBe("proj")
  expect(placeLabel({ cwd: "/w/proj", repoRoot: "/w/proj", branch: "main", dirty: false })).toBe("main")
  expect(placeLabel({ cwd: "/w/proj", repoRoot: "/w/proj", branch: "feat/x", dirty: true })).toBe("feat/x*")
  expect(placeLabel({ cwd: "/w/wt", repoRoot: "/w/wt", branch: "side", isWorktree: true })).toBe(
    "side (worktree)",
  )
  expect(placeLabel({ cwd: "/w/proj", repoRoot: "/w/proj", head: "abc1234", dirty: true })).toBe("@abc1234*")
})

test("the context turns to a warning above 70% of the window, and an error above 90%", async () => {
  expect([0, 70, 71, 90, 91].map((pct) => contextTone(pct * 1000, 100_000))).toEqual([
    "muted",
    "muted",
    "warning",
    "warning",
    "error",
  ])
  expect(contextTone(5000, undefined)).toBe("muted")

  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  await host.load(statusExtension, "builtin:status")
  const meta = { sessionId: "s" }
  const model = { provider: "p", model: "m" }
  const reply = (input: number) =>
    bus.emit(
      "message.end",
      {
        message: {
          role: "assistant",
          content: [],
          model,
          usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
      meta,
    )
  bus.emit("message.start", { model, contextWindow: 100_000 }, meta)
  reply(85_000)
  await bus.flush()
  expect(item(host, "context")).toMatchObject({ text: "ctx 85k/100k (85%)", tone: "warning" })
  reply(95_000)
  await bus.flush()
  expect(item(host, "context")).toMatchObject({ text: "ctx 95k/100k (95%)", tone: "error" })
})

test("an interrupted reply without usage keeps the last known context", async () => {
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  await host.load(statusExtension, "builtin:status")
  const meta = { sessionId: "s" }
  const model = { provider: "p", model: "m" }
  const end = (input: number, stopReason?: "aborted") =>
    bus.emit(
      "message.end",
      {
        message: {
          role: "assistant",
          content: [],
          model,
          ...(stopReason ? { stopReason } : {}),
          usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
      meta,
    )
  bus.emit("message.start", { model, contextWindow: 128_000 }, meta)
  end(29_400)
  end(0, "aborted")
  await bus.flush()
  expect(item(host, "context")?.text).toBe("ctx 29k/128k (23%)")
})

test("resets the counters on clear", async () => {
  const { bus, host, agent } = setup()
  await host.load(statusExtension, "builtin:status")
  await agent.prompt("go")
  await bus.flush()
  expect(item(host, "context")).toBeDefined()
  agent.start("clear")
  await bus.flush()
  expect(item(host, "context")).toBeUndefined()
})

test("the activity, sub-agents, output tokens, cache and speed are not in the status", async () => {
  const { bus, host, agent } = setup()
  await host.load(statusExtension, "builtin:status")
  bus.emit("status.changed", { status: "working", reason: "retrying (2/3)" }, { sessionId: "s" })
  await agent.prompt("go")
  await bus.flush()
  expect(host.status.snapshot().map((i) => i.id)).toEqual(["model", "context"])
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
  expect(item(host, "model")).toEqual({
    id: "model",
    align: "left",
    tone: "warning",
    priority: 0,
    text: "custom",
  })
  host.unload("user")
  expect(host.status.snapshot()[0]?.text).toBe("m1")
  // Without override: true, a duplicate id fails that extension only.
  expect(
    await host.load((api) => {
      api.registerStatusItem({ id: "model", text: () => "clash" })
    }, "clash"),
  ).toBe(false)
  expect(host.status.snapshot()[0]?.text).toBe("m1")
})

test("other extensions' items follow the built-in ones on their side and have the lowest priority", async () => {
  const { bus, host, agent } = setup()
  await host.load(statusExtension, "builtin:status")
  await host.load((api) => {
    api.registerStatusItem({ id: "mine", align: "right", text: () => "mine" })
    api.registerStatusItem({ id: "first", align: "left", text: () => "first" })
  }, "user")
  agent.start("startup")
  await bus.flush()
  expect(host.status.snapshot().map((i) => [i.id, i.priority])).toEqual([
    ["model", 40],
    ["place", 10],
    ["mine", 0],
    ["first", 0],
  ])
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

test("bad item texts, tones and priorities are skipped or sanitized, and defaults apply", async () => {
  const { host } = setup()
  let tone: unknown = "error"
  await host.load((api) => {
    api.registerStatusItem({ id: "num", text: () => 42 as never })
    api.registerStatusItem({ id: "nl", order: 5, priority: Number.NaN, text: () => "two\nlines\x1b[31m" })
    api.registerStatusItem({ id: "first", order: -1, priority: 3, text: () => "x" })
    api.registerStatusItem({ id: "live", order: 9, tone: () => tone as never, text: () => "y" })
    api.registerStatusItem({
      id: "throws",
      text: () => {
        throw new Error("x")
      },
    })
  }, "t")
  expect(host.status.snapshot()).toEqual([
    { id: "first", align: "left", tone: "default", priority: 3, text: "x" },
    { id: "nl", align: "left", tone: "default", priority: 0, text: "two lines [31m" },
    { id: "live", align: "left", tone: "error", priority: 0, text: "y" },
  ])
  tone = "blinking"
  expect(host.status.snapshot().at(-1)?.tone).toBe("default")
  tone = () => {
    throw new Error("x")
  }
  expect(host.status.snapshot().at(-1)?.tone).toBe("default")
})

test("context shows use against the window", () => {
  expect(formatContext(12_300, 128_000)).toBe("12k/128k (10%)")
  expect(formatContext(29_400, 128_000)).toBe("29k/128k (23%)")
  expect(formatContext(500, undefined)).toBe("500")
})

test("formats costs with more digits for small amounts", () => {
  expect([0, 0.00001, 0.00012, 0.0123, 0.4567, 1.234, 25].map(formatCost)).toEqual([
    "$0.000",
    "<$0.0001",
    "$0.0001",
    "$0.012",
    "$0.457",
    "$1.23",
    "$25.00",
  ])
})

test("the cost adds up the replies that have one", async () => {
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
  end()
  await bus.flush()
  expect(item(host, "context")?.text).toBe("ctx 1.1k")
  expect(item(host, "cost")).toBeUndefined()
  end(0.004)
  end(0.008)
  await bus.flush()
  expect(item(host, "cost")?.text).toBe("$0.012")
})

test("sub-agents add to the cost, but do not change the rest of the status", async () => {
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  await host.load(statusExtension, "builtin:status")
  const root = { sessionId: "s" }
  const child = { sessionId: "c", parentSessionId: "s" }
  const text = (id: string) => item(host, id)?.text
  const usage = (input: number, cost: number) => ({ input, output: 10, cacheRead: 0, cacheWrite: 0, cost })
  bus.emit("message.start", { model: { provider: "p", model: "big" } }, root)
  bus.emit(
    "message.end",
    {
      message: {
        role: "assistant",
        content: [],
        model: { provider: "p", model: "big" },
        usage: usage(1000, 0.01),
      },
    },
    root,
  )
  bus.emit("message.start", { model: { provider: "p", model: "small" } }, child)
  bus.emit(
    "message.end",
    {
      message: {
        role: "assistant",
        content: [],
        model: { provider: "p", model: "small" },
        usage: usage(50, 0.001),
      },
    },
    child,
  )
  await bus.flush()
  expect(text("model")).toBe("big")
  expect(text("context")).toBe("ctx 1.0k")
  expect(text("cost")).toBe("$0.011")
  // The tree's total also has what was spent outside any reply, e.g. asking the commander to approve.
  bus.emit("budget.update", { tokens: 2000, costUsd: 0.02 }, root)
  await bus.flush()
  expect(text("cost")).toBe("$0.020")
})
