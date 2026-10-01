import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { ExtensionAPI, SessionControl, ViewDefinition, ViewLine } from "@amira/api"
import { Agent, CommandHost, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { FakeTerminal } from "@amira/tui-kit"
import statusExtension from "../../../extensions/status/src/index.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"
import { wrapViewLines } from "../src/extension-view.ts"

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
  expect(lines.at(-1)).toBe("x cancel · c close · ↑↓ PgUp PgDn Home End scroll · Esc back")

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

test("an unknown kind is the command's error; the built-in kind cannot be registered", async () => {
  const s = await setup({
    extra: (api) =>
      void api.registerView({ kind: "subagent", title: () => "mine", render: () => [] } as ViewDefinition),
  })
  expect(s.host.views.get("subagent")).toBeUndefined()
  expect(s.errors).toEqual(['the view kind "subagent" is built in'])
  s.terminal.send("/progress nope\r")
  await waitFor(() => s.screen.text.includes('there is no "nope" view'), "the error")
  expect(s.screen.inAltScreen).toBe(false)
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
  expect(lines.map((l) => l.text)).toEqual([
    "✗ Verify failed: the reviewer",
    "  ran out of time the reviewer",
    "  ran out of time the reviewer",
    "  ran out of time",
    "x".repeat(60),
  ])
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
  expect(s.screen.lines.at(-1)).toBe("m message · ↑↓ PgUp PgDn Home End scroll · Esc back")
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
  s.terminal.send(ESC)
  await waitFor(() => !s.screen.inAltScreen, "closed")
  expect(answers).toEqual(["hi q m", undefined, undefined])
  s.terminal.send("\x03")
  await s.exited
})
