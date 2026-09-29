import { expect, test } from "bun:test"
import { deflateSync } from "node:zlib"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import {
  type ChildSession,
  type CommandDefinition,
  defineTool,
  type FormSpec,
  type Message,
  type SessionControl,
  type SpawnGroup,
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
import { FakeTerminal, type GraphicsReplies, type RemoteImageFetch } from "@amira/tui-kit"
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
  /** What the terminal says about graphics when asked (only when images are not off). */
  graphics?: GraphicsReplies
  env?: Record<string, string>
  /** How images in replies are fetched from the web. */
  imageFetch?: RemoteImageFetch
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
    setup: async (_t, _env, setupOpts) => ({
      capabilities: {
        win32InputMode: false,
        kittyKeyboard: true,
        synchronizedOutput: false,
        shiftEnter: true,
        ...(setupOpts?.images && o.graphics ? { graphics: o.graphics } : {}),
      },
      leftoverInput: "",
    }),
    ...(o.imageFetch ? { imageFetch: o.imageFetch } : {}),
    onReady: () => agent.start("startup"),
    files: { files: async () => [] },
    env: o.env ?? {},
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
  return { agent, bus, host, tree, terminal, screen, view, shows, idle, resize, exited }
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
    "",
    "› what is in a.ts?",
    "",
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

test("a compact spawn group is one line under its call, with its owner's status, also once it ended", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const reply = (req: { messages: { role: string; content: unknown }[] }) => {
    const task = JSON.stringify(req.messages[0]?.content)
    const answered = req.messages.at(-1)?.role === "toolResult"
    if (task.includes("step"))
      return answered ? { text: "step done" } : { toolCalls: [{ name: "hold", args: {} }] }
    return answered ? { text: "running it" } : { toolCalls: [{ name: "flow", args: {} }] }
  }
  const { terminal, view, shows, idle, exited, agent, bus } = await setup(Array(8).fill(reply), {
    cols: 80,
    tree: true,
  })
  agent.tools.register(
    defineTool({
      name: "hold",
      ...parallel,
      execute: async () => {
        await gate
        return textResult("held")
      },
    }),
    "test",
  )
  let group: SpawnGroup | undefined
  agent.tools.register(
    defineTool({
      name: "flow",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        group = ctx.session!.createGroup!({ name: "workflow demo", compact: true })
        group.setStatus("Explore · 0/3 agents")
        const kids = ["Scan api", "Scan core", "Scan tui"].map((title) =>
          group!.spawn({ role: "explorer", title, prompt: `step ${title}` }),
        )
        void Promise.all(kids.map((k) => k.result())).then(() => group!.end())
        return textResult("Started in the background")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await shows("running it")
  await idle()
  await waitFor(
    () =>
      /● flow\n {2}├ ◆ workflow demo · Explore · 0\/3 agents\n {2}└ Started in the background/.test(view()),
    "one line for the group under its call",
  )
  expect(view()).not.toContain("Scan api")
  group!.setStatus("Verify · 2/3 agents")
  await shows("◆ workflow demo · Verify · 2/3 agents")
  release()
  await group!.ended()
  await bus.flush()
  // Its members never get rows of their own; the group's line stays with its last status.
  await waitFor(() => !/Scan (api|core|tui)/.test(view()) && view().includes("workflow demo"), "ended")
  terminal.send("\x03")
  await exited
})

test("the members of a group a command started share one block: a compact group is one line", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const reply = (req: { messages: { role: string; content: unknown }[] }) =>
    req.messages.at(-1)?.role === "toolResult"
      ? { text: "step done" }
      : { toolCalls: [{ name: "hold", args: {} }] }
  const { view, shows, exited, terminal, agent, tree, bus } = await setup(Array(6).fill(reply), {
    cols: 80,
    tree: true,
  })
  agent.tools.register(
    defineTool({
      name: "hold",
      ...parallel,
      execute: async () => {
        await gate
        return textResult("held")
      },
    }),
    "test",
  )
  // As /workflow <name> does: a group of the main session, with no tool call behind it.
  const group = tree!.createGroup(agent, { name: "workflow demo", compact: true })
  group.setStatus("Answer · 0/3 agents")
  const kids = ["Scan api", "Scan core", "Scan tui"].map((title) =>
    group.spawn({ role: "explorer", title, prompt: `step ${title}` }),
  )
  await shows("◆ workflow demo · Answer · 0/3 agents")
  await bus.flush()
  await Bun.sleep(50)
  expect(view().match(/◆ background/g)).toHaveLength(1)
  expect(view().match(/workflow demo/g)).toHaveLength(1)
  expect(view()).not.toContain("Scan api")
  release()
  await Promise.all(kids.map((k) => k.result()))
  group.end()
  await group.ended()
  terminal.send("\x03")
  await exited
})

test("blocks fold and unfold: a tool call's output, a reply's details; Ctrl+O applies to all calls", async () => {
  const details = "Intro\n\n<details>\n<summary>More</summary>\n\nhidden body\n</details>\n\nOutro"
  const { terminal, screen, view, shows, idle, exited } = await setup([
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
  // What was folded by hand prints as the inline transcript shows it: nothing is lost.
  expect(screen.mainText).toContain("hidden body")
  expect(screen.mainText).toContain("    line 3")
  expect(screen.mainText).not.toContain("▌")
})

/** An SGR mouse press at a zero-based screen row. */
const click = (row: number, button = 0) => `\x1b[<${button};3;${row + 1}M\x1b[<${button};3;${row + 1}m`

test("keys a block selection does not use reach the input: Ctrl+C interrupts, typing and pasting type", async () => {
  let release!: () => void
  const { terminal, agent, view, shows, idle, exited } = await setup([
    { toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
    { toolCalls: [{ name: "hold", args: {} }] },
    { text: "never" },
  ])
  agent.tools.register(
    defineTool({
      name: "hold",
      description: "",
      parameters: {},
      execute: (_p, ctx) =>
        new Promise((r) => {
          release = () => r(textResult("held"))
          ctx.signal.addEventListener("abort", () => r(textResult("stopped")))
        }),
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => agent.status !== "idle" && view().includes("● hold"), "the turn running")
  terminal.send(CTRL_UP)
  await waitFor(() => view().includes("tool block"), "selected")
  // Ctrl+C stops the running turn with a block selected.
  terminal.send("\x03")
  await idle()
  expect(view()).not.toContain("never")
  release()
  // Typing leaves the selection and types, first character included.
  terminal.send(CTRL_UP)
  await waitFor(() => view().includes("block "), "selected again")
  terminal.send("hello")
  await shows("› hello")
  expect(view()).not.toMatch(/\w+ block \d+ of/)
  // A paste too.
  terminal.send("\x03")
  terminal.send(CTRL_UP)
  await waitFor(() => /\w+ block \d+ of/.test(view()), "selected once more")
  terminal.send("\x1b[200~pasted text\x1b[201~")
  await shows("› pasted text")
  // Ctrl+C with a selection and an empty input quits.
  terminal.send("\x03")
  terminal.send(CTRL_UP)
  await waitFor(() => /\w+ block \d+ of/.test(view()), "selected before quitting")
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("a click with a draft in the input leaves Enter to it; right-click says how to paste", async () => {
  const { terminal, agent, screen, view, shows, idle, exited } = await setup(
    [
      { toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
      { text: "first answer" },
      { text: "second answer" },
    ],
    { cols: 100 },
  )
  terminal.send("go\r")
  await shows("first answer")
  await idle()
  const row = screen.lines.findIndex((l) => l.includes("● read a.ts"))
  expect(row).toBeGreaterThanOrEqual(0)
  terminal.send("next question")
  await shows("› next question")
  terminal.send(click(row))
  terminal.send("\r")
  await shows("second answer")
  await idle()
  expect(view()).not.toMatch(/\w+ block \d+ of/)
  expect(agent.messages.filter((m) => m.role === "user")).toHaveLength(2)
  // With the input empty a click selects the block under it.
  const again = screen.lines.findIndex((l) => l.includes("● read a.ts"))
  terminal.send(click(again))
  await waitFor(() => view().includes("tool block"), "selected by a click")
  terminal.send(ESC)
  await waitFor(() => !view().includes("tool block"), "unselected")
  terminal.send(click(again, 2))
  await shows("Shift+right-click (or Ctrl+V) pastes")
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
  // A click on the transcript does not select a block while the dialog has the keyboard.
  terminal.send(click(screen.lines.findIndex((l) => l.startsWith("› go"))))
  await Bun.sleep(30)
  expect(view()).not.toMatch(/block \d+ of/)
  terminal.send("y")
  await shows("thanks")
  await idle()
  expect(view()).toContain("? Proceed? › Yes")
  // A form draws over the transcript on the same alternate screen.
  const form = host.ui.api("x").form(webhookForm)
  await shows("Where to send build results")
  terminal.send("https://ci.example\x13")
  expect(await form).toEqual({ url: "https://ci.example" })
  await shows("? Proceed? › Yes")
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
    /› earlier question\n\n\n {2}Earlier answer\.\n\n● read old\.ts\n {2}└ old contents\n\n── resumed /,
  )
  terminal.send("\x03")
  await exited
  expect(screen.mainText).toMatch(
    /› earlier question\n\n\n {2}Earlier answer\.\n\n● read old\.ts\n {2}└ old contents\n\n── resumed /,
  )
})

// --- images (D83)

/** A PNG of `width`×`height` pixels of one color. */
function png(width: number, height: number): Uint8Array {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set([40, 120, 200, 255], y * (width * 4 + 1) + 1 + x * 4)
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(Bun.hash.crc32(body) >>> 0, body.length + 4)
    return out
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(width, 0)
  head.writeUInt32BE(height, 4)
  head.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ])
}

/** 40×120 pixels: 4 columns and 6 rows of the 10×20 cells Windows Terminal draws Sixel in. */
const TALL = png(40, 120)
const SIXEL: GraphicsReplies = { answered: true, sixel: true, kitty: false }
const KITTY: GraphicsReplies = { answered: true, sixel: false, kitty: true, cell: { width: 10, height: 20 } }
const WT = { WT_SESSION: "1" }
const imageFetch: RemoteImageFetch = async () => ({ bytes: TALL, contentType: "image/png" })
const SHIFT_UP = "\x1b[1;2A"
const SHIFT_DOWN = "\x1b[1;2B"

/** A reply with the image between "top" and "bottom", and `after` lines under it. */
const imageReply = (after = 0) =>
  [
    "top",
    "",
    "![chart](https://img.test/chart.png)",
    "",
    "bottom",
    "",
    ...Array.from({ length: after }, (_, i) => `line ${i + 1}`),
  ].join("\n")

/** Rows of the screen with image cells. */
const imageRows = (screen: VirtualScreen) => screen.lines.flatMap((l, i) => (l.includes("▓") ? [i] : []))

/**
 * Where the image's cells must be, from where its neighbors "top" and "bottom" are: its six
 * rows between them, cut to the transcript (which ends a row above the input box).
 */
function expectedImageRows(screen: VirtualScreen): number[] {
  const lines = screen.lines
  const top = lines.indexOf("  top")
  const bottom = lines.indexOf("  bottom")
  const paneEnd = lines.findIndex((l) => l.startsWith("╭")) - 1
  let start: number
  let end: number
  if (top >= 0) {
    start = top + 2
    end = Math.min(top + 7, paneEnd - 1)
  } else if (bottom >= 0) {
    start = Math.max(0, bottom - 7)
    end = bottom - 2
  } else return []
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i)
}

test("an image in a reply is drawn in its rows of the transcript, once; exiting prints its alt text", async () => {
  const { terminal, screen, view, shows, idle, exited } = await setup([{ text: imageReply() }], {
    env: WT,
    graphics: SIXEL,
    imageFetch,
  })
  terminal.send("go\r")
  await shows("bottom")
  await idle()
  await waitFor(() => screen.images.length > 0, "the image")
  await Bun.sleep(40)
  const top = screen.lines.indexOf("  top")
  expect(screen.images).toEqual([
    expect.objectContaining({ protocol: "sixel", screenRow: top + 2, col: 2, rows: 6, cols: 4 }),
  ])
  expect(screen.lines.slice(top, top + 10)).toEqual(["  top", "", ...Array(6).fill("  ▓▓▓▓"), "", "  bottom"])
  expect(view()).not.toContain("🖼️")
  // Typing changes the input box only: the image is not drawn again.
  terminal.send("abc")
  await shows("abc")
  await Bun.sleep(40)
  expect(screen.images.length).toBe(1)
  terminal.send("\x03")
  terminal.send("\x03")
  expect(await exited).toBe(0)
  expect(screen.mainText).toContain("  top\n\n  🖼️ chart\n\n  bottom")
  expect(screen.mainText).not.toContain("▓")
})

test("scrolling moves the image row by row: cropped at either edge, cleared once off screen", async () => {
  const { terminal, screen, shows, idle, exited } = await setup([{ text: imageReply(30) }], {
    env: WT,
    graphics: SIXEL,
    imageFetch,
  })
  terminal.send("go\r")
  await shows("line 30")
  await idle()
  // Following the end: the image is far above, nothing drawn.
  expect(imageRows(screen)).toEqual([])
  const seen = new Set<string>()
  for (let step = 0; step < 45; step++) {
    terminal.send(SHIFT_UP)
    await Bun.sleep(25)
    const rows = imageRows(screen)
    expect(rows).toEqual(expectedImageRows(screen))
    seen.add(rows.length === 0 ? "off" : rows.length < 6 ? "cropped" : "whole")
    if (screen.lines[0] === "Amira · mock/m1 · /work/proj") break
  }
  // Down again, past it: every row it covered is erased.
  for (let step = 0; step < 45 && screen.lines.indexOf("  line 30") === -1; step++) {
    terminal.send(SHIFT_DOWN)
    await Bun.sleep(25)
    expect(imageRows(screen)).toEqual(expectedImageRows(screen))
  }
  expect(imageRows(screen)).toEqual([])
  expect([...seen].sort()).toEqual(["cropped", "off", "whole"])
  terminal.send("\x03")
  await exited
})

test("kitty: the image is sent once, placed as it scrolls, removed off screen and freed on exit", async () => {
  const { terminal, screen, shows, idle, exited } = await setup([{ text: imageReply(12) }], {
    env: { TERM: "xterm-kitty" },
    graphics: KITTY,
    imageFetch,
  })
  terminal.send("go\r")
  await shows("line 12")
  await idle()
  const placed = () => [...screen.kittyPlacements.values()]
  // Following the end, the image is above the view.
  expect(placed()).toEqual([])
  terminal.send(PAGE_UP)
  await waitFor(() => placed().length > 0, "the placement")
  const { id, pid } = placed()[0]!
  expect(placed()[0]!.row).toBe(screen.lines.indexOf("  top") + 2)
  // A row at a time: the same placement, moved (or cropped by the terminal).
  terminal.send(SHIFT_DOWN)
  await Bun.sleep(30)
  expect(placed()).toEqual([expect.objectContaining({ id, pid })])
  // Following the end again: out of view, its placement goes; the pixels stay.
  terminal.send(END)
  await waitFor(() => placed().length === 0, "removed")
  expect(screen.kittyLog).toContain(`d:i i=${id} p=${pid}`)
  terminal.send(PAGE_UP)
  await waitFor(() => placed().length > 0, "placed again")
  expect(screen.kittyLog.filter((l) => l.startsWith("t "))).toEqual([`t i=${id}`])
  terminal.send("\x03")
  await exited
  expect(screen.kittyLog.at(-1)).toBe(`d:I i=${id}`)
  expect(screen.kittyImages.size).toBe(0)
})

test("a form over the transcript hides the image; closing it draws the image again", async () => {
  const { host, terminal, screen, shows, idle, exited } = await setup([{ text: imageReply() }], {
    env: WT,
    graphics: SIXEL,
    imageFetch,
  })
  terminal.send("go\r")
  await shows("bottom")
  await idle()
  await waitFor(() => imageRows(screen).length === 6, "the image")
  const form = host.ui.api("x").form(webhookForm)
  await shows("Where to send build results")
  expect(imageRows(screen)).toEqual([])
  terminal.send(ESC)
  await form
  await waitFor(() => imageRows(screen).length === 6, "the image again")
  expect(imageRows(screen)).toEqual(expectedImageRows(screen))
  expect(screen.images.length).toBe(2)
  terminal.send("\x03")
  await exited
})

test("a resize fits the image again: fewer rows on a lower screen", async () => {
  const { terminal, screen, shows, idle, resize, exited } = await setup([{ text: imageReply() }], {
    env: WT,
    graphics: SIXEL,
    imageFetch,
    rows: 24,
  })
  terminal.send("go\r")
  await shows("bottom")
  await idle()
  await waitFor(() => imageRows(screen).length === 6, "the image")
  // 40% of 12 rows is 4.
  resize(60, 12)
  await waitFor(() => screen.images.at(-1)!.rows === 4, "the image at 4 rows")
  await Bun.sleep(30)
  expect(screen.images.at(-1)).toMatchObject({ rows: 4, cols: 3 })
  expect(imageRows(screen)).toHaveLength(4)
  expect(imageRows(screen)).toEqual(expectedImageRows(screen).slice(0, 4))
  // Back to the first size: the size drawn before is still there, drawn again at once.
  const drawn = screen.images.length
  resize(60, 24)
  await waitFor(() => screen.images.length > drawn, "the image at 6 rows")
  expect(screen.images.at(-1)).toMatchObject({ rows: 6, cols: 4 })
  terminal.send("\x03")
  await exited
})

test("a folded reply shows its image as alt text; tui.images off shows alt text only", async () => {
  const { terminal, screen, view, shows, idle, exited } = await setup([{ text: imageReply() }], {
    env: WT,
    graphics: SIXEL,
    imageFetch,
  })
  terminal.send("go\r")
  await shows("bottom")
  await idle()
  await waitFor(() => imageRows(screen).length === 6, "the image")
  terminal.send(CTRL_UP)
  await waitFor(() => /assistant block/.test(view()), "selected")
  // Selected, the block is drawn a column further right: so is the image.
  await waitFor(() => screen.lines.some((l) => l.startsWith("▌  ▓▓▓▓")), "the image moved")
  terminal.send("\r")
  await shows("🖼️ chart")
  expect(imageRows(screen)).toEqual([])
  terminal.send("\r")
  await waitFor(() => imageRows(screen).length === 6, "unfolded")
  terminal.send("\x03")
  await exited

  const off = await setup([{ text: imageReply() }], {
    env: WT,
    graphics: SIXEL,
    imageFetch,
    settings: { images: "off" },
  })
  off.terminal.send("go\r")
  await off.shows("bottom")
  await off.idle()
  expect(off.view()).toContain("  top\n\n  🖼️ chart\n\n  bottom")
  expect(off.screen.images).toEqual([])
  off.terminal.send("\x03")
  await off.exited
})

test("iTerm2 draws images whole: partly in view, the image is its alt text, to scroll to", async () => {
  const { terminal, screen, view, shows, idle, exited } = await setup([{ text: imageReply(30) }], {
    env: { TERM_PROGRAM: "WezTerm" },
    graphics: { answered: true, sixel: false, kitty: false, cell: { width: 10, height: 20 } },
    imageFetch,
  })
  terminal.send("go\r")
  await shows("line 30")
  await idle()
  let partial = false
  for (let step = 0; step < 45 && !screen.lines.includes("  top"); step++) {
    terminal.send(SHIFT_UP)
    await Bun.sleep(25)
    const bottom = screen.lines.indexOf("  bottom")
    if (bottom >= 2 && bottom < 7) {
      partial = true
      expect(imageRows(screen)).toEqual([])
      expect(view()).toContain("🖼️ chart (scroll to view)")
    }
  }
  expect(partial).toBe(true)
  await waitFor(() => imageRows(screen).length === 6, "whole")
  expect(screen.images.at(-1)).toMatchObject({ protocol: "iterm2", rows: 6 })
  expect(view()).not.toContain("scroll to view")
  terminal.send("\x03")
  await exited
})
