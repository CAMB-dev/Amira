import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent, SessionControl } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { CommandHost, CommandRegistry } from "../src/commands.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { SessionStore } from "../src/session-store.ts"
import { ToolRegistry } from "../src/tool-registry.ts"
import { UiRequests } from "../src/ui-requests.ts"

test("persisted command display entries never enter live or resumed provider requests", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-display-"))
  const mock = createMockDialect([{ text: "main answer" }, { text: "resumed answer" }])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const store = SessionStore.create({ cwd: dir, dir })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: dir, session: store, bus, systemPrompt: "" })
  const registry = new CommandRegistry()
  const host = new CommandHost({
    registry,
    bus,
    agent,
    ui: new UiRequests(bus),
    control: {} as SessionControl,
  })
  registry.register(
    {
      name: "btw",
      description: "display only",
      echo: false,
      run: (_args, ctx) => {
        ctx.print("btw: secret question", "info", {
          details: "**secret side answer**",
          markdown: true,
          persist: true,
        })
        ctx.print("transient question", "warning", { details: "transient answer" })
      },
    },
    "test",
  )
  let resumed: Agent | undefined
  try {
    expect((await host.run("/btw", { frontend: "tui" })).ok).toBe(true)
    expect(existsSync(store.file)).toBe(true)
    expect(store.branch().filter((entry) => entry.type === "display")).toHaveLength(1)
    expect(store.restore().messages).toEqual([])
    await agent.prompt("ordinary main question")
    await bus.flush()
    expect(events.find((e) => e.type === "command.output")?.data).toMatchObject({
      details: "**secret side answer**",
      markdown: true,
      persist: true,
    })
    await agent.dispose()
    const reopened = SessionStore.open(store.file)
    expect(reopened.branch().find((entry) => entry.type === "display")).toMatchObject({
      text: "btw: secret question",
      details: "**secret side answer**",
      markdown: true,
    })
    resumed = new Agent({ ai, model: ai.model("mock/m"), cwd: dir, session: reopened, systemPrompt: "" })
    await resumed.prompt("continue main conversation")
    for (const request of mock.requests) {
      const text = JSON.stringify(request)
      expect(text).not.toContain("secret question")
      expect(text).not.toContain("secret side answer")
      expect(text).not.toContain("transient answer")
      expect(text).toContain("ordinary main question")
    }
  } finally {
    await resumed?.dispose()
    await agent.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("notify shares display options and persists without adding a message", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-display-notify-"))
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const store = SessionStore.create({ cwd: dir, dir })
  const agent = new Agent({
    ai,
    model: ai.model("mock/m"),
    cwd: dir,
    session: store,
    bus,
    tools,
    systemPrompt: "",
  })
  const host = new ExtensionHost({ bus, tools, interceptors: new InterceptorRegistry() })
  host.setSessionControl({} as SessionControl, () => agent)
  try {
    await host.load(
      (api) => api.notify("btw: notified", "success", { details: "side answer", persist: true }),
      "test",
    )
    expect(store.branch().find((entry) => entry.type === "display")).toMatchObject({
      text: "btw: notified",
      level: "success",
    })
    expect(store.restore().messages).toEqual([])
  } finally {
    host.unloadAll()
    await agent.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
