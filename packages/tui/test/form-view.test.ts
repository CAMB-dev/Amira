import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type AnyEvent, defineTool, type FormSpec, textResult } from "@amira/api"
import { Agent, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { FakeTerminal, key, textKey } from "@amira/tui-kit"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"
import { FormView, runFormScreen, specFormBackend } from "../src/form-view.ts"

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

test("a form opens full screen, queues a dialog behind it, and gives the inline UI back as it was", async () => {
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
  await waitFor(() => !screen.inAltScreen && live().includes("? Deploy too? (other)"), "inline dialog")
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
  const { host, terminal, screen, live, exited } = await setup([])
  const first = host.ui.api("x").form(webhookForm([]))
  await waitFor(() => screen.inAltScreen, "form")
  terminal.send("h")
  terminal.send("\x1b[27u")
  await waitFor(() => live().includes("Discard your changes?"), "confirm")
  terminal.send("n")
  terminal.send("\x1b[27u")
  terminal.send("y")
  expect(await first).toBeUndefined()
  await waitFor(() => !screen.inAltScreen, "closed")

  const second = host.ui.api("x").form(webhookForm([]))
  await waitFor(() => screen.inAltScreen, "second form")
  host.ui.cancelAll("x")
  expect(await second).toBeUndefined()
  await waitFor(() => !screen.inAltScreen, "closed by cancel")
  terminal.send("\x03")
  await exited
})

test("a secret input dialog is masked and its answer is not echoed", async () => {
  const { host, terminal, live, all, exited } = await setup([])
  const key = host.ui.api("x").input("API key", { secret: true })
  await waitFor(() => live().includes("? API key"), "dialog")
  terminal.send("\x1b[200~sk-abc-123\n\x1b[201~")
  await waitFor(() => live().includes("**********"), "mask")
  terminal.send("\r")
  expect(await key).toBe("sk-abc-123")
  await waitFor(() => all().includes("? API key › (hidden)"), "answer line")
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
