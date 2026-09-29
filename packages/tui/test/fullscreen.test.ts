import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import {
  type ChildSession,
  type CommandDefinition,
  defineTool,
  type FormSpec,
  type Message,
  type SessionControl,
  type TuiSettings,
  textResult,
} from "@amira/api"
import {
  Agent,
  AgentTree,
  CommandHost,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  listSubagents,
  ToolRegistry,
} from "@amira/core"
import { agentsCommand } from "@amira/ext-agent"
import statusExtension from "@amira/ext-status"
import { FakeTerminal } from "@amira/tui-kit"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

const ESC = "\x1b[27u"
const CTRL_UP = "\x1b[1;5A"
const PAGE_UP = "\x1b[5~"
const END = "\x1b[F"
const CTRL_F = "\x06"
const SHIFT_ENTER = "\x1b[13;2u"
const WHEEL_UP = "\x1b[<64;5;5M"

interface Options {
  cols?: number
  rows?: number
  tree?: boolean
  history?: Message[]
  settings?: TuiSettings
  /** /agents and a /quit, with the session control the viewer reads. */
  commands?: boolean
}

/** The UI in full-screen mode on a fake terminal, as the CLI starts it by default. */
async function setup(steps: MockStep[], o: Options = {}) {
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  await host.load(statusExtension, "builtin:status")
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const tree = o.tree || o.commands ? new AgentTree({ ai, sections: () => [] }) : undefined
  const agent = new Agent({
    ai,
    model: ai.model("mock/m1"),
    cwd: "/work/proj",
    systemPrompt: "",
    bus,
    tools,
    ...(tree ? { tree } : {}),
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
  if (o.history) agent.messages.push(...o.history)
  let commands: CommandHost | undefined
  if (o.commands) {
    const quit: CommandDefinition = { name: "quit", description: "Leave", run: (_a, ctx) => ctx.quit() }
    await host.load((api) => {
      api.registerCommand(agentsCommand())
      api.registerCommand(quit)
    }, "builtin:agent")
    const control = {
      subagents: () => listSubagents(agent, tree!).map((e) => e.info),
      subagentMessages: (id: string) =>
        listSubagents(agent, tree!)
          .find((e) => e.info.id === id)
          ?.messages(),
    } as Partial<SessionControl> as SessionControl
    commands = new CommandHost({ registry: host.commands, bus, ui: host.ui, control, agent })
  }
  const cols = o.cols ?? 60
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
    ...(commands ? { commands } : {}),
    terminal,
    mode: "fullscreen",
    setup: async () => ({
      capabilities: {
        win32InputMode: false,
        kittyKeyboard: true,
        synchronizedOutput: false,
        shiftEnter: true,
      },
      leftoverInput: "",
    }),
    onReady: () => agent.start("startup"),
    files: { files: async () => [] },
    env: {},
    ...(o.settings ? { settings: o.settings } : {}),
  })
  /** What the alternate screen shows now. */
  const view = () => screen.lines.join("\n")
  const shows = (s: string) => waitFor(() => view().includes(s), JSON.stringify(s))
  const idle = async () => {
    await waitFor(() => agent.status === "idle", "idle")
    await bus.flush()
    await Bun.sleep(40)
  }
  const resize = (c: number, r: number) => {
    screen.resize(c, r)
    terminal.setSize(c, r)
  }
  await shows("Amira")
  return { agent, bus, host, terminal, screen, view, shows, idle, resize, exited }
}

test("the conversation is drawn on the alternate screen and printed to the normal one on exit", async () => {
  const { terminal, screen, view, shows, idle, exited } = await setup([
    { toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
    { text: "The file has three lines." },
  ])
  expect(screen.inAltScreen).toBe(true)
  // Mouse reporting is on, for the wheel.
  expect(terminal.output).toContain("\x1b[?1000h\x1b[?1006h")
  terminal.send("what is in a.ts?\r")
  await shows("The file has three lines.")
  await idle()
  const conversation = [
    "Amira · mock/m1 · /work/proj",
    "",
    "› what is in a.ts?",
    "",
    "● read a.ts",
    "  └ contents of a.ts (+2 lines)",
    "",
    "  The file has three lines.",
  ].join("\n")
  // Right above the bottom area, which stays at the bottom of the screen.
  expect(view()).toContain(`${conversation}\n\n╭`)
  expect(screen.lines.at(-1)).toContain("Enter send")
  terminal.send("\x03")
  expect(await exited).toBe(0)
  expect(screen.inAltScreen).toBe(false)
  expect(terminal.output).toContain("\x1b[?1006l\x1b[?1000l")
  // The normal screen holds the conversation as the inline UI would have left it, no input box.
  expect(screen.mainText).toBe(conversation)
  expect(screen.altSwitches).toEqual([true, false])
})

test("a streaming reply follows the end; scrolling up keeps its place and says there is new output", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n\n")
  const { terminal, view, shows, idle, exited } = await setup([
    { text: long, delayMs: 1 },
    { text: "second reply" },
  ])
  terminal.send("go\r")
  await shows("line 20")
  // Following: the newest rows are in view while it streams.
  await shows("line 60")
  await idle()
  expect(view()).not.toContain("line 1\n")
  terminal.send(PAGE_UP)
  await waitFor(() => view().includes("↓ more below"), "scrolled up")
  const shown = view()
  expect(shown).not.toContain("line 60")
  // The wheel scrolls too.
  terminal.send(WHEEL_UP)
  await waitFor(() => view() !== shown, "wheel")
  const kept = view()
  terminal.send("more\r")
  await waitFor(() => view().includes("↓ new output"), "new output note")
  // What was read stays where it was.
  expect(view().split("↓")[0]).toBe(kept.split("↓")[0])
  terminal.send(END)
  await shows("second reply")
  expect(view()).not.toContain("↓ new output")
  terminal.send("\x03")
  await exited
})

const parallel = { description: "", parameters: {}, concurrency: "parallel" as const }

test("parallel tool calls keep their places in call order and finish in place", async () => {
  const { terminal, view, shows, idle, exited, agent } = await setup([
    {
      toolCalls: [
        { name: "slow", args: { path: "a.ts" } },
        { name: "fast", args: { path: "b.ts" } },
      ],
    },
    { text: "done" },
  ])
  let release!: () => void
  agent.tools.register(
    defineTool({
      name: "slow",
      ...parallel,
      execute: () =>
        new Promise((r) => {
          release = () => r(textResult("slow result"))
        }),
    }),
    "test",
  )
  agent.tools.register(
    defineTool({ name: "fast", ...parallel, execute: async () => textResult("fast result") }),
    "test",
  )
  terminal.send("go\r")
  // The fast one finished below the slow one, which still runs above it.
  await waitFor(() => /● slow a\.ts .*\n● fast b\.ts\n {2}└ fast result/.test(view()), "fast done in place")
  release()
  await shows("done")
  await idle()
  expect(view()).toMatch(/● slow a\.ts\n {2}└ slow result\n● fast b\.ts\n {2}└ fast result\n\n {2}done/)
  terminal.send("\x03")
  await exited
})

test("sub-agents stay under their call, also running in the background after the turn", async () => {
  let finish!: () => void
  const reply = (req: { messages: { role: string; content: unknown }[] }) => {
    const child = JSON.stringify(req.messages[0]?.content).includes('"scan"')
    const answered = req.messages.at(-1)?.role === "toolResult"
    if (child)
      return answered
        ? { text: "scanned" }
        : { toolCalls: [{ name: "scan", args: { path: "logs/app.log" } }] }
    return answered ? { text: "started it" } : { toolCalls: [{ name: "launch", args: {} }] }
  }
  const { terminal, view, shows, idle, exited, agent, bus } = await setup([reply, reply, reply, reply], {
    cols: 80,
    tree: true,
  })
  const gate = new Promise<void>((r) => {
    finish = r
  })
  agent.tools.register(
    defineTool({
      name: "scan",
      description: "",
      parameters: {},
      execute: async () => {
        await gate
        return textResult("log lines")
      },
    }),
    "test",
  )
  let child: ChildSession | undefined
  agent.tools.register(
    defineTool({
      name: "launch",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        child = ctx.session!.spawn!({ role: "explorer", title: "Scan the logs", prompt: "scan" })
        return textResult("Started in the background")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await shows("started it")
  await idle()
  // The turn is over; the sub-agent runs on right under its call, updated in place.
  await waitFor(
    () =>
      /● launch\n {2}├ ◆ Scan the logs · explorer · \d+s · 0 tok\n {2}│ └ ● scan logs\/app\.log\n {2}└ Started in the background/.test(
        view(),
      ),
    "rows under the call",
  )
  expect(view()).not.toContain("running in background")
  finish()
  await child!.result()
  await bus.flush()
  // It ends in place: its end line stays under the call.
  await waitFor(
    () =>
      /● launch\n {2}├ ◆ Scan the logs ✓ explorer [^\n]*scanned\n {2}└ Started in the background/.test(
        view(),
      ),
    "end line under the call",
  )
  terminal.send("\x03")
  await exited
})

test("blocks fold and unfold: a tool call's output, a reply's details; Ctrl+O applies to all calls", async () => {
  const details = "Intro\n\n<details>\n<summary>More</summary>\n\nhidden body\n</details>\n\nOutro"
  const { terminal, view, shows, idle, exited } = await setup([
    { toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
    { text: details },
  ])
  terminal.send("go\r")
  await shows("Outro")
  await idle()
  expect(view()).toContain("▾ More")
  expect(view()).toContain("hidden body")
  // Ctrl+↑ selects the newest block, the reply; Enter folds its details.
  terminal.send(CTRL_UP)
  await waitFor(() => view().includes("assistant block"), "selection bar")
  expect(view()).toContain("▌  Intro")
  terminal.send("\r")
  await waitFor(() => view().includes("▸ More"), "folded")
  expect(view()).not.toContain("hidden body")
  // Up to the tool call; Enter shows all of its output, Enter again only its result line.
  terminal.send(CTRL_UP)
  await waitFor(() => view().includes("tool block"), "the call selected")
  terminal.send("\r")
  await waitFor(() => view().includes("line 3"), "unfolded")
  expect(view()).toMatch(/▌ {4}line 2\n▌ {4}line 3/)
  terminal.send(" ")
  await waitFor(() => !view().includes("line 3"), "folded again")
  // Esc stops selecting; Ctrl+O then shows every call in full, folded ones keeping theirs.
  terminal.send(ESC)
  await waitFor(() => !view().includes("tool block"), "back to the input")
  terminal.send("\x0f")
  await shows("Tool output: full")
  expect(view()).not.toContain("line 3")
  terminal.send("\x03")
  await exited
})

test("Ctrl+F finds text in the transcript, highlights matches and moves between them", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => (i === 5 || i === 30 ? `needle ${i}` : `hay ${i}`))
  const { terminal, view, shows, idle, exited } = await setup([{ text: lines.join("\n\n") }])
  terminal.send("go\r")
  await shows("hay 39")
  await idle()
  terminal.send(CTRL_F)
  await shows("⌕ find ›")
  terminal.clearWrites()
  terminal.send("NEEDLE")
  // Capitals match exactly: nothing.
  await shows("no matches")
  terminal.send("\x7f".repeat(6))
  terminal.send("needle")
  await shows("2/2")
  expect(view()).toContain("needle 30")
  // The current match is marked (inverse and underlined), the other one inverse.
  expect(terminal.output).toContain("\x1b[7;4mneedle\x1b[27;24m")
  terminal.send("\r")
  await shows("1/2")
  expect(view()).toContain("needle 5")
  expect(view()).not.toContain("hay 39")
  terminal.send(SHIFT_ENTER)
  await shows("2/2")
  terminal.send(ESC)
  await waitFor(() => !view().includes("⌕ find"), "closed")
  // Typing goes to the input again.
  terminal.send("x")
  await shows("› x")
  terminal.send("\x03\x03")
  await exited
})

test("copying the last reply and a selected block goes through OSC 52", async () => {
  const { terminal, view, shows, idle, exited, screen } = await setup([{ text: "Use **bold** here." }])
  terminal.send("go\r")
  await shows("Use bold here.")
  await idle()
  terminal.send("\x1bc")
  await shows("Copied the last reply")
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")
  // The reply's Markdown, as the model wrote it.
  expect(terminal.output).toContain(`\x1b]52;c;${b64("Use **bold** here.")}\x07`)
  expect(screen.oscs).toContain(`52;c;${b64("Use **bold** here.")}`)
  terminal.send(CTRL_UP)
  terminal.send(CTRL_UP)
  await waitFor(() => view().includes("user block"), "the user message selected")
  terminal.send("y")
  await shows("Copied the user block")
  expect(terminal.output).toContain(`\x1b]52;c;${b64("go")}\x07`)
  terminal.send(ESC)
  terminal.send("\x03")
  await exited
})

test("a resize reflows the whole transcript to the new width", async () => {
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ")
  const { terminal, view, shows, idle, resize, screen, exited } = await setup([{ text: words }], { cols: 80 })
  terminal.send("go\r")
  await shows("word29")
  await idle()
  resize(40, 20)
  await waitFor(
    () => screen.lines.some((l) => l.trim().startsWith("word") && l.length <= 40 && l.includes("word29")),
    "reflowed",
  )
  const replyRows = view()
    .split("\n")
    .filter((l) => l.includes("word"))
  expect(replyRows.length).toBeGreaterThan(3)
  expect(replyRows.every((l) => l.length <= 40)).toBe(true)
  expect(replyRows.join(" ").replace(/\s+/g, " ").trim()).toBe(words)
  terminal.send("\x03")
  await exited
  // The printout on exit has the new width too.
  expect(screen.mainText.split("\n").every((l) => l.length <= 40)).toBe(true)
})

const webhookForm: FormSpec = {
  title: "Webhook",
  description: "Where to send build results",
  fields: [{ type: "text", id: "url", label: "URL" }],
}

test("dialogs answer in the bottom area; forms and the viewer take the screen without leaving it", async () => {
  const { host, terminal, view, shows, idle, screen, exited } = await setup(
    [{ toolCalls: [{ name: "ask", args: {} }] }, { text: "thanks" }, { text: "child answer" }],
    { commands: true },
  )
  await host.load((api) => {
    api.registerTool(
      defineTool({
        name: "ask",
        description: "",
        parameters: {},
        execute: async () => textResult(String(await api.ui.confirm("Proceed?", "It is safe"))),
      }),
    )
  }, "asker")
  terminal.send("go\r")
  await shows("? Proceed? (asker)")
  terminal.send("y")
  await shows("thanks")
  await idle()
  expect(view()).toContain("? Proceed? › yes")
  // A form draws over the transcript on the same alternate screen.
  const form = host.ui.api("x").form(webhookForm)
  await shows("Where to send build results")
  terminal.send("https://ci.example\x13")
  expect(await form).toEqual({ url: "https://ci.example" })
  await shows("? Proceed? › yes")
  // So does the sub-agent viewer.
  terminal.send("/agents view\r")
  await shows("No sub-agents")
  expect(screen.altSwitches).toEqual([true])
  terminal.send(ESC)
  terminal.send("\x03")
  await exited
})

test("a resumed session shows its history as blocks, and the printout keeps it", async () => {
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "earlier question" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Earlier **answer**." },
        { type: "toolCall", id: "t1", name: "read", args: { path: "old.ts" } },
      ],
      model: { provider: "mock", model: "m1" },
      stopReason: "toolUse",
    } as Message,
    {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "old contents" }],
      isError: false,
    } as Message,
  ]
  const { terminal, view, shows, screen, exited } = await setup([], { history })
  await shows("── resumed")
  expect(view()).toMatch(
    /› earlier question\n\n {2}Earlier answer\.\n\n● read old\.ts\n {2}└ old contents\n\n── resumed /,
  )
  terminal.send("\x03")
  await exited
  expect(screen.mainText).toMatch(
    /› earlier question\n\n {2}Earlier answer\.\n\n● read old\.ts\n {2}└ old contents\n\n── resumed /,
  )
})
