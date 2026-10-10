import { expect, test } from "bun:test"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import {
  type ExtensionAPI,
  type SessionControl,
  type ToolCallView,
  type ToolPresenter,
  textResult,
  toolResultText,
  type ViewDefinition,
  type ViewLine,
} from "@amira/api"
import { Agent, CommandHost, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import {
  defaultTheme,
  FakeTerminal,
  type KeyEvent,
  monoTheme,
  type RenderContext,
  stripAnsi,
  surfaceTheme,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import statusExtension from "../../../extensions/status/src/index.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"
import { ExtensionViewer, wrapViewLines } from "../src/extension-view.ts"
import { userLines } from "../src/format.ts"
import { finishedToolLines } from "../src/tool-view.ts"

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

const ESC = "\x1b[27u"

/** What the test extension's view shows: a small progress tree it changes as it goes. */
interface Progress {
  name: string
  steps: { title: string; state: "done" | "running" | "failed" }[]
  cancelled?: boolean
}

const progressView: ViewDefinition<Progress> = {
  kind: "progress",
  title: (d) => `Workflow ${d.name}`,
  header: (d) => [
    { kind: "muted", text: `${d.steps.filter((s) => s.state === "done").length}/${d.steps.length} done` },
  ],
  render: (d) =>
    d.steps.map(
      (s): ViewLine => ({
        kind: s.state === "done" ? "success" : s.state === "failed" ? "error" : "accent",
        text: `${s.state === "done" ? "✓" : s.state === "failed" ? "✗" : "…"} ${s.title}`,
      }),
    ),
  keys: [
    {
      key: "x",
      label: "cancel",
      run: (d) => {
        d.cancelled = true
        d.steps = d.steps.map((s) => (s.state === "running" ? { ...s, state: "failed" } : s))
      },
    },
    { key: "c", label: "close", run: (_d, view) => view.close() },
  ],
  follow: false,
}

async function setup(
  o: { rows?: number; view?: ViewDefinition<any>; extra?: (api: ExtensionAPI) => void } = {},
) {
  const bus = new EventBus()
  const errors: string[] = []
  bus.subscribe((e) => void (e.type === "extension.error" && errors.push(e.data.error)))
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  await host.load(statusExtension, "builtin:status")
  const data: Progress = {
    name: "review",
    steps: [
      { title: "read the diff", state: "done" },
      { title: "check the tests", state: "running" },
    ],
  }
  let api!: ExtensionAPI
  await host.load((a) => {
    api = a
    a.registerView(o.view ?? progressView)
    a.registerCommand({
      name: "progress",
      description: "shows the progress view",
      run: (args, ctx) => void ctx.openView?.({ kind: args.trim() || "progress", data }),
    })
    o.extra?.(a)
  }, "ext:workflow")
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m1"), cwd: "/work", systemPrompt: "", bus, tools })
  const commands = new CommandHost({
    registry: host.commands,
    bus,
    ui: host.ui,
    control: {} as SessionControl,
    agent,
  })
  const cols = 80
  const rows = o.rows ?? 20
  const terminal = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const write = terminal.write.bind(terminal)
  terminal.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  const exited = runInteractive({
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
  await waitFor(() => screen.text.includes("Amira"), "startup")
  const view = () => screen.lines.join("\n")
  return { host, bus, api, data, errors, terminal, screen, view, exited }
}

test("a command opens an extension's view over its data; it follows changes, runs its keys and closes", async () => {
  const s = await setup()
  s.terminal.send("/progress\r")
  await waitFor(() => s.screen.inAltScreen, "the view")
  await waitFor(() => s.view().includes("check the tests"), "the body")
  const lines = s.screen.lines
  expect(lines[0]).toBe("◆ Workflow review")
  expect(lines[1]).toBe("1/2 done")
  expect(lines[2]).toBe("─".repeat(80))
  expect(lines.slice(3, 5)).toEqual(["✓ read the diff", "… check the tests"])
  expect(lines.at(-1)).toBe("x cancel · c close · ↑↓ PgUp PgDn Home End scroll · Esc close")

  // The extension changes its data and asks for a redraw: the view shows it.
  s.data.steps.push({ title: "write the summary", state: "running" })
  s.data.steps[1]!.state = "done"
  s.api.requestRender()
  await waitFor(() => s.view().includes("… write the summary"), "the new step")
  expect(s.screen.lines[1]).toBe("2/3 done")

  // Its own key changes the data and redraws.
  s.terminal.send("x")
  await waitFor(() => s.view().includes("✗ write the summary"), "the cancel key")
  expect(s.data.cancelled).toBe(true)

  s.terminal.send(ESC)
  await waitFor(() => !s.screen.inAltScreen, "the inline UI")
  expect(s.view()).toContain("│ › Message Amira")
  expect(s.screen.altSwitches).toEqual([true, false])

  // A key can close the view too; opening it again shows it anew.
  s.terminal.send("/progress\r")
  await waitFor(() => s.screen.inAltScreen, "the view again")
  s.terminal.send("c")
  await waitFor(() => !s.screen.inAltScreen, "closed by its key")
  s.terminal.send("\x03")
  await s.exited
})

test("a long body starts at its top unless the view follows its end; the body scrolls", async () => {
  const many = (d: Progress) => d.steps.map((st): ViewLine => ({ kind: "text", text: st.title }))
  const long = (follow: boolean): ViewDefinition<Progress> => ({
    kind: "progress",
    title: () => "Long",
    render: (d) => [
      ...many(d),
      ...Array.from({ length: 40 }, (_, i) => ({ kind: "text" as const, text: `row ${i}` })),
    ],
    follow,
  })
  const top = await setup({ rows: 12, view: long(false) })
  top.terminal.send("/progress\r")
  await waitFor(() => top.view().includes("read the diff"), "the top")
  expect(top.screen.lines[2]).toBe("read the diff")
  expect(top.screen.lines.at(-1)).toMatch(/^1–9 of 42 · /)
  top.terminal.send("\x1b[B")
  await waitFor(() => top.screen.lines.at(-1)!.startsWith("2–10 of 42"), "scrolled a row")
  // Ctrl+C leaves the view, not Amira.
  top.terminal.send("\x03")
  await waitFor(() => !top.screen.inAltScreen, "closed")
  top.terminal.send("\x03")
  await top.exited

  const end = await setup({ rows: 12, view: long(true) })
  end.terminal.send("/progress\r")
  await waitFor(() => end.view().includes("row 39"), "the end")
  expect(end.screen.lines.at(-1)).toMatch(/^following · /)
  end.terminal.send(ESC)
  await waitFor(() => !end.screen.inAltScreen, "closed")
  end.terminal.send("\x03")
  await end.exited
})

test("an unknown kind is the command's error; subagent can be registered by an extension", async () => {
  const s = await setup({
    extra: (api) =>
      void api.registerView({ kind: "subagent", title: () => "mine", render: () => [] } as ViewDefinition),
  })
  expect(s.host.views.get("subagent")?.title(undefined, { width: 80, now: 0 })).toBe("mine")
  expect(s.errors).toEqual([])
  s.terminal.send("/progress nope\r")
  await waitFor(() => s.screen.text.includes('there is no "nope" view'), "the error")
  expect(s.screen.inAltScreen).toBe(false)
  s.terminal.send("\x03")
  await s.exited
})

test("legacy subagent requests normalize to data through ordinary extension lookup", async () => {
  const s = await setup({
    extra: (api) => {
      api.registerView({
        kind: "subagent",
        title: (data: { sessionId: string }) => `Child ${data.sessionId}`,
        render: () => [],
      })
      api.registerCommand({
        name: "legacy",
        description: "Legacy view",
        run: (_args, ctx) => {
          ctx.openView?.({ kind: "subagent", sessionId: "child-id" })
        },
      })
    },
  })
  s.terminal.send("/legacy\r")
  await waitFor(() => s.view().includes("◆ Child child-id"), "the normalized request")
  s.terminal.send(ESC)
  await waitFor(() => !s.screen.inAltScreen, "closed")
  s.terminal.send("\x03")
  await s.exited
})

test("a view that throws shows the error in place and reports it once", async () => {
  let calls = 0
  const s = await setup({
    view: {
      kind: "progress",
      title: () => "Broken",
      render: () => {
        calls++
        throw new Error("no data yet")
      },
    },
  })
  s.terminal.send("/progress\r")
  await waitFor(() => s.view().includes("The progress view failed: no data yet"), "the error line")
  s.api.requestRender()
  await waitFor(() => calls > 2, "more redraws")
  s.terminal.send(ESC)
  await waitFor(() => !s.screen.inAltScreen, "closed")
  await waitFor(() => s.screen.text.includes("View progress: render failed: no data yet"), "the report")
  expect(s.screen.text.split("render failed").length).toBe(2)
  s.terminal.send("\x03")
  await s.exited
})

test("a key can ask to confirm first: y goes ahead, any other key does not", async () => {
  const answers: boolean[] = []
  const stopping: ViewDefinition<Progress> = {
    ...progressView,
    keys: [
      {
        key: "x",
        label: "stop",
        run: (d, view) =>
          void view.confirm("Stop the run?", { yes: "stops it", no: "keeps it running" }).then((yes) => {
            answers.push(yes)
            if (yes) d.cancelled = true
            view.requestRender()
          }),
      },
    ],
  }
  const s = await setup({ view: stopping })
  s.terminal.send("/progress\r")
  await waitFor(() => s.view().includes("check the tests"), "the view")
  s.terminal.send("x")
  await waitFor(
    () => s.screen.lines.at(-1) === "Stop the run? y stops it · any other key keeps it running",
    "the question",
  )
  // Any other key keeps it running, and is used up: "q" does not close the view.
  s.terminal.send("q")
  await waitFor(() => answers.length === 1, "no")
  expect(s.screen.inAltScreen).toBe(true)
  s.terminal.send("x")
  s.terminal.send("y")
  await waitFor(() => answers.length === 2, "yes")
  expect(answers).toEqual([false, true])
  expect(s.data.cancelled).toBe(true)
  s.terminal.send(ESC)
  await waitFor(() => !s.screen.inAltScreen, "closed")
  s.terminal.send("\x03")
  await s.exited
})

test("long text lines wrap under their text; code lines are cut", () => {
  const lines = wrapViewLines(
    [
      { kind: "error", text: `✗ Verify failed: ${"the reviewer ran out of time ".repeat(3).trim()}` },
      { kind: "code", text: "x".repeat(60) },
    ],
    30,
  )
  expect(lines.map((l) => (l.kind === "segments" ? l.parts.map((p) => p.text).join("") : l.text))).toEqual([
    "✗ Verify failed: the reviewer",
    "  ran out of time the reviewer",
    "  ran out of time the reviewer",
    "  ran out of time",
    "x".repeat(60),
  ])
})

const renderContext: RenderContext = { theme: monoTheme, color: false, rows: 12 }
const keyEvent = (name: string, shift = false): KeyEvent => ({
  type: "key",
  name,
  ctrl: false,
  alt: false,
  shift,
})

test("semantic segments keep each color in titles, headers and bodies; plain text is unchanged", () => {
  const parts = (["accent", "text", "muted", "success", "warning", "error"] as const).map((kind) => ({
    kind,
    text: `${kind} `,
  }))
  const line: ViewLine = { kind: "segments", parts }
  const viewer = new ExtensionViewer(
    {
      kind: "segments",
      title: () => line,
      header: () => [line],
      render: () => [line],
    },
    {},
  )
  const theme = defaultTheme
  const styled = parts.map((p) => theme[p.kind](p.text)).join("")
  const plain = parts.map((p) => p.text).join("")
  for (const width of [80, 18]) {
    const colored = viewer.render(width, { ...renderContext, theme, color: true })
    const mono = viewer.render(width, renderContext).map(stripAnsi)
    for (const index of [0, 1, 3]) {
      expect(colored[index]).toBe(truncateToWidth(styled, width, "…"))
      expect(mono[index]).toBe(truncateToWidth(plain, width, "…"))
      expect(stripAnsi(colored[index]!)).toBe(mono[index]!)
      expect(visibleWidth(colored[index]!)).toBeLessThanOrEqual(width)
    }
  }
})

test("semantic titles omit the default marker and preserve the muted aside when truncated", () => {
  const theme = defaultTheme
  const viewer = new ExtensionViewer(
    {
      kind: "note",
      title: () => ({ kind: "warning", text: "No child in this session." }),
      titleAside: () => "2 of 5",
      render: () => [],
    },
    {},
  )
  const rows = viewer.render(25, { ...renderContext, theme, color: true })
  expect(rows[0]).toBe(`${theme.warning("No child in this …")}${theme.muted(" 2 of 5")}`)
  expect(stripAnsi(rows[0]!)).not.toContain("◆")
})

test("user-message lines use transcript wrapping, marker, note and background in headers and bodies", () => {
  const text = "A task that wraps across several rows\nand a second line"
  const note = "a display note"
  const message = userMessage(text)
  message.display = { text: "", note }
  const viewer = new ExtensionViewer(
    {
      kind: "message",
      title: () => "Task",
      header: () => [{ kind: "user-message", text, note }],
      render: () => [{ kind: "user-message", text, note }],
    },
    {},
  )
  for (const theme of [monoTheme, { ...defaultTheme, ...surfaceTheme("dark") }]) {
    const expected = userLines(theme, message, 30)
    const rows = viewer.render(30, { theme, color: theme !== monoTheme, rows: 40 })
    expect(rows.slice(1, 1 + expected.length)).toEqual(expected)
    expect(rows.slice(2 + expected.length, 2 + 2 * expected.length)).toEqual(expected)
    if (theme === monoTheme) {
      expect(expected.map(stripAnsi)).toEqual([
        "  › A task that wraps across",
        "    several rows",
        "    and a second line",
        "    └ a display note",
      ])
    } else expect(expected[0]).not.toBe(stripAnsi(expected[0]!))
  }
})

test("semantic view text cannot inject terminal styling", () => {
  const viewer = new ExtensionViewer(
    {
      kind: "safe",
      title: () => ({ kind: "segments", parts: [{ kind: "text", text: "\x1b[31mTitle\x1b[0m\nrow" }] }),
      render: () => [{ kind: "user-message", text: "\x1b[31mTask\x1b[0m", note: "\x1b[31mNote" }],
    },
    {},
  )
  const rendered = viewer.render(80, renderContext)
  expect(rendered.join("\n")).not.toContain("\x1b[31m")
  const rows = rendered.map(stripAnsi)
  expect(rows[0]).toBe("Title row")
  expect(rows[2]).toBe("  › Task")
  expect(rows[3]).toBe("    └ Note")
  expect(rows.join("\n")).not.toContain("\x1b")
})

test("named navigation keys distinguish Tab and Shift+Tab, leaving reserved keys to the host", () => {
  const calls: string[] = []
  let closed = 0
  const view: ViewDefinition = {
    kind: "tabs",
    title: () => "Tabs",
    render: () => [],
    keys: ["left", "right", "tab", "shift-tab", "up", "q", "escape"].map((key) => ({
      key,
      label: key,
      run: () => {
        calls.push(key)
      },
    })),
  }
  const viewer = new ExtensionViewer(
    view,
    {},
    {
      onClose: () => {
        closed++
      },
    },
  )
  viewer.render(80, renderContext)
  for (const event of [keyEvent("left"), keyEvent("right"), keyEvent("tab"), keyEvent("tab", true)])
    expect(viewer.handleInput(event)).toBe(true)
  expect(viewer.handleInput({ ...keyEvent("left"), ctrl: true })).toBe(false)
  viewer.handleInput(keyEvent("up"))
  viewer.handleInput(keyEvent("q"))
  viewer.handleInput(keyEvent("escape"))
  expect(calls).toEqual(["left", "right", "tab", "shift-tab"])
  expect(closed).toBe(1) // A closed viewer cannot close twice.
})

test("keys sharing a label share a footer item, empty labels stay out, and the aside keeps right", () => {
  const run = () => {}
  const view: ViewDefinition = {
    kind: "pager",
    title: () => "A rather long title that has to be cut on a narrow screen",
    titleAside: () => "2 of 5",
    render: () => [],
    keys: [
      { key: "left", label: "switch", run },
      { key: "right", label: "switch", run },
      { key: "tab", label: "", run },
      { key: "x", label: "stop", run },
      { key: "y", label: "stop", run },
      { key: "up", label: "unreachable", run },
    ],
  }
  const lines = new ExtensionViewer(view, {}).render(40, renderContext).map(stripAnsi)
  expect(lines[0]).toBe("◆ A rather long title that has t… 2 of 5")
  expect(lines.at(-1)).toBe("←→ switch · x y stop · Esc close")
  const wide = new ExtensionViewer(view, {}).render(120, renderContext).map(stripAnsi)
  expect(wide[0]).toMatch(/^◆ A rather long title .*screen +2 of 5$/)
  expect(wide[0]).toHaveLength(120)
})

test("a view prints snapshots at command output levels, including after closing", async () => {
  const s = await setup({
    view: {
      ...progressView,
      keys: [
        {
          key: "p",
          label: "print",
          run: (_data, view) => {
            view.print("queued snapshot")
            view.close()
            view.print("view warning", "warning")
            view.print("view error", "error")
          },
        },
      ],
    },
  })
  s.terminal.send("/progress\r")
  await waitFor(() => s.view().includes("check the tests"), "the view")
  s.terminal.send("p")
  await waitFor(() => !s.screen.inAltScreen && s.screen.mainText.includes("view error"), "the printed output")
  expect(s.screen.mainText).toContain("queued snapshot")
  expect(s.screen.mainText).toContain("└ view warning")
  expect(s.screen.mainText).toContain("✗ view error")
  expect(s.screen.mainText).not.toContain("› /agents")
  s.terminal.send("\x03")
  await s.exited
})

test("ViewControl.print forwards text and its optional level to the frontend", () => {
  const printed: unknown[] = []
  const viewer = new ExtensionViewer(
    {
      ...progressView,
      keys: [
        {
          key: "p",
          label: "print",
          run: (_data, view) => {
            view.print("plain")
            view.print("warning", "warning")
            view.print("error", "error")
          },
        },
      ],
    },
    {},
    {
      onPrint: (text, level) => {
        printed.push([text, level])
      },
    },
  )
  viewer.handleInput(keyEvent("p"))
  expect(printed).toEqual([
    ["plain", undefined],
    ["warning", "warning"],
    ["error", "error"],
  ])
})

test("renderTool uses the current presenter, fallback and exact host styling in headers and bodies", () => {
  const theme = { ...defaultTheme, ...surfaceTheme("dark") }
  const context = { ...renderContext, theme, color: true, rows: 25 }
  const call: ToolCallView = {
    args: { path: "a.ts" },
    result: textResult("first\nsecond\nthird"),
    text: "first\nsecond\nthird",
    durationMs: 2100,
  }
  let presenter: ToolPresenter | undefined = {
    summary: () => "custom summary",
    result: () => "custom result",
    body: () => [
      { kind: "diff-remove", text: "old value", lineNo: 9 },
      { kind: "diff-add", text: "new value", lineNo: 10 },
    ],
  }
  let plainLines: ViewLine[] = []
  const viewer = new ExtensionViewer(
    {
      kind: "tools",
      title: () => "Tools",
      header: (_data, opts) => opts.renderTool!("read", call, "collapsed"),
      render: (_data, opts) => {
        plainLines = opts.renderTool!("read", call, "full")
        return plainLines
      },
    },
    {},
    { presenters: { get: () => presenter } },
  )
  const rows = viewer.render(60, context)
  const expected = finishedToolLines(theme, presenter, { ...call, name: "read" }, "full", 60)
  expect(rows.slice(3, 3 + expected.length)).toEqual(expected)
  expect(rows.slice(1, 2)).toEqual(
    finishedToolLines(theme, presenter, { ...call, name: "read" }, "collapsed", 60),
  )
  const texts = plainLines.map((line) => {
    if (line.kind === "segments") throw new Error("renderTool must return plain host-owned lines")
    return line.text
  })
  expect(texts).toEqual(expected.map(stripAnsi))
  expect(texts.every((text) => !text.includes("\x1b"))).toBe(true)
  for (const next of [
    undefined,
    {
      summary: () => {
        throw new Error("bad presenter")
      },
      body: () => {
        throw new Error("bad presenter")
      },
    },
  ]) {
    presenter = next
    const rendered = viewer.render(32, context)
    const fallback = finishedToolLines(theme, presenter, { ...call, name: "read" }, "full", 32)
    expect(rendered.slice(4, 4 + fallback.length)).toEqual(fallback)
  }
})

test("renderTools groups only consecutive exploration and preserves exact host styles at each detail", () => {
  const theme = { ...defaultTheme, ...surfaceTheme("dark") }
  const context = { ...renderContext, theme, color: true, rows: 50 }
  const entries = [
    { name: "read", args: { path: "a.ts" }, result: textResult("first\nsecond") },
    { name: "read", args: { path: "a.ts" }, result: textResult("first\nsecond") },
    { name: "read", args: { path: "missing.ts" }, result: textResult("missing", true) },
    {
      name: "read",
      args: { path: "blocked.ts" },
      result: textResult("denied"),
      rejected: "blocked" as const,
    },
    { name: "edit", args: { path: "a.ts" }, result: textResult("changed") },
    { name: "bash", args: { command: "check" }, result: textResult("command result") },
    { name: "list", args: { path: "src" }, result: textResult("paths") },
    { name: "list", args: { path: "test" }, result: textResult("paths") },
  ].map(({ name, ...call }) => ({ name, call: { ...call, text: toolResultText(call.result) } }))
  const edit: ToolPresenter = {
    result: () => "+1 -1",
    body: () => [
      { kind: "diff-remove", text: "old" },
      { kind: "diff-add", text: "new" },
    ],
  }
  let detail: "summary" | "full" | "collapsed" = "summary"
  let lines: ViewLine[] = []
  const viewer = new ExtensionViewer(
    {
      kind: "tools",
      title: () => "Tools",
      render: (_data, opts) => {
        lines = opts.renderTools!(entries, opts.toolDetail!, { last: true })
        return lines
      },
    },
    {},
    { toolDetail: () => detail, presenters: { get: (name) => (name === "edit" ? edit : undefined) } },
  )
  for (const level of ["summary", "full", "collapsed"] as const) {
    detail = level
    const rows = viewer.render(100, context)
    const text = lines.map((line) => (line.kind === "segments" ? "" : line.text))
    expect(rows.slice(2, 2 + lines.length).map(stripAnsi)).toEqual(text)
    expect(text.every((row) => !row.includes("\x1b"))).toBe(true)
    expect(text.join("\n")).toContain("✗ missing")
    expect(text.join("\n")).toContain("⊘ denied")
    expect(text.join("\n")).toContain("✓ command result")
    expect(text.join("\n")).toContain("✓ +1 -1")
    expect(rows.some((row) => row.includes(theme.error("✗ missing")))).toBe(true)
    if (level === "full") {
      expect(text.filter((row) => row === "  ├ read a.ts")).toHaveLength(2)
      expect(text.join("\n")).not.toContain("▸")
      expect(text.filter((row) => row.trim().endsWith("second"))).toHaveLength(2)
    } else {
      expect(text[0]).toBe("  ├ Read 2 files (a.ts)  ▸")
      expect(text.at(-1)).toBe("  └ Listed 2 directories (src, test)  ▸")
      expect(rows[2]).toContain(theme.muted("▸"))
    }
    if (level !== "collapsed") {
      expect(text.join("\n")).toContain("- old")
      expect(text.join("\n")).toContain("+ new")
    }
  }
})

test("renderTool in an open view uses the registry passed by the app", async () => {
  const call: ToolCallView = { args: {}, result: textResult("output"), text: "output" }
  const s = await setup({
    view: { ...progressView, render: (_data, opts) => opts.renderTool!("test", call, "summary") },
    extra: (api) => {
      api.registerToolRenderer("test", { summary: () => "from registry", result: () => "presented result" })
    },
  })
  s.terminal.send("/progress\r")
  await waitFor(() => s.view().includes("  ├ test from registry  ✓ presented result"), "the presenter")
  expect(s.view()).toContain("  ├ test from registry  ✓ presented result")
  s.terminal.send(ESC)
  await waitFor(() => !s.screen.inAltScreen, "closed")
  s.terminal.send("\x03")
  await s.exited
})

test("scrollKey preserves each body's position and follow state across switching and show", () => {
  const data = { id: "a", length: 40 }
  const definition: ViewDefinition<typeof data> = {
    kind: "tabs",
    title: (data) => data.id,
    scrollKey: (data) => data.id,
    render: (data) =>
      Array.from({ length: data.length }, (_, i) => ({ kind: "text", text: `${data.id} row ${i}` })),
  }
  const viewer = new ExtensionViewer(definition, data)
  viewer.render(60, renderContext)
  const first = viewer.scroll
  first.scrollToTop()
  first.scrollBy(3)
  data.id = "b"
  viewer.render(60, renderContext)
  const second = viewer.scroll
  expect(second).not.toBe(first)
  expect(second.position.following).toBe(true)
  second.scrollBy(-4)
  const secondTop = second.position.top
  viewer.show({ id: "a", length: 50 })
  viewer.render(60, renderContext)
  expect(viewer.scroll).toBe(first)
  expect(first.position).toMatchObject({ top: 3, following: false, total: 50 })
  viewer.show({ id: "b", length: 60 })
  viewer.render(60, { ...renderContext, rows: 10 })
  expect(viewer.scroll.position).toMatchObject({ top: secondTop, following: false, total: 60 })
  viewer.handleInput(keyEvent("end"))
  viewer.show({ id: "b", length: 70 })
  viewer.render(60, renderContext)
  expect(viewer.scroll.position).toMatchObject({ following: true, total: 70 })
  viewer.dispose()
  viewer.render(60, renderContext)
  expect(viewer.scroll).not.toBe(second)

  const top = new ExtensionViewer({ ...definition, follow: false }, { id: "a", length: 40 })
  top.render(60, renderContext)
  top.scroll.scrollBy(2)
  top.show({ id: "b", length: 40 })
  top.render(60, renderContext)
  expect(top.scroll.position.top).toBe(0)
  top.show({ id: "a", length: 40 })
  top.render(60, renderContext)
  expect(top.scroll.position.top).toBe(2)
})

test("a key can ask for a line of text at the bottom of the view; Esc cancels it, not the view", async () => {
  const answers: (string | undefined)[] = []
  const asking: ViewDefinition<Progress> = {
    ...progressView,
    keys: [
      {
        key: "m",
        label: "message",
        run: (d, view) =>
          void view.prompt("Message to writer:", { initial: "hi " }).then((text) => {
            answers.push(text)
            if (text) d.steps.push({ title: `sent: ${text}`, state: "done" })
            view.requestRender()
          }),
      },
    ],
  }
  const s = await setup({ view: asking })
  s.terminal.send("/progress\r")
  await waitFor(() => s.view().includes("check the tests"), "the view")
  s.terminal.send("m")
  await waitFor(() => s.screen.lines.at(-1)!.startsWith("Message to writer: hi"), "the prompt")
  // Keys go to the prompt: "q" and "m" are typed, not run.
  s.terminal.send("q m\r")
  await waitFor(() => s.view().includes("sent: hi q m"), "the answer")
  expect(s.screen.lines.at(-1)).toBe("m message · ↑↓ PgUp PgDn Home End scroll · Esc close")
  s.terminal.send("m")
  await waitFor(() => s.screen.lines.at(-1)!.startsWith("Message to writer:"), "the prompt again")
  s.terminal.send(ESC)
  await waitFor(() => answers.length === 2, "cancelled")
  expect(s.screen.inAltScreen).toBe(true)
  // Closing the view cancels a prompt left open.
  s.terminal.send("m")
  await waitFor(() => s.screen.lines.at(-1)!.startsWith("Message to writer:"), "a third prompt")
  s.terminal.send("\x03")
  await waitFor(() => answers.length === 3, "cancelled by Ctrl+C")
  await waitFor(() => !s.screen.inAltScreen, "Ctrl+C closes even with a prompt")
  expect(answers).toEqual(["hi q m", undefined, undefined])
  s.terminal.send("\x03")
  await s.exited
})

test("transcript helpers share main reply/tool styles, closing rails and running spinner", () => {
  let now = 6500
  const viewer = new ExtensionViewer(
    {
      kind: "transcript",
      title: () => "Transcript",
      render: (_data, opts) => [
        ...opts.renderTool!(
          "read",
          { args: { path: "a.ts" }, result: textResult("done"), text: "done" },
          "summary",
          { last: true },
        ),
        { kind: "text", text: "" },
        ...opts.renderReply!("**Now waiting.**"),
        { kind: "text", text: "" },
        ...opts.renderRunningTool!("wait", { args: {}, startedAt: 5500 }, { last: true }),
      ],
    },
    {},
    { now: () => now },
  )
  const ctx = { ...renderContext, theme: defaultTheme, color: true }
  const rows = viewer.render(80, ctx)
  expect(rows[2]).toContain(defaultTheme.path("a.ts"))
  expect(stripAnsi(rows[2]!)).toBe("  └ read a.ts  ✓ done")
  expect(rows[4]).toBe(`  ${defaultTheme.strong!("Now waiting.")}`)
  expect(stripAnsi(rows[6]!)).toMatch(/^ {2}└ ⠋ wait +1s$/)
  expect(visibleWidth(rows[6]!)).toBe(80)
  now += 80
  expect(stripAnsi(viewer.render(80, ctx)[6]!)).toMatch(/^ {2}└ ⠙ wait +1s$/)
})
