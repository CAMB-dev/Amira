import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { Agent, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import statusExtension, { formatTokens } from "../src/index.ts"

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
    ["tokens", "right", "ctx 2.0k · out 30"],
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
