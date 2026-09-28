import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import {
  type AnyEvent,
  type CommandDefinition,
  defineTool,
  type SessionControl,
  textResult,
} from "@amira/api"
import { Agent, CommandHost, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import statusExtension from "@amira/ext-status"
import { FakeTerminal } from "@amira/tui-kit"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"
import { summarizeArgs, toolLines } from "../src/format.ts"

const noProbe = async () => ({
  capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
  leftoverInput: "",
})

/** Alt+Enter in the kitty keyboard protocol. */
const ALT_ENTER = "\x1b[13;3u"
/** Windows terminals keep Alt+Enter for fullscreen, so the hint names Ctrl+Q there. */
const QUEUE_HINT = process.platform === "win32" ? "Ctrl+Q" : "Alt+Enter"

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

interface SetupOptions {
  cols?: number
  rows?: number
  initialPrompt?: string
  leftoverInput?: string
  startupEvents?: AnyEvent[]
  /** Slash commands to offer; the UI gets a CommandHost when given. */
  commands?: CommandDefinition[]
  control?: Partial<SessionControl>
}

async function setup(steps: MockStep[], o: SetupOptions = {}) {
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  await host.load(statusExtension, "builtin:status")
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m1"), cwd: "/work/proj", systemPrompt: "", bus, tools })
  tools.register(
    defineTool<{ path: string }>({
      name: "read",
      description: "",
      parameters: {},
      execute: async (p) => textResult(`contents of ${p.path}\nline 2\nline 3`),
    }),
    "test",
  )
  const cols = o.cols ?? 60
  const rows = o.rows ?? 20
  const terminal = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const write = terminal.write.bind(terminal)
  terminal.write = (d: string) => {
    write(d)
    screen.write(d)
  }
  let commands: CommandHost | undefined
  if (o.commands) {
    await host.load((api) => {
      for (const c of o.commands!) api.registerCommand(c)
    }, "test-commands")
    commands = new CommandHost({
      registry: host.commands,
      bus,
      ui: host.ui,
      control: (o.control ?? {}) as SessionControl,
      agent,
    })
  }
  const exited = runInteractive({
    agent,
    status: host.status,
    ui: host.ui,
    ...(commands ? { commands } : {}),
    terminal,
    setup: async () => ({ ...(await noProbe()), leftoverInput: o.leftoverInput ?? "" }),
    onReady: () => agent.start("startup"),
    ...(o.initialPrompt ? { initialPrompt: o.initialPrompt } : {}),
    ...(o.startupEvents ? { startupEvents: o.startupEvents } : {}),
  })
  const all = () => [...screen.scrollback, ...screen.lines].join("\n")
  const live = () => screen.lines.join("\n")
  const shows = (s: string) => waitFor(() => all().includes(s), JSON.stringify(s))
  const idle = async () => {
    await waitFor(() => agent.status === "idle", "idle")
    await bus.flush()
    await Bun.sleep(30)
  }
  await shows("Amira")
  return { agent, ai, bus, host, commands, terminal, screen, all, live, shows, idle, exited }
}

test("a conversation: user message, tool call and reply end up in the transcript", async () => {
  const { terminal, all, shows, idle, exited } = await setup([
    { toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
    { text: "The file has three lines." },
  ])
  expect(all()).toContain("mock/m1")
  terminal.send("what is in a.ts?\r")
  await shows("The file has three lines.")
  await idle()
  const text = all()
  expect(text).toContain("› what is in a.ts?")
  expect(text).toContain("● read a.ts")
  expect(text).toContain("⎿ contents of a.ts (+2 lines)")
  expect(text.indexOf("● read")).toBeLessThan(text.indexOf("The file has three lines."))
  terminal.send("\x03")
  expect(await exited).toBe(0)
  expect(terminal.isRaw).toBe(false)
})

test("Esc interrupts a running turn, keeps the partial text and sends queued messages after", async () => {
  const { terminal, all, shows, idle, agent, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    { text: "second answer" },
  ])
  terminal.send("first\r")
  await waitFor(() => agent.status === "working", "working")
  await shows("01234567")
  terminal.send(`follow up${ALT_ENTER}`)
  await shows("queued › follow up")
  terminal.send("\x1b[27u")
  await shows("Interrupted.")
  await shows("second answer")
  await idle()
  const text = all()
  expect(text).toContain("› follow up")
  const partial = agent.messages.find((m) => m.role === "assistant")
  const kept =
    partial?.role === "assistant" && partial.content[0]?.type === "text" ? partial.content[0].text : ""
  expect(kept.length).toBeGreaterThan(0)
  expect(text).toContain(kept)
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("the status bar shows items from the status extension", async () => {
  const { live, terminal, exited } = await setup([])
  await waitFor(() => live().includes("mock/m1") && live().includes("proj"), "status bar")
  terminal.send("\x03")
  await exited
})

test("Ctrl+C clears a non-empty editor before quitting; Ctrl+D quits on an empty editor", async () => {
  const { terminal, live, exited } = await setup([])
  terminal.send("draft")
  await waitFor(() => live().includes("draft"), "draft")
  expect(live()).toContain("Ctrl+C clear")
  terminal.send("\x03")
  await waitFor(() => !live().includes("draft"), "cleared")
  terminal.send("\x04")
  expect(await exited).toBe(0)
})

test("an initial prompt is sent first; input typed during startup is queued, not lost", async () => {
  const { agent, shows, idle, terminal, exited } = await setup(
    [{ text: "one", delayMs: 10 }, { text: "two" }],
    {
      initialPrompt: "INITIAL",
      leftoverInput: "typed early\r",
    },
  )
  await shows("two")
  await idle()
  const users = agent.messages
    .filter((m) => m.role === "user")
    .map((m) => (m.content[0] as { text: string }).text)
  expect(users).toEqual(["INITIAL", "typed early"])
  terminal.send("\x03")
  await exited
})

test("turn events from other sessions on the bus do not affect the UI", async () => {
  const { bus, terminal, agent, shows, idle, exited } = await setup([{ text: "hello", delayMs: 20 }])
  terminal.send("go\r")
  await waitFor(() => agent.status === "working", "working")
  bus.emit("turn.end", { reason: "done", steps: 1 }, { sessionId: "sub_agent" })
  terminal.send(`second${ALT_ENTER}`)
  await shows("queued › second")
  await idle()
  terminal.send("\x03")
  await exited
})

test("Ctrl+Q queues a message while working, like Alt+Enter", async () => {
  const { terminal, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    { text: "second answer" },
  ])
  terminal.send("go\r")
  await waitFor(() => agent.status === "working", "working")
  terminal.send("later\x11")
  await shows("queued › later")
  await shows("second answer")
  await idle()
  const users = agent.messages
    .filter((m) => m.role === "user")
    .map((m) => (m.content[0] as { text: string }).text)
  expect(users).toEqual(["go", "later"])
  terminal.send("\x03")
  await exited
})

test("a long streaming reply is committed progressively so its start stays visible", async () => {
  const reply = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n")
  const { terminal, screen, shows, idle, all, exited } = await setup([{ text: reply, delayMs: 5 }], {
    rows: 8,
  })
  terminal.send("go\r")
  await waitFor(() => screen.scrollback.join("\n").includes("line 1"), "early commit")
  await shows("line 15")
  await idle()
  const text = all()
  for (let i = 1; i <= 15; i++) expect(text.split(`line ${i}\n`).length - 1).toBeLessThanOrEqual(1)
  expect(text.indexOf("line 1\n")).toBeLessThan(text.indexOf("line 15"))
  terminal.send("\x03")
  await exited
})

test("a reply with only thinking says so instead of showing nothing", async () => {
  const { terminal, shows, exited } = await setup([{ thinking: "hmm" }])
  terminal.send("go\r")
  await shows("(no reply)")
  terminal.send("\x03")
  await exited
})

test("startup extension errors are shown in the transcript", async () => {
  const startupEvents: AnyEvent[] = [
    { seq: 1, ts: 0, sessionId: "host", type: "extension.error", data: { source: "x.ts", error: "boom" } },
    {
      seq: 2,
      ts: 0,
      sessionId: "host",
      type: "extension.error",
      data: { source: "settings", error: 'f: unknown setting "colour" (ignored)' },
    },
  ]
  const { shows, terminal, exited } = await setup([], { startupEvents })
  await shows("[extension x.ts] boom")
  await shows('warning: f: unknown setting "colour" (ignored)')
  terminal.send("\x03")
  await exited
})

test("summarizeArgs keeps short scalar arguments on one line", () => {
  expect(summarizeArgs({ command: "bun  test\n--watch", timeout: 5, obj: { a: 1 } })).toBe(
    "bun test --watch 5",
  )
  expect(summarizeArgs({ x: "a".repeat(200) }, 10)).toBe(`${"a".repeat(9)}…`)
})

test("tool lines fit the terminal width", () => {
  const plain = {
    text: (s: string) => s,
    accent: (s: string) => s,
    muted: (s: string) => s,
    error: (s: string) => s,
    success: (s: string) => s,
    warning: (s: string) => s,
  }
  const lines = toolLines(plain, "bash", { command: "x".repeat(300) }, textResult("y".repeat(300)), 0, 40)
  expect(lines.every((l) => l.length <= 40)).toBe(true)
})

test("the running tool is on screen before the tool starts, even if it blocks the event loop", async () => {
  const { terminal, screen, shows, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "block", args: {} }] },
    { text: "ok" },
  ])
  let seenWhileRunning = ""
  agent.tools.register(
    defineTool({
      name: "block",
      description: "",
      parameters: {},
      execute: async () => {
        seenWhileRunning = screen.lines.join("\n")
        const until = performance.now() + 200
        while (performance.now() < until) {}
        return textResult("done")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await shows("● block")
  await idle()
  // The running tool is drawn as its own line with a blinking bullet.
  expect(seenWhileRunning).toContain("● block")
  expect(seenWhileRunning).toContain("running block")
  terminal.send("\x03")
  await exited
})

test("running tools show as lines with their arguments and are replaced by the result", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "slow", args: { command: "bun test --watch" } }] },
    { text: "ok" },
  ])
  let release!: () => void
  agent.tools.register(
    defineTool({
      name: "slow",
      description: "",
      parameters: {},
      execute: () =>
        new Promise((r) => {
          release = () => r(textResult("passed"))
        }),
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => live().includes("● slow bun test --watch"), "running line")
  release()
  await shows("⎿ passed")
  await idle()
  // The live line was replaced by the committed one, not left behind as a duplicate.
  expect(all().split("● slow bun test --watch").length - 1).toBe(1)
  terminal.send("\x03")
  await exited
})

const lastUserText = (req: { messages: { role: string; content: unknown }[] }) => {
  const m = req.messages.at(-1)!
  return m.role === "user" ? (m.content as { text: string }[])[0]!.text : m.role
}

test("Enter while working steers the turn; the message joins it before the next model call", async () => {
  const { terminal, live, all, shows, idle, exited } = await setup([
    { text: "looking", delayMs: 40, toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
    (req) => ({ text: `saw ${lastUserText(req)}` }),
  ])
  terminal.send("go\r")
  await waitFor(() => live().includes(`Enter steer · ${QUEUE_HINT} queue`), "steer hint")
  terminal.send("also B\r")
  await shows("saw also B")
  await idle()
  const text = all()
  expect(text.indexOf("● read")).toBeLessThan(text.indexOf("› also B"))
  expect(text.indexOf("› also B")).toBeLessThan(text.indexOf("saw also B"))
  expect(live()).not.toContain("steering ›")
  terminal.send("\x03")
  await exited
})

test("steering the final reply becomes the next turn, not editor text", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    { text: "next reply" },
  ])
  terminal.send("go\r")
  await shows("01234567")
  terminal.send("then this\r")
  await shows("next reply")
  await idle()
  expect(agent.messages.filter((m) => m.role === "user").length).toBe(2)
  expect(live()).not.toContain("steering ›")
  // The editor is empty (its placeholder shows) and the message appears once, as a prompt.
  expect(live()).toContain("› Message Amira")
  expect(live().split("› then this").length).toBe(2)
  terminal.send("\x03")
  await exited
})

test("a steering message an interrupt drops goes back into the editor", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
  ])
  terminal.send("go\r")
  await shows("01234567")
  terminal.send("keep this\r")
  await waitFor(() => live().includes("steering › keep this"), "steering line")
  terminal.send("\x1b[27u")
  await shows("Interrupted.")
  await idle()
  expect(live()).toContain("› keep this")
  expect(live()).not.toContain("steering ›")
  expect(agent.messages.filter((m) => m.role === "user").length).toBe(1)
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("extension dialogs are answered inline: confirm, select and input", async () => {
  const { host, terminal, live, all, shows, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "ask", args: {} }] },
    { text: "thanks" },
  ])
  await host.load((api) => {
    api.registerTool(
      defineTool({
        name: "ask",
        description: "",
        parameters: {},
        execute: async () => {
          const ok = await api.ui.confirm("Proceed?", "It is safe")
          const pick = await api.ui.select("Pick one", ["red", "green", "blue"])
          const name = await api.ui.input("Name", { placeholder: "your name" })
          const cancelled = await api.ui.input("Skip me")
          return textResult(`${ok} ${pick} ${name} ${cancelled}`)
        },
      }),
    )
  }, "asker")
  terminal.send("go\r")
  await waitFor(() => live().includes("? Proceed? (asker)"), "confirm")
  expect(live()).toContain("It is safe")
  terminal.send("y")
  await waitFor(() => live().includes("? Pick one"), "select")
  terminal.send("\x1b[B\r")
  await waitFor(() => live().includes("? Name"), "input")
  terminal.send("Ada\r")
  await waitFor(() => live().includes("? Skip me"), "second input")
  terminal.send("\x1b[27u")
  await shows("thanks")
  await idle()
  const result = agent.messages.find((m) => m.role === "toolResult")
  expect(result?.content[0]).toEqual({ type: "text", text: "true green Ada undefined" })
  expect(all()).toContain("? Pick one › green")
  expect(all()).toContain("? Skip me › cancelled")
  expect(host.ui.pending).toEqual([])
  terminal.send("\x03")
  await exited
})

const MODELS = ["deepseek/deepseek-flash", "deepseek/deepseek-pro", "openai/gpt-5"]

/** Commands like the built-in ones, enough to drive the popup. */
function testCommands(log: string[]): CommandDefinition[] {
  return [
    { name: "help", description: "List the slash commands", run: (_a, ctx) => ctx.print("HELP TEXT") },
    { name: "clear", description: "Start a new session", run: async (_a, ctx) => ctx.session.newSession() },
    {
      name: "model",
      description: "Switch the model",
      args: { hint: "[provider/model]", complete: () => MODELS.map((value) => ({ value })) },
      async run(args, ctx) {
        const ref = args || (await ctx.ui.select("Model", MODELS))
        log.push(`model ${ref}`)
        ctx.print(`Model: ${ref}`)
      },
    },
    { name: "status", description: "Show the status", run: (_a, ctx) => ctx.print("STATUS OK", "warning") },
    { name: "quit", description: "Leave Amira", run: (_a, ctx) => ctx.quit() },
  ]
}

test("typing a slash opens the command list above the editor; Tab and Enter complete and run", async () => {
  const log: string[] = []
  const { terminal, live, shows, exited } = await setup([], { commands: testCommands(log) })
  terminal.send("/")
  await waitFor(() => live().includes("/status"), "popup")
  const rows = live().split("\n")
  const popupRow = rows.findIndex((l) => l.includes("/clear"))
  const editorRow = rows.findIndex((l) => l.trimEnd() === "› /")
  expect(popupRow).toBeGreaterThan(-1)
  expect(popupRow).toBeLessThan(editorRow)
  expect(live()).toContain("↑↓ select · Tab complete · Enter run · Esc close")
  // Prefix first: "/he" puts help on top; Tab completes it, Enter runs it.
  terminal.send("he")
  await waitFor(() => live().includes("› /help"), "help selected")
  terminal.send("\t")
  await waitFor(() => live().includes("› /help "), "completed")
  terminal.send("\r")
  await shows("HELP TEXT")
  expect(live()).toContain("› Message Amira")
  terminal.send("\x03")
  await exited
})

test("arguments complete after the name, ↑↓ pick one and Enter runs with it", async () => {
  const log: string[] = []
  const { terminal, live, shows, exited } = await setup([], { commands: testCommands(log) })
  terminal.send("/model ")
  await waitFor(() => live().includes("openai/gpt-5"), "model candidates")
  terminal.send("\x1b[B\x1b[B")
  await waitFor(() => live().includes("› openai/gpt-5"), "selection moved")
  terminal.send("\r")
  await shows("Model: openai/gpt-5")
  // Part of a candidate typed: Enter takes the best match.
  terminal.send("/model flash")
  await waitFor(() => live().includes("› deepseek/deepseek-flash"), "filtered")
  terminal.send("\r")
  await shows("Model: deepseek/deepseek-flash")
  expect(log).toEqual(["model openai/gpt-5", "model deepseek/deepseek-flash"])
  terminal.send("\x03")
  await exited
})

test("keys arriving in one chunk are not answered by the popup of the previous frame", async () => {
  const log: string[] = []
  const { terminal, live, shows, exited } = await setup([], { commands: testCommands(log) })
  terminal.send("/model deep")
  await waitFor(() => live().includes("› deepseek/deepseek-flash"), "candidates for deep")
  terminal.send("seek/deepseek-pro\r")
  await shows("Model: deepseek/deepseek-pro")
  expect(log).toEqual(["model deepseek/deepseek-pro"])
  terminal.send("\x03")
  await exited
})

test("a command's picker is a select dialog that filters as you type", async () => {
  const log: string[] = []
  const { terminal, live, shows, exited } = await setup([], { commands: testCommands(log) })
  terminal.send("/model")
  await waitFor(() => live().includes("› /model"), "popup")
  terminal.send("\r")
  await waitFor(() => live().includes("? Model"), "picker")
  terminal.send("gpt")
  await waitFor(() => live().includes("filter › gpt") && !live().includes("deepseek-pro"), "filtered")
  terminal.send("\r")
  await shows("Model: openai/gpt-5")
  terminal.send("\x03")
  await exited
})

test("Esc closes the popup without leaving the text; Enter then runs what was typed", async () => {
  const log: string[] = []
  const { terminal, live, all, shows, exited } = await setup([], { commands: testCommands(log) })
  terminal.send("/sta")
  await waitFor(() => live().includes("› /status"), "popup")
  terminal.send("\x1b[27u")
  await waitFor(() => !live().includes("Show the status"), "closed")
  expect(live()).toContain("› /sta")
  terminal.send("tus\r")
  await shows("STATUS OK")
  expect(all()).toContain("› /status")
  terminal.send("\x03")
  await exited
})

test("unknown commands are reported and not sent to the model; slash paths are messages", async () => {
  const { terminal, agent, shows, idle, exited } = await setup([{ text: "a path" }], {
    commands: testCommands([]),
  })
  terminal.send("/nope\r")
  await shows("Unknown command /nope")
  expect(agent.messages).toEqual([])
  terminal.send("/usr/bin is empty\r")
  await shows("a path")
  await idle()
  expect(agent.messages.filter((m) => m.role === "user")).toHaveLength(1)
  terminal.send("\x03")
  await exited
})

test("a command typed during a turn runs at once instead of steering it", async () => {
  const { terminal, agent, shows, idle, exited } = await setup(
    [{ text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 }],
    { commands: testCommands([]) },
  )
  terminal.send("go\r")
  await waitFor(() => agent.status === "working", "working")
  terminal.send("/status")
  await Bun.sleep(20)
  terminal.send("\r")
  await shows("STATUS OK")
  await idle()
  expect(agent.messages.filter((m) => m.role === "user")).toHaveLength(1)
  terminal.send("\x03")
  await exited
})

test("the UI follows the session a command switches to, and /quit leaves", async () => {
  let host!: CommandHost
  let next!: Agent
  const { terminal, shows, idle, exited, ...s } = await setup([{ text: "from the new session" }], {
    commands: testCommands([]),
    control: {
      newSession: async () => {
        next = new Agent({
          ai: s.ai,
          model: s.ai.model("mock/m1"),
          cwd: "/work/proj",
          systemPrompt: "",
          bus: s.bus,
        })
        host.switchTo(next)
      },
    },
  })
  host = s.commands!
  terminal.send("/clear\r")
  await waitFor(() => next !== undefined, "switched")
  terminal.send("hello\r")
  await shows("from the new session")
  await idle()
  expect(next.messages.filter((m) => m.role === "user")).toHaveLength(1)
  expect(s.agent.messages).toEqual([])
  terminal.send("/quit\r")
  expect(await exited).toBe(0)
})
