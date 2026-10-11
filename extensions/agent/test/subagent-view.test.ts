import { expect, test } from "bun:test"
import {
  type AssistantMessage,
  defineTool,
  emptyUsage,
  type Message,
  type SessionControl,
  type SubagentInfo,
  textResult,
  type ViewDefinition,
  type ViewLine,
  type ViewSegment,
} from "@amira/api"
import statusExtension from "../../../extensions/status/src/index.ts"
import terminalStatusExtension from "../../../extensions/terminal-status/src/index.ts"
import { createAi, createMockDialect, type MockStep, userMessage } from "../../../packages/ai/src/index.ts"
import {
  Agent,
  AgentTree,
  CommandHost,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  listSubagents,
  ToolRegistry,
} from "../../../packages/core/src/index.ts"
import { runInteractive } from "../../../packages/tui/src/app.ts"
import { ExtensionViewer } from "../../../packages/tui/src/extension-view.ts"
import { userLines } from "../../../packages/tui/src/format.ts"
import {
  defaultTheme,
  FakeTerminal,
  monoTheme,
  stripAnsi,
  surfaceTheme,
} from "../../../packages/tui-kit/src/index.ts"
import { VirtualScreen } from "../../../packages/tui-kit/test/screen.ts"
import { agentsCommand } from "../src/index.ts"
import { subagentView } from "../src/subagent-view.ts"

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

/**
 * The interactive UI on a fake terminal with an agent tree and /agents. The `delegate` tool
 * starts one sub-agent per role in `roles`, one after the other; `wait` blocks until
 * `release()` is called.
 */
async function setup(steps: MockStep[], o: { cols?: number; rows?: number } = {}) {
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  await host.load(statusExtension, "builtin:status")
  await host.load(terminalStatusExtension, "builtin:terminal-status")
  await host.load((api) => {
    api.registerCommand(agentsCommand())
    api.registerView(subagentView(api))
  }, "builtin:agent")
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const agent = new Agent({
    ai,
    model: ai.model("mock/m1"),
    cwd: "/work",
    systemPrompt: "",
    bus,
    tools,
    tree,
  })
  let release!: () => void
  let waiting = false
  const gate = new Promise<void>((r) => {
    release = r
  })
  tools.register(
    defineTool<{ path: string }>({
      name: "read",
      description: "",
      parameters: {},
      execute: async (p) => textResult(`contents of ${p.path}\nline 2\nline 3`),
    }),
    "test",
  )
  tools.register(
    defineTool({
      name: "wait",
      description: "",
      parameters: {},
      execute: async () => {
        waiting = true
        await gate
        return textResult("waited")
      },
    }),
    "test",
  )
  tools.register(
    defineTool<{ roles: string[] }>({
      name: "delegate",
      description: "",
      parameters: {},
      execute: async (p, ctx) => {
        const answers: string[] = []
        for (const role of p.roles) {
          const r = await ctx.session!.spawn!({
            role,
            title: `Check ${role}`,
            prompt: `task for the ${role}`,
          }).result()
          answers.push(r.text)
        }
        return textResult(answers.join("\n"))
      },
    }),
    "test",
  )
  const control = {
    subagents: () => listSubagents(agent, tree).map((e) => e.info),
    subagentMessages: (id: string) =>
      listSubagents(agent, tree)
        .find((e) => e.info.id === id)
        ?.messages(),
    stopSubagent: (id: string) => tree.stop(id, "stopped by the user"),
  } as Partial<SessionControl> as SessionControl
  host.setSessionControl(control, () => agent)
  const commands = new CommandHost({ registry: host.commands, bus, ui: host.ui, control, agent })
  const cols = o.cols ?? 60
  const rows = o.rows ?? 20
  const terminal = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const write = terminal.write.bind(terminal)
  terminal.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  const resize = (c: number, r: number) => {
    screen.resize(c, r)
    terminal.setSize(c, r)
  }
  const exited = runInteractive({
    bindTerminal: (t) => host.bindTerminal(t),
    agent,
    status: host.status,
    ui: host.ui,
    commands,
    views: host.views,
    toolRenderers: host.renderers,
    terminal,
    setup: async () => ({
      capabilities: {
        win32InputMode: false,
        kittyKeyboard: true,
        synchronizedOutput: false,
        shiftEnter: true,
      },
      leftoverInput: "",
    }),
    env: {},
    onReady: () => agent.start("startup"),
  })
  const view = () => screen.lines.join("\n")
  const idle = async () => {
    await waitFor(() => agent.status === "idle", "idle")
    await bus.flush()
    await Bun.sleep(40)
  }
  await waitFor(() => screen.text.includes("Amira"), "startup")
  return {
    agent,
    bus,
    host,
    control,
    terminal,
    screen,
    resize,
    view,
    idle,
    exited,
    release,
    isWaiting: () => waiting,
  }
}

const ESC = "\x1b[27u"

function lineText(line: string | ViewLine): string {
  if (typeof line === "string") return line
  return line.kind === "segments"
    ? line.parts.map((part) => (part.kind === "chip" ? `[${part.text}]` : part.text)).join("")
    : line.text
}

function requireRenderer<D>(
  view: ViewDefinition<D>,
): asserts view is ViewDefinition<D> & Required<Pick<ViewDefinition<D>, "render">> {
  if (!view.render) throw new Error("The legacy subagent view must provide render")
}

async function snapshotView() {
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m1"), cwd: "/work", systemPrompt: "", bus, tools })
  const list: SubagentInfo[] = ["a", "b"].map((id) => ({
    id,
    parentSessionId: agent.sessionId,
    depth: 1,
    role: "explorer",
    title: `Child ${id}`,
    task: `Task ${id}`,
    status: "running",
    startedAt: 1000,
    usage: { ...emptyUsage(), input: 1500, output: 50, cost: 0.0123 },
  }))
  const histories = new Map<string, Message[]>()
  for (const info of list) histories.set(info.id, [userMessage("parent history"), userMessage(info.task)])
  const stopped: string[] = []
  const control = {
    subagents: () => list,
    subagentMessages: (id: string) => histories.get(id),
    stopSubagent: (id: string) => {
      stopped.push(id)
      return true
    },
  } as Partial<SessionControl> as SessionControl
  host.setSessionControl(control, () => agent)
  let definition!: ViewDefinition<{ sessionId: string }>
  await host.load((api) => {
    definition = subagentView(api)
    api.registerView(definition)
  }, "builtin:agent")
  requireRenderer(definition)
  const data = { sessionId: "a" }
  const context = { theme: monoTheme, color: false, rows: 20 }
  const viewer = new ExtensionViewer(definition, data, { now: () => 6500 })
  const render = () => viewer.render(80, context).map(stripAnsi).join("\n")
  const meta = { sessionId: "a", parentSessionId: agent.sessionId }
  return { bus, host, agent, list, histories, stopped, definition, data, viewer, render, meta }
}

test("subagent view does not request renders for unrelated main-session events", async () => {
  const s = await snapshotView()
  let renders = 0
  const unsubscribe = s.bus.subscribe(
    () => {
      renders++
    },
    { types: ["ui.render"] },
  )
  const settle = async () => {
    await s.bus.flush()
    await Bun.sleep(5)
    await s.bus.flush()
  }
  try {
    await settle()
    renders = 0
    const meta = { sessionId: s.agent.sessionId }
    s.bus.emit("message.delta", { kind: "text", text: "main reply" }, meta)
    await settle()
    expect(renders).toBe(0)

    s.bus.emit("message.start", { model: { provider: "mock", model: "m1" } }, meta)
    s.bus.emit(
      "message.end",
      { message: { role: "assistant", model: { provider: "mock", model: "m1" }, content: [] } },
      meta,
    )
    s.bus.emit("turn.end", { reason: "aborted", steps: 1 }, meta)
    s.bus.emit("ui.request", { kind: "confirm", requestId: "main", title: "Continue?" }, meta)
    s.bus.emit("ui.resolved", { requestId: "main", cancelled: false, value: true }, meta)
    s.bus.emit(
      "session.start",
      { reason: "clear", cwd: "/work", model: { provider: "mock", model: "m1" } },
      meta,
    )
    s.bus.emit("session.end", { reason: "switch" }, meta)
    await settle()
    expect(renders).toBe(0)
  } finally {
    unsubscribe()
    s.host.unload("builtin:agent")
  }
})

test("subagent view requests renders for child activity and parent-reported child status", async () => {
  const s = await snapshotView()
  let renders = 0
  const unsubscribe = s.bus.subscribe(
    () => {
      renders++
    },
    { types: ["ui.render"] },
  )
  const expectRender = async (emit: () => void) => {
    await s.bus.flush()
    await Bun.sleep(5)
    await s.bus.flush()
    const before = renders
    emit()
    await s.bus.flush()
    await Bun.sleep(5)
    await s.bus.flush()
    expect(renders).toBe(before + 1)
  }
  try {
    await expectRender(() =>
      s.bus.emit("message.start", { model: { provider: "mock", model: "m1" } }, s.meta),
    )
    await expectRender(() => s.bus.emit("message.delta", { kind: "thinking", text: "reason" }, s.meta))
    expect(s.render().split("\n")[0]).toContain(" · running · ")
    expect(s.render()).not.toContain("… thinking")
    await expectRender(() => s.bus.emit("message.delta", { kind: "text", text: "child reply" }, s.meta))
    expect(s.render()).toContain("child reply")
    await expectRender(() =>
      s.bus.emit("ui.request", { kind: "confirm", requestId: "child", title: "Continue?" }, s.meta),
    )
    await expectRender(() =>
      s.bus.emit("ui.resolved", { requestId: "child", cancelled: false, value: true }, s.meta),
    )
    await expectRender(() =>
      s.bus.emit(
        "message.end",
        { message: { role: "assistant", model: { provider: "mock", model: "m1" }, content: [] } },
        s.meta,
      ),
    )
    expect(s.render()).not.toContain("child reply")
    await expectRender(() => s.bus.emit("turn.end", { reason: "aborted", steps: 1 }, s.meta))
    const meta = { sessionId: s.agent.sessionId }
    await expectRender(() =>
      s.bus.emit(
        "subagent.start",
        {
          childSessionId: "a",
          prompt: "Task a",
          model: { provider: "mock", model: "m1" },
          depth: 1,
          cwd: "/work",
          context: "fresh",
          queued: false,
        },
        meta,
      ),
    )
    s.list[0]!.status = "paused"
    await expectRender(() =>
      s.bus.emit("subagent.state", { childSessionId: "a", state: "paused", turns: 1 }, meta),
    )
    expect(s.render().split("\n")[0]).toContain(" · paused · ")
    await expectRender(() => s.bus.emit("message.delta", { kind: "text", text: "partial reply" }, s.meta))
    s.list[0]!.status = "done"
    await expectRender(() =>
      s.bus.emit(
        "subagent.end",
        { childSessionId: "a", status: "done", usage: emptyUsage(), durationMs: 1000 },
        meta,
      ),
    )
    expect(s.render()).not.toContain("partial reply")
    expect(s.render()).toContain("── done ──")
  } finally {
    unsubscribe()
    s.host.unload("builtin:agent")
  }
})

test("subagent view requests a render when main-session lifecycle clears live streams", async () => {
  const s = await snapshotView()
  let renders = 0
  const unsubscribe = s.bus.subscribe(
    () => {
      renders++
    },
    { types: ["ui.render"] },
  )
  const settle = async () => {
    await s.bus.flush()
    await Bun.sleep(5)
    await s.bus.flush()
  }
  try {
    for (const type of ["session.start", "session.end"] as const) {
      s.bus.emit("message.delta", { kind: "text", text: "stale reply" }, s.meta)
      await settle()
      expect(s.render()).toContain("stale reply")
      const before = renders
      const meta = { sessionId: s.agent.sessionId }
      const clear = () => {
        if (type === "session.start")
          s.bus.emit(type, { reason: "clear", cwd: "/work", model: { provider: "mock", model: "m1" } }, meta)
        else s.bus.emit(type, { reason: "switch" }, meta)
      }
      clear()
      await settle()
      expect(renders).toBe(before + 1)
      expect(s.render()).not.toContain("stale reply")
      clear()
      await settle()
      expect(renders).toBe(before + 1)
    }
  } finally {
    unsubscribe()
    s.host.unload("builtin:agent")
  }
})

test("streaming before opening is visible, thinking changes live, and snapshots replace deltas", async () => {
  const s = await snapshotView()
  s.bus.emit("message.start", { model: { provider: "mock", model: "m1" } }, s.meta)
  s.bus.emit("message.delta", { kind: "thinking", text: "reason" }, s.meta)
  await s.bus.flush()
  expect(s.render().split("\n")[0]).toContain(" · running · ")
  expect(s.render()).not.toContain("… thinking")
  expect(s.render()).not.toContain("parent history")
  s.bus.emit("message.delta", { kind: "text", text: "streamed " }, s.meta)
  s.bus.emit("message.delta", { kind: "text", text: "reply" }, s.meta)
  s.bus.emit("message.delta", { kind: "text", text: "main session reply" }, { sessionId: s.agent.sessionId })
  await s.bus.flush()
  expect(s.render()).toContain("streamed reply")
  expect(s.render()).not.toContain("… working")
  expect(s.render()).not.toContain("main session reply")
  const reply: AssistantMessage = {
    role: "assistant",
    model: { provider: "mock", model: "m1" },
    content: [{ type: "text", text: "streamed reply" }],
  }
  s.histories.get("a")!.push(reply)
  s.bus.emit("message.end", { message: reply }, s.meta)
  await s.bus.flush()
  expect(s.render().split("streamed reply")).toHaveLength(2)
  s.bus.emit("message.delta", { kind: "text", text: "aborted partial" }, s.meta)
  s.bus.emit("turn.end", { reason: "aborted", steps: 1 }, s.meta)
  await s.bus.flush()
  expect(s.render()).not.toContain("aborted partial")
  s.bus.emit("message.delta", { kind: "text", text: "old session" }, s.meta)
  s.bus.emit(
    "session.start",
    { reason: "clear", cwd: "/work", model: { provider: "mock", model: "m1" } },
    { sessionId: "next" },
  )
  await s.bus.flush()
  expect(s.render()).not.toContain("old session")
  s.host.unload("builtin:agent")
  s.bus.emit("message.delta", { kind: "text", text: "after unload" }, s.meta)
  await s.bus.flush()
  expect(s.render()).not.toContain("after unload")
})

test("queued, idle, finished, failed and stopped children retain their status, usage and reasons", async () => {
  const s = await snapshotView()
  expect(lineText(s.definition.title(s.data, { width: 80, now: 6500 }))).toBe(
    "◆ Child a · running · 5s · 1.6k tok · $0.0123 · explorer · a",
  )
  expect(s.definition.titleAside!(s.data)).toBe("1 of 2")
  expect(s.definition.header!(s.data, { width: 80, now: 6500 })[0]).toEqual({
    kind: "muted",
    text: "task: Task a",
  })
  s.list[0]!.status = "queued"
  expect(s.render().split("\n")[0]).toContain(" · queued · ")
  s.list[0]!.status = "idle"
  expect(s.render().split("\n")[0]).toContain(" · idle · ")
  expect(s.definition.keys?.map((key) => key.key)).toContain("x")
  s.list[0]!.status = "paused"
  expect(s.render().split("\n")[0]).toContain(" · paused · ")
  expect(s.render()).not.toContain("… working")
  expect(s.definition.keys?.map((key) => key.key)).toContain("x")
  s.list[0]!.status = "error"
  s.list[0]!.error = "failed to start"
  expect(s.render()).toContain("✗ failed to start")
  expect(s.definition.keys?.map((key) => key.key)).not.toContain("x")
  s.list[0]!.status = "aborted"
  delete s.list[0]!.error
  s.list[0]!.note = "turn limit"
  expect(s.render()).toContain("⊘ stopped: turn limit")
  s.list[0]!.status = "done"
  s.list[0]!.durationMs = 2100
  expect(s.render()).toContain("── done ──")
  expect(s.render()).toContain("done · 2s")
  s.data.sessionId = "missing"
  expect(s.render()).toContain("No sub-agent missing in this session.")
})

test("the extension associates nested children with calls and delegates completed and provider tools", async () => {
  const s = await snapshotView()
  const own = s.histories.get("a")!
  const callId = "call_1"
  s.list[1]!.parentSessionId = "a"
  s.list[1]!.toolCallId = callId
  own.push(
    {
      role: "assistant",
      model: { provider: "mock", model: "m1" },
      content: [
        { type: "toolCall", id: callId, name: "agent", args: { tasks: [{ prompt: "Task b" }] } },
        {
          type: "serverTool",
          id: "search",
          name: "web_search",
          input: { query: "typescript" },
          status: "done",
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: callId,
      toolName: "agent",
      content: [{ type: "text", text: "started" }],
      isError: false,
    },
  )
  const calls: { name: string; text: string; detail: string }[] = []
  const lines = s.definition.render(s.data, {
    width: 80,
    now: 6500,
    renderTool: (name, call, detail) => {
      calls.push({ name, text: call.text, detail })
      return [{ kind: "accent", text: `presented ${name}` }]
    },
  })
  expect(calls).toMatchObject([
    { name: "agent", text: "started", detail: "summary" },
    { name: "web_search", detail: "summary" },
  ])
  expect(lines.map(lineText)).toContain("presented agent")
  const child = lines.filter((line) => lineText(line).includes("◆ Child b"))
  expect(child).toHaveLength(1)
  expect(lineText(child[0]!)).toStartWith("  │  ◆ Child b")
  expect(child[0]?.kind === "segments" && child[0].parts[0]).toEqual({ kind: "text", text: "  │  " })
})

const statuses: {
  status: SubagentInfo["status"]
  text: string
  kind: Exclude<ViewSegment["kind"], "chip">
}[] = [
  { status: "running", text: "running", kind: "accent" },
  { status: "queued", text: "queued", kind: "muted" },
  { status: "idle", text: "idle", kind: "muted" },
  { status: "done", text: "done", kind: "success" },
  { status: "error", text: "failed", kind: "error" },
  { status: "aborted", text: "stopped", kind: "warning" },
]

for (const { status, text, kind } of statuses) {
  test(`${status} titles and child rows preserve semantic styles`, async () => {
    const s = await snapshotView()
    s.list[0]!.status = status
    s.list[1]!.status = status
    s.list[1]!.parentSessionId = "a"
    const opts = { width: 80, now: 6500 }
    const timing = status === "queued" ? "" : " · 5s"
    const stats: ViewSegment[] = [
      { kind, text },
      { kind: "muted", text: `${timing} · 1.6k tok · $0.0123` },
    ]
    expect(s.definition.title(s.data, opts)).toEqual({
      kind: "segments",
      parts: [
        { kind: "accent", text: "◆" },
        { kind: "text", text: " Child a " },
        { kind: "muted", text: "·" },
        { kind: "text", text: " " },
        ...stats,
        { kind: "muted", text: " · explorer · a" },
      ],
    })
    // Expectations mirror the deleted frontend viewer's theme calls, not just the API shape.
    const theme = { ...defaultTheme, ...surfaceTheme("dark") }
    const rows = s.viewer.render(120, { theme, color: true, rows: 20 })
    const styledStats = `${theme[kind](text)}${theme.muted(`${timing} · 1.6k tok · $0.0123`)}`
    const title = `${theme.accent("◆")} Child a ${theme.muted("·")} ${styledStats}${theme.muted(" · explorer · a")}`
    expect(rows[0]).toBe(title + " ".repeat(120 - stripAnsi(title).length - 7) + theme.muted(" 1 of 2"))
    expect(rows).toContain(
      `${theme.accent("◆")} Child b ${theme.muted("· explorer · b")} ${styledStats} ${theme.muted("· Task b")}`,
    )
    const task = userLines(theme, userMessage("Task a"), 120)
    expect(rows.slice(3, 3 + task.length)).toEqual(task)
    expect(s.definition.render(s.data, opts).find((line) => line.kind === "segments")).toEqual({
      kind: "segments",
      parts: [
        { kind: "text", text: "" },
        { kind: "accent", text: "◆" },
        { kind: "text", text: " Child b " },
        { kind: "muted", text: "· explorer · b" },
        { kind: "text", text: " " },
        ...stats,
        { kind: "text", text: " " },
        { kind: "muted", text: "· Task b" },
      ],
    })
  })
}

test("task bands use semantic user messages and retain display text and empty-task fallback", async () => {
  const s = await snapshotView()
  const opts = { width: 80, now: 6500 }
  expect(s.definition.render(s.data, opts)[0]).toEqual({ kind: "user-message", text: "Task a" })
  s.histories.set("a", [userMessage("first line\nsecond line")])
  expect(s.definition.render(s.data, opts)[0]).toEqual({
    kind: "user-message",
    text: "first line\nsecond line",
  })
  s.histories.set("a", [{ ...userMessage("hidden"), display: { text: "visible task" } }])
  expect(s.definition.render(s.data, opts)[0]).toEqual({ kind: "user-message", text: "visible task" })
  const message = { ...userMessage("hidden"), display: { text: "visible task", note: "task note" } }
  s.histories.set("a", [message])
  expect(s.definition.render(s.data, opts)[0]).toEqual({
    kind: "user-message",
    text: "visible task",
    note: "task note",
  })
  const theme = { ...defaultTheme, ...surfaceTheme("dark") }
  const expected = userLines(theme, message, 80)
  expect(s.viewer.render(80, { theme, color: true, rows: 20 }).slice(3, 3 + expected.length)).toEqual(
    expected,
  )
  s.histories.set("a", [])
  s.list[0]!.task = ""
  expect(s.definition.render(s.data, opts)[0]).toEqual({ kind: "user-message", text: "(no task)" })
})

test("missing children have a warning title without an automatic diamond", async () => {
  const s = await snapshotView()
  s.data.sessionId = "missing"
  expect(s.definition.title(s.data, { width: 80, now: 6500 })).toEqual({
    kind: "warning",
    text: "No sub-agent missing in this session.",
  })
  expect(s.render()).toContain("No sub-agent missing in this session.")
  expect(s.render()).not.toContain("◆")
  expect(s.viewer.render(80, { theme: defaultTheme, color: true, rows: 20 })[0]).toBe(
    defaultTheme.warning("No sub-agent missing in this session."),
  )
})

test("each child keeps its scroll position and follows independently when switching with Shift+Tab", async () => {
  const s = await snapshotView()
  for (const info of s.list)
    s.histories.get(info.id)!.push({
      role: "assistant",
      model: { provider: "mock", model: "m1" },
      content: [
        { type: "text", text: Array.from({ length: 40 }, (_, i) => `${info.id} row ${i}`).join("\n") },
      ],
    })
  const event = (name: string, shift = false) => ({
    type: "key" as const,
    name,
    ctrl: false,
    alt: false,
    shift,
  })
  s.render()
  s.viewer.handleInput(event("home"))
  s.viewer.handleInput(event("down"))
  const first = s.viewer.scroll
  s.viewer.handleInput(event("tab"))
  expect(s.render()).toContain("b row 39")
  expect(s.viewer.scroll.position.following).toBe(true)
  s.viewer.handleInput(event("pageup"))
  const secondTop = s.viewer.scroll.position.top
  s.viewer.handleInput(event("tab", true))
  s.render()
  expect(s.data.sessionId).toBe("a")
  expect(s.viewer.scroll).toBe(first)
  expect(first.position).toMatchObject({ top: 1, following: false })
  s.viewer.handleInput(event("right"))
  s.render()
  expect(s.viewer.scroll.position.top).toBe(secondTop)
})

test("/agents view shows a running sub-agent live; main-session lines land in the scrollback after Esc", async () => {
  const s = await setup([
    { toolCalls: [{ name: "delegate", args: { roles: ["explorer"] } }] },
    { toolCalls: [{ name: "read", args: { path: "a.ts" } }], usage: { input: 1500, output: 20 } },
    { text: "Now waiting.", toolCalls: [{ name: "wait", args: {} }] },
    { text: "child final answer" },
    { text: "all done" },
  ])
  s.terminal.send("go\r")
  await waitFor(s.isWaiting, "the child to block")
  const before = s.screen.mainText
  s.terminal.send("/agents view\r")
  await waitFor(() => s.screen.inAltScreen, "the viewer")
  await waitFor(() => /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] wait +\d+s$/m.test(s.view()), "the transcript")
  const lines = s.screen.lines
  expect(lines[0]).toMatch(/^◆ Check explorer · running · \d+s · 1\.5k tok · .+ 1 of 1$/)
  expect(lines[1]).toBe("task: task for the explorer")
  // Shared transcript rendering: one gap, closed tool groups, and inset reply text.
  expect(lines.slice(3, 13)).toEqual([
    "",
    "  › task for the explorer",
    "",
    "",
    "  └ read a.ts  ✓ contents of a.ts (+2 lines)",
    "",
    "  Now waiting.",
    "",
    "  ───",
    "",
  ])
  expect(lines[13]).toMatch(/^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] wait +\d+s$/)
  expect(s.view()).not.toContain("└ running")
  expect(s.view()).not.toContain("… working")
  expect(lines.at(-1)).toContain("following")
  const atOpen = s.screen.mainText
  expect(atOpen).toContain(before.split("\n")[0]!)
  // The child goes on: its reply shows up at the bottom, and the main session finishes.
  s.release()
  await waitFor(() => s.view().includes("── done ──"), "the child to finish in the viewer")
  expect(s.view()).toContain("child final answer")
  await s.idle()
  expect(s.screen.inAltScreen).toBe(true)
  // Nothing was drawn on the main screen meanwhile.
  expect(s.screen.mainText).toBe(atOpen)
  s.terminal.send(ESC)
  await waitFor(() => !s.screen.inAltScreen, "the inline UI")
  const main = s.screen.mainText
  const order = ["› go", "› /agents view", "  └ delegate", "✓ child final answer", "all done"].map((t) =>
    main.indexOf(t),
  )
  expect(order.every((i) => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(main.split("all done").length).toBe(2)
  expect(main).not.toContain("◆ Check explorer running")
  // The live region is back: the editor box and the hint line.
  expect(s.view()).toContain(" shift+tab mode  │  ctrl+o detail  │  ? keys")
  expect(s.view()).toContain("│ › Message Amira")
  expect(s.screen.altSwitches).toEqual([true, false])
  s.terminal.send("\x03")
  await s.exited
})

test("elapsed time redraws every second while no child event arrives", async () => {
  const s = await setup([
    { toolCalls: [{ name: "delegate", args: { roles: ["explorer"] } }] },
    { toolCalls: [{ name: "wait", args: {} }] },
    { text: "child done" },
    { text: "all done" },
  ])
  s.terminal.send("go\r")
  await waitFor(s.isWaiting, "the waiting child")
  s.terminal.send("/agents view\r")
  await waitFor(() => /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] wait +\d+s$/m.test(s.view()), "the view")
  const before = s.screen.lines[0]!
  const spin = () => s.view().match(/^ {2}([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) wait/m)?.[1]
  const firstFrame = spin()
  await waitFor(() => spin() !== firstFrame, "the overlay spinner frame", 400)
  await waitFor(() => s.screen.lines[0] !== before, "the elapsed tick", 2500)
  expect(s.screen.lines[0]).toMatch(/^◆ Check explorer · running · \d+s/)
  s.release()
  await s.idle()
  s.terminal.send(ESC)
  await waitFor(() => !s.screen.inAltScreen, "closed")
  s.terminal.send("\x03")
  await s.exited
})

test("x in the viewer stops the running sub-agent after y confirms; another key keeps it", async () => {
  const s = await setup(
    [
      { toolCalls: [{ name: "delegate", args: { roles: ["explorer"] } }] },
      { text: "Now waiting.", toolCalls: [{ name: "wait", args: {} }] },
      { text: "all done" },
    ],
    { cols: 90 },
  )
  s.terminal.send("go\r")
  await waitFor(s.isWaiting, "the child to block")
  s.terminal.send("/agents view\r")
  await waitFor(() => /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] wait +\d+s$/m.test(s.view()), "the viewer")
  // The generic footer lists a view's keys before the scroll keys (dropped first when narrow).
  expect(s.screen.lines.at(-1)).toContain("following · ←→ switch · x stop · p print · ")
  expect(s.screen.lines.at(-1)).toMatch(/ · esc close$/)
  s.terminal.send("x")
  await waitFor(() => s.screen.lines.at(-1)!.startsWith("Stop Check explorer (explorer s_"), "the question")
  expect(s.screen.lines.at(-1)).toContain("? y stops it · any other key keeps it running")
  s.terminal.send("n")
  await waitFor(() => s.screen.lines.at(-1)!.includes("x stop"), "kept")
  expect(s.control.subagents()[0]?.status).toBe("running")
  s.terminal.send("x")
  await waitFor(() => s.screen.lines.at(-1)!.startsWith("Stop Check explorer"), "asked again")
  s.terminal.send("y")
  s.release()
  await waitFor(() => s.view().includes("✗ stopped by the user"), "stopped")
  expect(s.control.subagents()[0]?.status).toBe("aborted")
  expect(s.screen.lines.at(-1)).not.toContain("x stop")
  // x on one that ended does nothing.
  s.terminal.send("x")
  await Bun.sleep(40)
  expect(s.screen.lines.at(-1)).not.toContain("Stop Check explorer")
  s.terminal.send(ESC)
  await waitFor(() => !s.screen.inAltScreen, "closed")
  await s.idle()
  s.terminal.send("\x03")
  await s.exited
})

test("Ctrl+L and focus reports in the viewer leave the main screen alone", async () => {
  const s = await setup([
    { toolCalls: [{ name: "delegate", args: { roles: ["explorer"] } }] },
    { text: "child answer" },
    { text: "done" },
  ])
  s.terminal.send("go\r")
  await s.idle()
  s.terminal.send("/agents view\r")
  await waitFor(() => s.screen.inAltScreen, "the viewer")
  await waitFor(() => s.view().includes("child answer"), "the transcript")
  const atOpen = s.screen.mainText
  // Ctrl+L, focus out and in.
  s.terminal.send("\x1b[108;5u\x1b[O\x1b[I")
  await Bun.sleep(40)
  expect(s.screen.inAltScreen).toBe(true)
  expect(s.screen.mainText).toBe(atOpen)
  const from = s.terminal.output.length
  s.terminal.send(ESC)
  await waitFor(() => !s.screen.inAltScreen, "the inline UI")
  // The inline UI comes back where it was, not redrawn from the top of the screen.
  const back = s.terminal.output.slice(from)
  expect(back.slice(back.indexOf("\x1b[?1049l"))).not.toContain("\x1b[1;1H")
  const main = s.screen.mainText
  expect(main.split("› go").length).toBe(2)
  expect(s.screen.scrollback.join("\n")).not.toContain("Message Amira")
  expect(s.view()).toContain("│ › Message Amira")
  s.terminal.send("\x03")
  await s.exited
})

test("the viewer scrolls, follows the tail again at the end, and redraws on resize", async () => {
  const long = Array.from({ length: 40 }, (_, i) => `answer line ${i + 1}`).join("\n")
  const s = await setup([
    { toolCalls: [{ name: "delegate", args: { roles: ["explorer"] } }] },
    { text: long },
    { text: "done" },
  ])
  s.terminal.send("go\r")
  await s.idle()
  s.terminal.send("/agents view 1\r")
  await waitFor(() => s.view().includes("── done ──"), "the viewer")
  expect(s.screen.lines.at(-2)).toBe("── done ──")
  expect(s.screen.lines.at(-1)).toContain("following")
  s.terminal.send("\x1b[5~") // PgUp
  await waitFor(() => !s.screen.lines.at(-1)!.includes("following"), "scrolled up")
  expect(s.screen.lines.at(-1)).toMatch(/^\d+–\d+ of 46 · /)
  expect(s.view()).not.toContain("── done ──")
  s.terminal.send("\x1b[H") // Home
  await waitFor(
    () => s.screen.lines[3] === "" && s.screen.lines[4] === "  › task for the explorer",
    "the top",
  )
  expect(s.screen.lines.at(-1)).toMatch(/^1–16 of 46 · /)
  s.terminal.send("\x1b[B") // ↓
  await waitFor(
    () => s.screen.lines[3] === "  › task for the explorer" && s.screen.lines[4] === "",
    "one row down",
  )
  s.terminal.send("\x1b[F") // End
  await waitFor(() => s.screen.lines.at(-1)!.includes("following"), "the end")
  s.resize(70, 12)
  await waitFor(() => s.screen.lines.at(-1)!.includes("following") && s.screen.lines.length === 12, "resized")
  await Bun.sleep(60)
  expect(s.screen.lines[0]).toMatch(/^◆ Check explorer/)
  expect(s.screen.lines.at(-2)).toBe("── done ──")
  expect(s.screen.lines.at(-3)).toBe("")
  expect(s.screen.lines.at(-4)).toBe("  answer line 40")
  s.terminal.send("q")
  await waitFor(() => !s.screen.inAltScreen, "closed")
  s.terminal.send("\x03")
  await s.exited
})

test("←/→ and Tab switch between sub-agents; Ctrl+C closes the viewer instead of quitting", async () => {
  const s = await setup([
    { toolCalls: [{ name: "delegate", args: { roles: ["explorer", "coder"] } }] },
    { text: "explored" },
    { text: "coded" },
    { text: "done" },
  ])
  s.terminal.send("go\r")
  await s.idle()
  s.terminal.send("/agents view\r")
  await waitFor(() => /^◆ Check coder .* 2 of 2$/.test(s.screen.lines[0]!), "the latest sub-agent")
  expect(s.view()).toContain("coded")
  s.terminal.send("\x1b[D") // ←
  await waitFor(() => /^◆ Check explorer .* 1 of 2$/.test(s.screen.lines[0]!), "the previous one")
  expect(s.view()).toContain("explored")
  s.terminal.send("\x1b[C") // →
  await waitFor(() => s.screen.lines[0]!.startsWith("◆ Check coder"), "the next one")
  s.terminal.send("\t")
  await waitFor(() => s.screen.lines[0]!.startsWith("◆ Check explorer"), "Tab wraps around")
  s.terminal.send("\x03")
  await waitFor(() => !s.screen.inAltScreen, "closed by Ctrl+C")
  expect(s.view()).toContain(" shift+tab mode  │  ctrl+o detail  │  ? keys")
  s.terminal.send("\x03")
  expect(await s.exited).toBe(0)
})

test("a main-session dialog shows as a banner in the viewer, rings once, and is answered after Esc", async () => {
  const s = await setup([
    { toolCalls: [{ name: "delegate", args: { roles: ["explorer"] } }] },
    { text: "explored" },
    { text: "done" },
  ])
  s.terminal.send("go\r")
  await s.idle()
  s.terminal.send("/agents view\r")
  await waitFor(() => s.view().includes("── done ──"), "the viewer")
  const bells = s.screen.bells
  const answer = s.host.ui.api("approval").confirm("Allow bash?", "rm -rf build")
  await waitFor(() => s.view().includes("⚠️ Waiting for you: Allow bash? · esc to answer"), "the banner")
  // Bells only: a BEL ending an OSC string (a title, the progress indicator) is not one.
  expect(s.screen.bells - bells).toBe(1)
  expect(s.screen.inAltScreen).toBe(true)
  // Keys still go to the viewer: "y" does not answer the dialog.
  s.terminal.send("y")
  await Bun.sleep(60)
  expect(s.host.ui.pending).toHaveLength(1)
  s.terminal.send(ESC)
  await waitFor(() => s.view().includes("? Allow bash? (approval)"), "the inline dialog")
  s.terminal.send("\x1b[B\r")
  expect(await answer).toBe(true)
  // Answered: the dialog is gone and leaves no echo.
  await waitFor(() => !s.view().includes("? Allow bash?"), "the dialog gone")
  s.terminal.send("\x03")
  await s.exited
})

test("/agents picks a sub-agent in an inline dialog and opens the live view on it; p there prints it", async () => {
  const s = await setup([
    { toolCalls: [{ name: "delegate", args: { roles: ["explorer"] } }] },
    { toolCalls: [{ name: "read", args: { path: "b.ts" } }] },
    { text: "b.ts is fine" },
    { text: "done" },
  ])
  s.terminal.send("go\r")
  await s.idle()
  s.terminal.send("/agents\r")
  await waitFor(() => s.view().includes("? Sub-agents"), "the picker")
  // The digit in front is the option's own number, shown once.
  expect(s.view()).not.toContain("Open the live view")
  expect(s.view()).toMatch(/❯ 1 Check explorer · explorer · s_\w+ · done/)
  s.terminal.send("1")
  await waitFor(() => s.screen.inAltScreen, "the viewer")
  await waitFor(() => s.view().includes("task: task for the explorer"), "the viewer drawn")
  // p leaves it with a snapshot of the one shown printed into the scrollback.
  s.terminal.send("p")
  await waitFor(() => s.screen.mainText.includes("  └ read b.ts  ✓ contents"), "the transcript")
  const main = s.screen.mainText
  expect(main).toMatch(/◆ Check explorer · explorer · s_\w+ · done · \d+s/)
  expect(main).toContain("› task for the explorer")
  expect(main).toContain("  └ read b.ts  ✓ contents of b.ts (+2 lines)")
  expect(main.lastIndexOf("b.ts is fine")).toBeGreaterThan(main.indexOf("  └ read b.ts"))
  expect(s.screen.inAltScreen).toBe(false)
  s.terminal.send("\x03")
  await s.exited
})

test("viewer tool groups close before replies and reuse host reply/running renderers", async () => {
  const s = await snapshotView()
  s.histories.get("a")!.push(
    {
      role: "assistant",
      model: { provider: "mock", model: "m1" },
      content: [
        { type: "toolCall", id: "c1", name: "read", args: { path: "a.ts" } },
        { type: "toolCall", id: "c2", name: "read", args: { path: "b.ts" } },
        { type: "text", text: "**Now waiting.**" },
        { type: "toolCall", id: "c3", name: "wait", args: {} },
      ],
    },
    { role: "toolResult", toolCallId: "c1", toolName: "read", ...textResult("first"), isError: false },
    { role: "toolResult", toolCallId: "c2", toolName: "read", ...textResult("second"), isError: false },
  )
  const tools: boolean[] = []
  const replies: string[] = []
  const running: boolean[] = []
  const rows = s.definition
    .render(s.data, {
      width: 80,
      now: 6500,
      renderTool: (_name, _call, _detail, options) => {
        tools.push(options?.last ?? false)
        return [{ kind: "code", text: "tool" }]
      },
      renderReply: (text) => {
        replies.push(text)
        return [{ kind: "code", text: "  Now waiting." }]
      },
      renderRunningTool: (_name, _call, options) => {
        running.push(options?.last ?? false)
        return [{ kind: "code", text: "  └ ⠋ wait" }]
      },
    })
    .map(lineText)
  expect(tools).toEqual([false, true])
  expect(replies).toEqual(["**Now waiting.**"])
  expect(running).toEqual([true])
  expect(rows).toEqual(["Task a", "", "tool", "tool", "", "  Now waiting.", "", "  └ ⠋ wait", ""])
  s.host.unload("builtin:agent")
})

test("restyled viewer frame uses the main transcript renderers and keeps its own chrome", async () => {
  const s = await snapshotView()
  s.histories.get("a")!.push(
    {
      role: "assistant",
      model: { provider: "mock", model: "m1" },
      content: [{ type: "toolCall", id: "read", name: "read", args: { path: "a.ts" } }],
    },
    {
      role: "toolResult",
      toolCallId: "read",
      toolName: "read",
      ...textResult("contents of a.ts\nline 2\nline 3"),
      isError: false,
    },
    {
      role: "assistant",
      model: { provider: "mock", model: "m1" },
      content: [
        { type: "text", text: "**Now waiting.**" },
        { type: "toolCall", id: "wait", name: "wait", args: {} },
      ],
    },
  )
  expect(s.render()).toMatchSnapshot()
  s.host.unload("builtin:agent")
})

test("viewer streams partial tool output through the host's running renderer", async () => {
  const s = await snapshotView()
  s.histories.get("a")!.push({
    role: "assistant",
    model: { provider: "mock", model: "m1" },
    content: [{ type: "toolCall", id: "live", name: "bash", args: { command: "build" } }],
  })
  s.bus.emit("tool.execute.start", { toolCallId: "live", name: "bash", args: { command: "build" } }, s.meta)
  s.bus.emit(
    "tool.execute.update",
    { toolCallId: "live", name: "bash", partial: textResult("one\ntwo") },
    s.meta,
  )
  await s.bus.flush()
  const rows = s.render().split("\n")
  expect(rows).toContain("    │ one")
  expect(rows).toContain("    │ two")
  expect(rows.some((row) => /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] bash build/.test(row))).toBe(true)
  s.host.unload("builtin:agent")
})
