// A/B/D deliberate UI oracles: shared two-cell grid, fill-only code, rounded dialogs, › and ·.
import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import {
  type AnyEvent,
  defineTool,
  type FormActionResult,
  type FormSpec,
  type FormValues,
  textResult,
} from "@amira/api"
import { Agent, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import {
  defaultGlyphs,
  FakeTerminal,
  key,
  modes,
  type RenderContext,
  textKey,
  visibleWidth,
} from "@amira/tui-kit"
import ascii from "../../cli/themes/ascii.json"
import { plain } from "../../tui-kit/test/context.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"
import { FormView, runFormScreen, specFormBackend } from "../src/form-view.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"

const noProbe = async () => ({
  capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
  leftoverInput: "",
})

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

function screenFor(cols: number, rows: number) {
  const terminal = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const write = terminal.write.bind(terminal)
  terminal.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  return { terminal, screen }
}

async function setup(steps: MockStep[], cols = 60, rows = 22) {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m1"), cwd: "/work", systemPrompt: "", bus, tools })
  const { terminal, screen } = screenFor(cols, rows)
  const exited = runInteractive({
    agent,
    status: host.status,
    ui: host.ui,
    terminal,
    setup: noProbe,
    env: {},
    onReady: () => agent.start("startup"),
  })
  const all = () => [...screen.scrollback, ...screen.lines].join("\n")
  const live = () => screen.lines.join("\n")
  await waitFor(() => all().includes("Amira"), "banner")
  return { agent, bus, events, host, terminal, screen, all, live, exited }
}

/** A tiny second consumer of ui.form: a made-up extension asking for a webhook. */
const webhookForm = (calls: string[]): FormSpec => ({
  title: "Webhook",
  description: "Where to send build results",
  fields: [
    {
      type: "text",
      id: "url",
      label: "URL",
      required: true,
      pattern: "https?://.+",
      patternMessage: "must be a URL",
    },
    { type: "secret", id: "token", label: "Token" },
    {
      type: "action",
      id: "ping",
      label: "Ping it",
      run: async ({ values, progress }) => {
        progress("pinging")
        calls.push(`ping ${values.url}`)
        return { message: "Pong in 3 ms", tone: "success", values: { note: "reachable" } }
      },
    },
    { type: "textarea", id: "note", label: "Note" },
  ],
})

test("a form opens full screen, queues a dialog behind it, and restores the fullscreen conversation", async () => {
  const { host, terminal, screen, live, all, events, bus, agent, exited } = await setup([
    { toolCalls: [{ name: "hook", args: {} }] },
    { text: "saved" },
  ])
  const calls: string[] = []
  let got: unknown
  await host.load((api) => {
    api.registerTool(
      defineTool({
        name: "hook",
        description: "",
        parameters: {},
        execute: async () => {
          const values = await api.ui.form(webhookForm(calls))
          got = values
          return textResult(values ? `saved ${values.url}` : "cancelled")
        },
      }),
    )
  }, "webhooks")
  terminal.send("set it up\r")
  await waitFor(() => screen.inAltScreen && live().includes("Webhook"), "the form")
  expect(live()).toContain("Where to send build results")
  terminal.send("ftp://x")
  terminal.send("\t")
  await waitFor(() => live().includes("✗ must be a URL"), "inline problem")
  terminal.send("\x1b[Z")
  terminal.send("\x15https://ci.example/hook\t")
  terminal.send("tok-SECRET-9")
  // A dialog from elsewhere waits behind the form, and says so.
  const later = host.ui.api("other").confirm("Deploy too?")
  await waitFor(() => live().includes("1 dialog waits behind this form: Deploy too?"), "banner")
  terminal.send("\t\r")
  await waitFor(() => live().includes("Pong in 3 ms"), "action result")
  expect(calls).toEqual(["ping https://ci.example/hook"])
  terminal.send("\x13")
  // Back on the main screen: the transcript is intact and the queued dialog shows inline.
  await waitFor(() => live().includes("Deploy too? (other)"), "queued dialog")
  expect(all()).toContain("› set it up")
  terminal.send("\x1b[B\r")
  expect(await later).toBe(true)
  await waitFor(() => all().includes("saved"), "reply")
  expect(got).toEqual({ url: "https://ci.example/hook", token: "tok-SECRET-9", note: "reachable" })
  await bus.flush()
  // The secret went to the extension and nowhere else: not the screen, not an event.
  expect(all()).not.toContain("tok-SECRET")
  expect(JSON.stringify(events)).not.toContain("tok-SECRET")
  expect(agent.messages.length).toBeGreaterThan(0)
  terminal.send("\x03")
  await exited
})

test("Esc on a changed form asks first; the form closes when its request is resolved elsewhere", async () => {
  const { host, terminal, live, exited } = await setup([])
  const first = host.ui.api("x").form(webhookForm([]))
  await waitFor(() => live().includes("Webhook"), "form")
  terminal.send("h")
  terminal.send("\x1b[27u")
  await waitFor(() => live().includes("Discard your changes?"), "confirm")
  terminal.send("n")
  terminal.send("\x1b[27u")
  terminal.send("y")
  expect(await first).toBeUndefined()
  await waitFor(() => live().includes("│ › Message Amira"), "closed")

  const second = host.ui.api("x").form(webhookForm([]))
  await waitFor(() => live().includes("Webhook"), "second form")
  host.ui.cancelAll("x")
  expect(await second).toBeUndefined()
  await waitFor(() => live().includes("│ › Message Amira"), "closed by cancel")
  terminal.send("\x03")
  await exited
})

test("a secret input dialog is masked and its answer is not echoed", async () => {
  const { host, terminal, live, all, exited } = await setup([])
  const key = host.ui.api("x").input("API key", { secret: true })
  await waitFor(() => live().includes("API key"), "dialog")
  terminal.send("\x1b[200~sk-abc-123\n\x1b[201~")
  await waitFor(() => live().includes("**********"), "mask")
  terminal.send("\r")
  expect(await key).toBe("sk-abc-123")
  await waitFor(() => all().includes("API key › (hidden)"), "answer line")
  expect(all()).not.toContain("sk-abc")
  terminal.send("\x03")
  await exited
})

test("narrow and short terminals: the form scrolls and resizes while editing", async () => {
  const { terminal, screen } = screenFor(24, 8)
  const done = runFormScreen(webhookForm([]), { terminal, setup: noProbe })
  await waitFor(() => screen.lines.join("\n").includes("Webhook"), "form")
  terminal.send("https://a.b")
  terminal.send("\t\t\t")
  await waitFor(() => screen.lines.join("\n").includes("› Note"), "scrolled to note")
  expect(screen.lines.join("\n")).toContain("[ Save ]")
  screen.resize(40, 12)
  terminal.setSize(40, 12)
  terminal.send("日本語👍")
  await waitFor(() => screen.lines.join("\n").includes("日本語👍"), "wide text after resize")
  terminal.send("\x13")
  expect(await done).toEqual({ url: "https://a.b", token: "", note: "日本語👍" })
  expect(screen.inAltScreen).toBe(false)
})

test("standalone provider forms enable button reporting and accept SGR Save without any-motion reporting", async () => {
  const { terminal, screen } = screenFor(70, 20)
  const done = runFormScreen(
    { title: "Provider", fields: [{ id: "name", type: "text", label: "Name", default: "local" }] },
    { terminal, setup: noProbe },
  )
  await waitFor(() => screen.lines.some((line) => line.includes("[ Save ]")), "standalone form")
  expect(terminal.output).toContain(modes.mouse.on)
  expect(terminal.output).not.toContain("\x1b[?1003h")
  for (const button of [1, 2]) {
    terminal.send(`\x1b[<${button};5;5M`)
    await waitFor(
      () => screen.lines.some((line) => line.includes("Clicks go to Amira here:")),
      "standalone paste hint",
    )
  }
  const y = screen.lines.findIndex((line) => line.includes("[ Save ]"))
  const x = screen.lines[y]!.indexOf("[ Save ]")
  terminal.send(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`)
  expect(await done).toEqual({ name: "local" })
  expect(terminal.output).toContain(modes.mouse.off)
})

test("FormView with a spec backend reports refused values and aborts actions on close", async () => {
  let answered: unknown = "none"
  let aborted = false
  const spec: FormSpec = {
    title: "t",
    fields: [
      { type: "text", id: "a", label: "A", validate: (v) => (v === "no" ? "not that" : undefined) },
      {
        type: "action",
        id: "slow",
        label: "Slow",
        run: ({ signal }) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => {
              aborted = true
              resolve(undefined)
            }),
          ),
      },
    ],
  }
  let closed = 0
  const view = new FormView(
    specFormBackend(spec, (v) => {
      answered = v
    }),
    { requestRender: () => {}, onClose: () => closed++ },
  )
  for (const ch of "no") view.handleInput(textKey(ch))
  view.handleInput(key("s", { ctrl: true }))
  expect(answered).toBe("none")
  view.handleInput(key("tab"))
  view.handleInput(key("enter"))
  view.close()
  expect(aborted).toBe(true)
  expect(closed).toBe(1)
})

test("form view forwards card layout and footer button metadata without changing the action id", async () => {
  const calls: string[] = []
  const view = new FormView(
    specFormBackend(
      {
        title: "Server",
        layout: "card",
        fields: [
          { type: "text", id: "name", label: "Name" },
          {
            type: "action",
            id: "testConnection",
            label: "Test connection",
            placement: "footer",
            buttonLabel: "Test",
            run: async () => {
              calls.push("testConnection")
              return { message: "Connected", tone: "success" }
            },
          },
          { type: "text", id: "note", label: "Note" },
        ],
      },
      () => {},
    ),
    { requestRender: () => {}, onClose: () => {} },
  )
  expect(view.form.cardLayout).toBe(true)
  const rendered = view.render(100, { ...plain, rows: 30 }).join("\n")
  expect(rendered).toContain("Test")
  expect(rendered).not.toContain("Test connection")
  expect(view.form.focused).toBe("name")
  view.handleInput(key("tab"))
  expect(view.form.focused).toBe("note")
  view.handleInput(key("tab"))
  expect(view.form.focused).toBe("testConnection")
  view.handleInput(key("enter"))
  await Bun.sleep(0)
  expect(calls).toEqual(["testConnection"])
  expect(view.render(100, { ...plain, rows: 30 }).join("\n")).toContain("Connected")
  view.close()
})

test("form view applies live updates and previews, blocks failed checks, and lets the user recover", async () => {
  const changes: string[] = []
  let saved: FormValues | undefined
  const spec: FormSpec = {
    title: "Live",
    fields: [
      { id: "name", type: "text", label: "Name" },
      { id: "summary", type: "text", label: "Summary" },
      { id: "saveAnyway", type: "checkbox", label: "Save anyway" },
    ],
    change: (values, previous) => {
      changes.push(`${previous.name}->${values.name}`)
      return values.name !== previous.name ? { values: { summary: `For ${values.name}` } } : {}
    },
    preview: (values) => [`Will save: ${values.summary}`],
    beforeSubmit: async ({ values, progress }) => {
      progress("Checking connection")
      return values.saveAnyway ? {} : { message: "Connection failed. Fix it or save anyway.", tone: "error" }
    },
  }
  const view = new FormView(
    specFormBackend(spec, (values) => {
      saved = values
    }),
    { requestRender: () => {}, onClose: () => {} },
  )
  view.handleInput(textKey("A"))
  expect(changes).toEqual(["->A"])
  expect(view.form.values.summary).toBe("For A")
  expect(view.render(80, plain).join("\n")).toContain("Will save: For A")
  view.handleInput(key("s", { ctrl: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(saved).toBeUndefined()
  expect(view.closed).toBe(false)
  expect(view.render(80, plain).join("\n")).toContain("Connection failed")
  view.handleInput(key("tab"))
  view.handleInput(key("tab"))
  view.handleInput(key("space"))
  view.handleInput(key("s", { ctrl: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(saved).toEqual({ name: "A", summary: "For A", saveAnyway: true })
  expect(view.closed).toBe(true)
})

/** A card form with a summary row, two waiting dialogs and a pending save check. */
const probeSpec: FormSpec = {
  title: "Probe",
  layout: "card",
  fields: [
    { id: "first", type: "text", label: "First", default: "First" },
    { id: "second", type: "text", label: "Second", default: "Second" },
  ],
  summaries: [{ id: "both", label: "Both", fields: ["first", "second"], summaryFields: ["first", "second"] }],
  beforeSubmit: () => new Promise<FormActionResult>(() => {}),
}

function probeRows(width: number, ctx: RenderContext = plain): string[] {
  const view = new FormView(
    specFormBackend(probeSpec, () => {}),
    {
      requestRender: () => {},
      onClose: () => {},
      waiting: () => ["First", "Second"],
    },
  )
  try {
    view.handleInput(key("s", { ctrl: true }))
    return view.render(width, { ...ctx, rows: 24 })
  } finally {
    view.close()
  }
}

test("ASCII forms spell notices, summaries and checking status in ASCII", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const rows = probeRows(80, { ...plain, glyphs: ascii.glyphs })
    expect(rows.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
    expect(rows.filter(Boolean).every((row) => visibleWidth(row) === 76)).toBe(true)
    expect(rows.find((row) => row.includes("Both First"))).toContain("Both First . Second [ Edit ]")
    expect(rows.find((row) => row.includes("dialogs wait"))).toContain(
      "! 2 dialogs wait behind this form: First . Second",
    )
    expect(rows.find((row) => row.includes("Checking before saving"))).toContain("Checking before saving...")

    // A narrow form cuts the notice and status again: those cuts still end in a complete ellipsis.
    const narrow = probeRows(24, { ...plain, glyphs: ascii.glyphs }).filter(Boolean)
    expect(narrow.join("\n")).not.toMatch(/[^\p{ASCII}]/u)
    const notice = narrow.find((row) => row.includes("dialogs wait"))!
    const status = narrow.find((row) => row.includes("Checking"))!
    expect(notice).toBe("! 2 dialogs wait behi...")
    expect(status).toBe("Checking before savin...")
    expect(visibleWidth(notice)).toBe(24)
    expect(visibleWidth(status)).toBe(24)

    // Outside ASCII mode the same rows keep the middle dot and the true ellipsis.
    setGlyphs()
    const unicodeRows = probeRows(80)
    expect(unicodeRows.filter(Boolean).every((row) => visibleWidth(row) === 76)).toBe(true)
    expect(unicodeRows.find((row) => row.includes("Both First"))).toContain("Both First · Second [ Edit ]")
    expect(unicodeRows.find((row) => row.includes("dialogs wait"))).toContain(
      "⚠️ 2 dialogs wait behind this form: First · Second",
    )
    expect(unicodeRows.find((row) => row.includes("Checking before saving"))).toContain(
      "Checking before saving…",
    )
  } finally {
    setGlyphs(before)
  }
})

test("form cuts follow the render context's marker, never a global one", () => {
  const before = { ...glyphs }
  try {
    setGlyphs()
    const base = probeRows(24).filter(Boolean)
    expect(base).toEqual([
      "  \u001b[1mProbe\u001b[22m",
      "────────────────────────",
      "  Both First ·… [ Edit ]",
      "────────────────────────",
      "⚠️ 2 dialogs wait behin…",
      "Checking before saving…",
      "› [ Save ]    [ Cancel ]",
      "^S save · Esc back",
    ])

    // A context marker reaches every cut, the notice and status rows included.
    expect(probeRows(24, { ...plain, glyphs: { ...defaultGlyphs, more: "~" } }).filter(Boolean)).toEqual([
      "  \u001b[1mProbe\u001b[22m",
      "────────────────────────",
      "  Both First ·~ [ Edit ]",
      "────────────────────────",
      "⚠️ 2 dialogs wait behin~",
      "Checking before saving…",
      "› [ Save ]    [ Cancel ]",
      "^S save · Esc back",
    ])

    // A custom global marker never overrides the context's own: these rows stay byte-identical.
    setGlyphs({ more: "*" })
    expect(probeRows(24).filter(Boolean)).toEqual(base)
    expect(probeRows(16).filter(Boolean)).toEqual([
      "  \u001b[1mProbe\u001b[22m",
      "────────────────",
      "  Both … [ Edit ]",
      "────────────────",
      "⚠️ 2 dialogs wa…",
      "Checking before…",
      "› [ Save ]    [ ",
      "^S save · Esc b…",
    ])
    // In a narrow context, the context's marker still ends the cut notice and status.
    setGlyphs()
    expect(probeRows(16, { ...plain, glyphs: { ...defaultGlyphs, more: "~" } }).filter(Boolean)).toEqual([
      "  \u001b[1mProbe\u001b[22m",
      "────────────────",
      "  Both ~ [ Edit ]",
      "────────────────",
      "⚠️ 2 dialogs wa~",
      "Checking before~",
      "› [ Save ]    [ ",
      "^S save · Esc b~",
    ])
  } finally {
    setGlyphs(before)
  }
})

test("custom non-ASCII separators leave form rows byte-identical", () => {
  const before = { ...glyphs }
  try {
    const expectedByWidth = new Map<number, string[]>()
    for (const width of [24, 40, 60, 80, 120]) {
      setGlyphs()
      expectedByWidth.set(width, probeRows(width))
    }
    setGlyphs({ separator: "|" })
    for (const [width, expected] of expectedByWidth) expect(probeRows(width)).toEqual(expected)
    // The theme's separator reaches its chrome, but not these host-composed form labels.
    expect(probeRows(80).filter((row) => /Both First|dialogs wait|Checking before/.test(row))).toEqual([
      "    │  Both First · Second [ Edit ]                                        │",
      "    │⚠️ 2 dialogs wait behind this form: First · Second                    │",
      "    │Checking before saving…                                               │",
    ])
  } finally {
    setGlyphs(before)
  }
})

test.each(["n", "y"])(
  "requesting discard during beforeSubmit invalidates the pending Save (answer: %s)",
  async (answer) => {
    const pending: Array<{ signal: AbortSignal; finish: () => void }> = []
    const answers: Array<FormValues | undefined> = []
    const view = new FormView(
      specFormBackend(
        {
          title: "Discard race",
          fields: [{ id: "name", type: "text", label: "Name" }],
          beforeSubmit: ({ signal }) =>
            new Promise((resolve) => pending.push({ signal, finish: () => resolve({}) })),
        },
        (values) => answers.push(values),
      ),
      { requestRender: () => {}, onClose: () => {} },
    )
    view.handleInput(textKey("A"))
    expect(view.form.dirty).toBe(true)
    view.handleInput(key("s", { ctrl: true }))
    expect(pending).toHaveLength(1)
    view.handleInput(key("escape"))
    expect(view.form.confirmingCancel).toBe(true)
    pending[0]!.finish()
    await Bun.sleep(0)
    expect(answers).toEqual([])
    expect(view.closed).toBe(false)
    expect(view.form.confirmingCancel).toBe(true)
    expect(pending[0]!.signal.aborted).toBe(true)
    view.handleInput(textKey(answer))
    await Bun.sleep(0)
    if (answer === "y") {
      expect(answers).toEqual([undefined])
      expect(view.closed).toBe(true)
    } else {
      expect(answers).toEqual([])
      expect(view.closed).toBe(false)
      view.handleInput(key("s", { ctrl: true }))
      expect(pending).toHaveLength(2)
      pending[1]!.finish()
      await Bun.sleep(0)
      expect(answers).toEqual([{ name: "A" }])
      expect(view.closed).toBe(true)
    }
  },
)

test("editing during beforeSubmit aborts the stale check and a later Save can finish", async () => {
  const pending: Array<{ signal: AbortSignal; finish: () => void }> = []
  let saved: FormValues | undefined
  const view = new FormView(
    specFormBackend(
      {
        title: "Race",
        fields: [{ id: "name", type: "text", label: "Name" }],
        beforeSubmit: ({ signal }) =>
          new Promise((resolve) => pending.push({ signal, finish: () => resolve({}) })),
      },
      (values) => {
        saved = values
      },
    ),
    { requestRender: () => {}, onClose: () => {} },
  )
  view.handleInput(textKey("A"))
  view.handleInput(key("s", { ctrl: true }))
  expect(pending).toHaveLength(1)
  view.handleInput(textKey("B"))
  expect(pending[0]!.signal.aborted).toBe(true)
  view.handleInput(key("s", { ctrl: true }))
  expect(pending).toHaveLength(2)
  pending[0]!.finish()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(view.closed).toBe(false)
  expect(saved).toBeUndefined()
  pending[1]!.finish()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(saved).toEqual({ name: "AB" })
})
