import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import statusExtension, { formatTokens } from "../src/index.ts"

test("formats token counts compactly", () => {
  expect([999, 1234, 45_600, 2_500_000].map(formatTokens)).toEqual(["999", "1.2k", "46k", "2.5M"])
})

test("fills the status bar from session events", async () => {
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  expect(await host.load(statusExtension, "builtin:status")).toBe(true)
  let renders = 0
  bus.subscribe(() => void renders++, { types: ["ui.render"] })

  const ai = createAi({
    dialects: [createMockDialect([{ text: "hi", usage: { input: 1200, output: 30, cacheRead: 800 } }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m1"), cwd: "/work/proj", systemPrompt: "", bus })
  agent.start("startup", { repoRoot: "/work/proj", branch: "main" })
  await agent.prompt("go")
  await bus.flush()

  const items = host.status.snapshot()
  expect(items.map((i) => [i.id, i.align, i.text])).toEqual([
    ["model", "left", "mock/m1"],
    ["tokens", "right", "ctx 2.0k · out 30"],
    ["place", "right", "proj ⎇ main"],
  ])
  expect(renders).toBeGreaterThan(0)
})

test("a throwing status item is skipped instead of breaking the bar", async () => {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  await host.load((api) => {
    api.registerStatusItem({
      id: "bad",
      text: () => {
        throw new Error("x")
      },
    })
    api.registerStatusItem({ id: "ok", text: () => "fine" })
  }, "t")
  expect(host.status.snapshot().map((i) => i.id)).toEqual(["ok"])
  host.unload("t")
  expect(host.status.snapshot()).toEqual([])
})
