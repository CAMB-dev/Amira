import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import {
  type AnyEvent,
  type CommandDefinition,
  defineTool,
  type SessionControl,
  textResult,
} from "@amira/api"
import {
  Agent,
  AgentTree,
  CommandHost,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  ToolRegistry,
} from "@amira/core"
import statusExtension from "@amira/ext-status"
import { FakeTerminal } from "@amira/tui-kit"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"
import { subagentLines } from "../src/format.ts"

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
  /** Give the agent a tree, so tools can start sub-agents. */
  tree?: boolean
  /** Called after every write to the terminal, once the screen shows it. */
  onWrite?: (screen: VirtualScreen) => void
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
  const tree = o.tree ? { tree: new AgentTree({ ai, sections: () => [] }) } : {}
  const agent = new Agent({
    ai,
    model: ai.model("mock/m1"),
    cwd: "/work/proj",
    systemPrompt: "",
    bus,
    tools,
    ...tree,
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
  const cols = o.cols ?? 60
  const rows = o.rows ?? 20
  const terminal = new FakeTerminal(cols, rows)
  const screen = new VirtualScreen(cols, rows)
  const write = terminal.write.bind(terminal)
  terminal.write = (d: string) => {
    write(d)
    screen.write(d)
    o.onWrite?.(screen)
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

/**
 * Follows markers (L1, P2, ...) through a transcript. After every write, the markers on screen or
 * in the scrollback must have no hole: a hole means a line was drawn and then lost off the top of
 * the live region, to be printed again later — the view jumps back up when that happens.
 */
function transcriptChecker(markers: string[]) {
  const index = new Map(markers.map((m, i) => [m, i]))
  const problems: string[] = []
  const found = (screen: VirtualScreen) =>
    [...screen.scrollback, ...screen.lines].join("\n").match(/\b[LP]\d+\b/g) ?? []
  return {
    problems,
    onWrite(screen: VirtualScreen) {
      const seen = new Set(found(screen).map((m) => index.get(m) ?? -1))
      const max = Math.max(-1, ...seen)
      for (let i = 0; i <= max; i++) {
        if (seen.has(i)) continue
        if (problems.length < 5) problems.push(`${markers[i]} is gone while ${markers[max]} is shown`)
        break
      }
    },
    /** Every marker reached the transcript exactly once, in order. */
    final(screen: VirtualScreen) {
      expect([...found(screen)]).toEqual(markers)
    },
  }
}

test("a reply longer than the screen reaches the scrollback once, in order, never cut and reprinted", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `L${i + 1} some text`)
  const para = Array.from({ length: 90 }, (_, i) => `P${i + 1}`)
  const tail = Array.from({ length: 10 }, (_, i) => `L${i + 31}`)
  const reply = [...lines, para.join(" "), ...tail].join("\n")
  const check = transcriptChecker([...lines.map((l) => l.split(" ")[0]!), ...para, ...tail])
  const { terminal, screen, shows, idle, exited } = await setup([{ text: reply, delayMs: 1 }], {
    cols: 40,
    rows: 12,
    onWrite: (s) => check.onWrite(s),
  })
  terminal.send("go\r")
  await shows("L40")
  await idle()
  expect(check.problems).toEqual([])
  check.final(screen)
  terminal.send("\x03")
  await exited
})

test("a draft typed while a long reply streams does not cut the reply either", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `L${i + 1}`)
  const check = transcriptChecker(lines)
  const { terminal, screen, shows, idle, exited } = await setup([{ text: lines.join("\n"), delayMs: 2 }], {
    cols: 40,
    rows: 12,
    onWrite: (s) => check.onWrite(s),
  })
  terminal.send("go\r")
  await shows("L8")
  terminal.send(`\x1b[200~${Array.from({ length: 30 }, (_, i) => `draft ${i}`).join("\n")}\x1b[201~`)
  await shows("L40")
  await idle()
  expect(check.problems).toEqual([])
  check.final(screen)
  // The first Ctrl+C clears the draft.
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("the editor sits in a rounded box above the status bar, with the caret inside", async () => {
  const { terminal, screen, live, exited } = await setup([], { cols: 30, rows: 12 })
  await waitFor(() => live().includes("Message Amira"), "input box")
  terminal.send("héllo 你好")
  await waitFor(() => live().includes("héllo 你好"), "typed text")
  const rows = screen.lines
  const top = rows.findIndex((l) => l.startsWith("╭"))
  expect(rows.slice(top, top + 3)).toEqual([
    `╭${"─".repeat(28)}╮`,
    "│ › héllo 你好               │",
    `╰${"─".repeat(28)}╯`,
  ])
  expect(rows[top + 3]).toContain("mock/m1")
  // Border, space, prompt, "héllo " and two wide characters.
  expect({ x: screen.x, y: screen.y }).toEqual({ x: 2 + 2 + 6 + 4, y: top + 1 })
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("a long draft scrolls inside the input box instead of growing past the screen", async () => {
  const { terminal, screen, live, exited } = await setup([], { cols: 30, rows: 12 })
  await waitFor(() => live().includes("Message Amira"), "input box")
  terminal.send(`\x1b[200~${Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join("\n")}\x1b[201~`)
  await waitFor(() => live().includes("row 20"), "draft")
  const rows = screen.lines
  const top = rows.findIndex((l) => l.startsWith("╭"))
  // A third of 12 rows shows; the border counts the rest.
  expect(rows[top]).toContain("↑ 16 more")
  expect(rows.slice(top + 1, top + 5).map((l) => l.slice(1, -1).trim())).toEqual([
    "row 17",
    "row 18",
    "row 19",
    "row 20",
  ])
  expect(rows[top + 5]!.startsWith("╰")).toBe(true)
  expect(rows[top + 6]).toContain("mock/m1")
  // The start of the transcript is still in view: the box did not push it off.
  expect(rows[0]).toContain("Amira")
  // Moving up past the shown rows scrolls, and the border says what is below.
  for (let i = 0; i < 6; i++) terminal.send("\x1b[A")
  await waitFor(() => live().includes("↓ 3 more"), "scrolled up")
  expect(live()).toContain("↑ 13 more")
  expect(screen.y).toBe(top + 1)
  terminal.send("\x03")
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
  // The running tool is drawn as its own line with a spinner and its time on the right, and the
  // activity line under it has the turn's time and how to interrupt.
  expect(seenWhileRunning).toMatch(/● block +[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 0s/)
  expect(seenWhileRunning).toMatch(/^0s · (↓ \d+ tokens · )?Esc interrupt$/m)
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
  // The editor sits in the input box: "│ › /     │".
  const editorRow = rows.findIndex((l) => /^│ › \/ *│$/.test(l.trimEnd()))
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
  terminal.send("")
  await exited
})

test("running sub-agents show with role, elapsed time, tokens and task, and go away when done", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      { toolCalls: [{ name: "delegate", args: {} }] },
      { text: "child says hi", delayMs: 150, usage: { input: 1500, output: 20 } },
      { text: "all done" },
    ],
    { cols: 80, tree: true },
  )
  agent.tools.register(
    defineTool({
      name: "delegate",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        const r = await ctx.session!.spawn!({ role: "explorer", prompt: "find the   config file" }).result()
        return textResult(r.text)
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => live().includes("◆ explorer · 0s · 0 tok · find the config file"), "sub-agent line")
  await shows("all done")
  await idle()
  // The running line is gone; a one-line summary of how it ended is in the transcript instead.
  expect(live()).not.toContain("◆ explorer ·")
  expect(all()).toMatch(/◆ explorer ✓ \d+\.\ds · 1\.5k tok · child says hi\n● delegate/)
  // The child's reply only shows as its commander's tool result, not as a reply of its own.
  expect(all()).toContain("⎿ child says hi")
  expect(all()).not.toMatch(/^child says hi$/m)
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

test("sub-agent lines: queued ones say so, deeper ones are indented, long tasks are cut", () => {
  const theme = { accent: (s: string) => s, muted: (s: string) => s } as never
  const lines = subagentLines(
    [
      { role: "coder", task: "a\nb", depth: 1, startedAt: 1000, tokens: 12_345 },
      { role: "explorer", task: "x".repeat(100), depth: 2, tokens: 0 },
    ],
    6500,
    40,
    theme,
  )
  expect(lines).toEqual(["◆ coder · 5s · 12.3k tok · a b", "  ◆ explorer · queued · 0 tok · xxxxxxx…", ""])
})

test("a diff review shows the diff above its options", async () => {
  const { host, terminal, live, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "review", args: {} }] },
    { text: "reviewed" },
  ])
  await host.load((api) => {
    api.registerTool(
      defineTool({
        name: "review",
        description: "",
        parameters: {},
        execute: async () =>
          textResult(
            String(
              await api.ui.reviewDiff("Merge?", "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n", [
                "merge",
                "keep",
              ]),
            ),
          ),
      }),
    )
  }, "reviewer")
  terminal.send("go\r")
  await waitFor(() => live().includes("? Merge?"), "review dialog")
  expect(live()).toContain("-old")
  expect(live()).toContain("+new")
  expect(live()).toContain("› merge")
  terminal.send("2")
  await idle()
  expect(agent.messages.find((m) => m.role === "toolResult")?.content[0]).toEqual({
    type: "text",
    text: "keep",
  })
  terminal.send("\x03")
  await exited
})
