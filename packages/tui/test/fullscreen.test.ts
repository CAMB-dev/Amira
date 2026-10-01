import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import {
  type ChildSession,
  type CommandDefinition,
  defineTool,
  type FormSpec,
  type ImageProvider,
  type MarkdownRendererDefinition,
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
import { FakeTerminal, type GraphicsReplies } from "@amira/tui-kit"
import { agentsCommand } from "../../../extensions/agent/src/index.ts"
import { builtinPresenters } from "../../../extensions/builtin-tools/src/index.ts"
import statusExtension from "../../../extensions/status/src/index.ts"
import { fakePayload } from "../../tui-kit/test/fake-images.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"
import { fileList } from "../src/file-index.ts"

async function waitFor(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

const ESC = "\x1b[27u"
/** The bar of a block selection: what is selected, and where it is among the blocks. */
const SELECT_BAR = /(?:message|reply|tool call|notice|command|banner) \d+ of \d+/
const CTRL_UP = "\x1b[1;5A"
const RIGHT = "\x1b[C"
const DOWN = "\x1b[B"
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
  /** Runs on the agent once the history is in, before the UI starts (e.g. a compaction). */
  prepare?: (agent: Agent) => Promise<unknown>
  settings?: TuiSettings
  /** /agents and a /quit, with the session control the viewer reads. */
  commands?: boolean
  /** What the terminal says about graphics when asked (only when images are not off). */
  graphics?: GraphicsReplies
  env?: Record<string, string>
  /** An image provider, as the images extension registers one (D88). */
  images?: ImageProvider
  /** Markdown renderers extensions register (D88). */
  markdown?: MarkdownRendererDefinition[]
  /** The built-in tools' presenters. */
  presenters?: boolean
}

/** The UI in full-screen mode on a fake terminal, as the CLI starts it by default. */
async function setup(steps: MockStep[], o: Options = {}) {
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  await host.load(statusExtension, "builtin:status")
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 128_000 } }],
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
  if (o.images || o.markdown) {
    await host.load((api) => {
      if (o.images) api.registerImageProvider(o.images)
      for (const r of o.markdown ?? []) api.registerMarkdownRenderer(r)
    }, "test-render")
  }
  if (o.presenters) {
    for (const [name, p] of Object.entries(builtinPresenters)) host.renderers.register(name, p)
  }
  if (o.history) agent.messages.push(...o.history)
  await o.prepare?.(agent)
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
    imageProviders: host.images,
    markdownRenderers: host.markdown,
    ...(o.presenters ? { toolRenderers: host.renderers } : {}),
    onReady: () => agent.start("startup"),
    files: fileList([]),
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
  return { agent, ai, bus, host, commands, tree, terminal, screen, view, shows, idle, resize, exited }
}

test("reads in a row become one Explored row, which unfolds to the calls", async () => {
  const { terminal, view, shows, idle, exited } = await setup(
    [
      {
        toolCalls: [
          { name: "read", args: { path: "a.ts" } },
          { name: "read", args: { path: "b.ts" } },
        ],
      },
      { text: "Both read." },
    ],
    { presenters: true },
  )
  terminal.send("go\r")
  await shows("Both read.")
  await idle()
  expect(view()).toContain("● Explored · Read a.ts, b.ts\n\n  Both read.")
  expect(view()).not.toContain("● read a.ts")
  // Selected, Enter shows each call under it.
  terminal.send(CTRL_UP)
  terminal.send(CTRL_UP)
  await waitFor(() => /tool call \d+ of|Explored \d+ of/.test(view()), "the row selected")
  terminal.send("\r")
  await waitFor(() => view().includes("● read a.ts"), "unfolded")
  expect(view()).toContain("● read b.ts")
  terminal.send(ESC)
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("thinking shows folded as how long it took, and unfolds to the text", async () => {
  const { terminal, view, shows, idle, screen, exited } = await setup([
    { thinking: "Maybe the answer is 42.", text: "It is 42." },
  ])
  terminal.send("go\r")
  await shows("It is 42.")
  await idle()
  expect(view()).toContain("∴ Thought for 1s\n\n  It is 42.")
  expect(view()).not.toContain("Maybe the answer")
  terminal.send(CTRL_UP)
  terminal.send(CTRL_UP)
  await waitFor(() => /thinking \d+ of/.test(view()), "the thinking selected")
  terminal.send("\r")
  await waitFor(() => view().includes("Maybe the answer is 42."), "unfolded")
  terminal.send(ESC)
  terminal.send("\x03")
  expect(await exited).toBe(0)
  // Exiting prints it as the inline view shows it: folded.
  expect(screen.mainText).toContain("∴ Thought for 1s")
  expect(screen.mainText).not.toContain("Maybe the answer")
})

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
    "@ files · ? keys",
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
  // The normal screen holds the conversation as the inline UI would have left it, no input box,
  // a blank line before it (under the command that started Amira) and after it (above the prompt).
  expect(screen.mainText).toBe(`\n${conversation}`)
  expect(screen.lines[screen.y]).toBe("")
  expect(screen.lines[screen.y - 1]).toBe("")
  expect(screen.lines[screen.y - 2]).toBe("  The file has three lines.")
  expect(screen.altSwitches).toEqual([true, false])
})

test("a streaming reply follows the end; scrolling up keeps its place and says there is new output", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n\n")
  // The reply stops after "line 30" until released, so a frame is sure to show it mid-stream:
  // streaming freely, one slow frame (a loaded machine) can skip past any given line.
  let release!: () => void
  const until = new Promise<void>((r) => {
    release = r
  })
  const chunks = Math.ceil((long.indexOf("line 30") + "line 30".length) / 8)
  const { terminal, view, shows, idle, exited } = await setup([
    { text: long, hold: { chunks, until } },
    { text: "second reply" },
  ])
  terminal.send("go\r")
  // Following: the newest rows are in view while it streams.
  await shows("line 30")
  expect(view()).not.toContain("line 1\n")
  release()
  await shows("line 60")
  await idle()
  expect(view()).not.toContain("line 1\n")
  terminal.send(PAGE_UP)
  await waitFor(() => /↓ \d+ rows? below/.test(view()), "scrolled up")
  const shown = view()
  expect(shown).not.toContain("line 60")
  // The wheel scrolls too.
  terminal.send(WHEEL_UP)
  await waitFor(() => view() !== shown, "wheel")
  const kept = view()
  terminal.send("more\r")
  await waitFor(() => view().includes("↓ new output"), "new output note")
  // What was read stays where it was, once the turn is over (while it runs, the bottom area
  // can take a row more and the transcript a row less).
  await idle()
  await waitFor(() => view().split("↓")[0] === kept.split("↓")[0], "the rows read, in place")
  expect(view()).toContain("↓ new output")
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
  // The activity line stays while tools run: its spinner, the tool still running and the time.
  await waitFor(() => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1 tool running · \d+s( · ↓ \d+ tokens)?$/m.test(view()), "activity")
  expect(view()).toContain("Esc interrupt")
  expect(view()).toMatch(/● slow a\.ts +[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d+s/)
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
  // No turn runs: the sub-agent working on brings no activity line.
  expect(view()).not.toContain("Esc interrupt")
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
  expect(view().match(/◆ in the background/g)).toHaveLength(1)
  expect(view().match(/workflow demo/g)).toHaveLength(1)
  expect(view()).not.toContain("Scan api")
  // Selected, it is named as its head says, not as a tool call.
  terminal.send(CTRL_UP)
  await waitFor(() => /[›❯] background sub-agents \d+ of \d+/.test(view()), "the group selected")
  terminal.send(ESC)
  await waitFor(() => !/sub-agents \d+ of/.test(view()), "done selecting")
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
  await waitFor(() => /reply \d+ of \d+/.test(view()), "selection bar")
  // The mark takes the blank first column: the text stays where it was.
  expect(view()).toContain("▌ Intro")
  terminal.send("\r")
  await waitFor(() => view().includes("▸ More"), "folded")
  expect(view()).not.toContain("hidden body")
  // Up to the tool call; Enter shows all of its output, Enter again only its result line.
  terminal.send(CTRL_UP)
  await waitFor(() => view().includes("tool call"), "the call selected")
  terminal.send("\r")
  await waitFor(() => view().includes("line 3"), "unfolded")
  expect(view()).toMatch(/▌ {3}line 2\n▌ {3}line 3/)
  terminal.send(" ")
  await waitFor(() => !view().includes("line 3"), "folded again")
  // Esc stops selecting; Ctrl+O then shows every call in full, folded ones keeping theirs.
  terminal.send(ESC)
  await waitFor(() => !view().includes("tool call"), "back to the input")
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
  await waitFor(() => view().includes("tool call"), "selected")
  // Ctrl+C stops the running turn with a block selected.
  terminal.send("\x03")
  await idle()
  expect(view()).not.toContain("never")
  release()
  // Typing leaves the selection and types, first character included.
  terminal.send(CTRL_UP)
  await waitFor(() => SELECT_BAR.test(view()), "selected again")
  terminal.send("hello")
  await shows("› hello")
  expect(view()).not.toMatch(SELECT_BAR)
  // A paste too.
  terminal.send("\x03")
  terminal.send(CTRL_UP)
  await waitFor(() => SELECT_BAR.test(view()), "selected once more")
  terminal.send("\x1b[200~pasted text\x1b[201~")
  await shows("› pasted text")
  // Ctrl+C with a selection and an empty input quits.
  terminal.send("\x03")
  terminal.send(CTRL_UP)
  await waitFor(() => SELECT_BAR.test(view()), "selected before quitting")
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("a click selects no block: a draft keeps Enter, typing types; right-click says how to paste", async () => {
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
  expect(view()).not.toMatch(SELECT_BAR)
  expect(agent.messages.filter((m) => m.role === "user")).toHaveLength(2)
  // With the input empty a click selects no block either (that is Ctrl+↑): typing still types.
  const again = screen.lines.findIndex((l) => l.includes("● read a.ts"))
  terminal.send(click(again))
  terminal.send(click(again - 1))
  terminal.send("x")
  await shows("› x")
  expect(view()).not.toMatch(SELECT_BAR)
  terminal.send(click(again, 2))
  await shows("Shift+right-click (or Ctrl+V) pastes")
  terminal.send("\x03\x03")
  await exited
})

/** SGR mouse reports of the left button at zero-based cells. */
const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`
const drag = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`
const release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`

/** The text of the newest OSC 52 in the output, if any. */
function clipboard(output: string): string | undefined {
  const at = output.lastIndexOf("\x1b]52;c;")
  if (at === -1) return undefined
  const end = output.indexOf("\x07", at)
  return Buffer.from(output.slice(at + 7, end), "base64").toString("utf8")
}

/** The screen row showing `text` and the column it starts at. */
function cellOf(screen: VirtualScreen, text: string): { x: number; y: number } {
  const y = screen.lines.findIndex((l) => l.includes(text))
  if (y === -1) throw new Error(`${JSON.stringify(text)} is not on the screen`)
  return { x: Bun.stringWidth(screen.lines[y]!.slice(0, screen.lines[y]!.indexOf(text))), y }
}

test("dragging selects text across blocks, marks it, and copies it without the chrome on release", async () => {
  const { terminal, screen, view, shows, idle, exited } = await setup([
    { toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
    { text: "The file has **three** lines:\n\n```\nfirst\n  second\n```" },
  ])
  terminal.send("what is in a.ts?\r")
  await shows("second")
  await idle()
  const from = cellOf(screen, "is in a.ts?")
  const to = cellOf(screen, "second")
  terminal.clearWrites()
  terminal.send(press(from.x, from.y))
  // Moves with the button held are reported while it is down.
  await waitFor(() => terminal.output.includes("\x1b[?1002h"), "button-event tracking")
  terminal.send(drag(from.x + 3, from.y))
  terminal.send(drag(to.x + 5, to.y))
  await waitFor(() => terminal.output.includes("\x1b[7m"), "the selection marked")
  expect(clipboard(terminal.output)).toBeUndefined()
  terminal.send(release(to.x + 5, to.y))
  const copied = [
    "is in a.ts?",
    "",
    "read a.ts",
    "contents of a.ts (+2 lines)",
    "",
    "The file has three lines:",
    "",
    "first",
    "  second",
  ].join("\n")
  await shows(`Copied ${copied.length} characters`)
  // Leaving it asks for plain mouse reporting again (xterm keeps the two as one setting).
  expect(terminal.output).toContain("\x1b[?1002l\x1b[?1000h")
  expect(clipboard(terminal.output)).toBe(copied)
  // It stays marked; typing still goes to the input.
  terminal.send("x")
  await shows("› x")
  // A click clears it and does nothing else: no block is selected, nothing is copied.
  terminal.clearWrites()
  terminal.send(press(2, 1) + release(2, 1))
  await waitFor(() => terminal.output.includes("three"), "the rows drawn again, unmarked")
  expect(terminal.output).not.toContain("\x1b[7m")
  expect(clipboard(terminal.output)).toBeUndefined()
  expect(view()).not.toMatch(SELECT_BAR)
  terminal.send("\x03\x03")
  await exited
})

test("a double click selects a word, a triple click a line, each copied on release", async () => {
  const { terminal, screen, shows, idle, exited } = await setup([
    { text: "See src/app.ts for the 漢字 part.\n\nNext line." },
  ])
  terminal.send("go\r")
  await shows("Next line.")
  await idle()
  const at = cellOf(screen, "app.ts")
  const click2 = press(at.x, at.y) + release(at.x, at.y)
  terminal.send(click2 + click2)
  await waitFor(() => clipboard(terminal.output) === "src/app.ts", "the word copied")
  await shows("Copied 10 characters")
  // A column off still counts: its second cell.
  const kanji = cellOf(screen, "漢字")
  const onKanji = (dx: number) => press(kanji.x + dx, kanji.y) + release(kanji.x + dx, kanji.y)
  terminal.send(onKanji(0) + onKanji(1))
  await waitFor(() => clipboard(terminal.output) === "漢字", "a CJK word copied")
  // Three clicks in one go (waiting between them could take longer than a triple click may).
  const next = cellOf(screen, "Next")
  const onNext = press(next.x, next.y) + release(next.x, next.y)
  terminal.send(onNext + onNext + onNext)
  await waitFor(() => clipboard(terminal.output) === "Next line.", "the line copied")
  terminal.send("\x03")
  await exited
})

test("a drag held under the transcript scrolls it down, one held on its top row scrolls it up", async () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n\n")
  const { terminal, screen, shows, idle, exited } = await setup([{ text: long }])
  terminal.send("go\r")
  await shows("line 40")
  await idle()
  // Up from the end of "line 38" to the top of the conversation.
  const start = cellOf(screen, "line 38")
  const end = start.x + "line 38".length - 1
  terminal.send(press(end, start.y))
  terminal.send(drag(0, 0))
  // Scrolling takes a while: longer than a wait for a frame.
  await waitFor(() => screen.lines[0] === "Amira · mock/m1 · /work/proj", "the top", 12_000)
  terminal.send(release(0, 0))
  await waitFor(() => clipboard(terminal.output) !== undefined, "copied")
  const up = clipboard(terminal.output)!
  expect(up.startsWith("Amira · mock/m1 · /work/proj\n@ files · ? keys\n\ngo\n\nline 1\n\nline 2\n")).toBe(
    true,
  )
  expect(up.endsWith("line 37\n\nline 38")).toBe(true)
  // Down from "line 2" past the bottom of the transcript to its end.
  const top = cellOf(screen, "line 2")
  const below = screen.lines.findIndex((l) => l.startsWith("╭"))
  terminal.clearWrites()
  terminal.send(press(top.x, top.y))
  terminal.send(drag(top.x, below))
  await waitFor(() => screen.lines.some((l) => l.includes("line 40")), "the end", 12_000)
  terminal.send(release(top.x, below))
  await waitFor(() => clipboard(terminal.output) !== undefined, "copied")
  const down = clipboard(terminal.output)!
  expect(down.startsWith("line 2\n\nline 3\n")).toBe(true)
  expect(down.endsWith("line 39\n\nline 40")).toBe(true)
  terminal.send("\x03")
  await exited
}, 30_000)

test("selected text stays while the reply streams on; Esc clears it before anything else", async () => {
  const head = "alpha one\n\nbeta two!!!\n\n"
  let release_!: () => void
  const until = new Promise<void>((r) => {
    release_ = r
  })
  const { terminal, screen, view, shows, idle, exited } = await setup([
    { text: `${head}gamma three`, hold: { chunks: head.length / 8, until } },
  ])
  terminal.send("go\r")
  await shows("beta two!!!")
  const at = cellOf(screen, "alpha one")
  const select = async () => {
    terminal.clearWrites()
    terminal.send(press(at.x, at.y) + drag(at.x + 8, at.y) + release(at.x + 8, at.y))
    await waitFor(() => clipboard(terminal.output) === "alpha one", "alpha one copied")
    await waitFor(() => terminal.output.includes("\x1b[7malpha one"), "alpha one marked")
  }
  await select()
  // Esc while the turn runs clears the selection; it does not stop the turn.
  terminal.clearWrites()
  terminal.send(ESC)
  await waitFor(() => terminal.output.includes("alpha one"), "the row drawn again, unmarked")
  expect(terminal.output).not.toContain("\x1b[7m")
  await select()
  release_()
  await shows("gamma three")
  await idle()
  expect(view()).not.toContain("interrupted")
  // Still selected after the reply went on: Esc clears it before closing the find bar.
  terminal.send(CTRL_F)
  await shows("⌕ find ›")
  terminal.clearWrites()
  terminal.send(ESC)
  await waitFor(() => terminal.output.includes("alpha one"), "unmarked after streaming")
  expect(view()).toContain("⌕ find ›")
  terminal.send(ESC)
  await waitFor(() => !view().includes("⌕ find"), "the find bar closed")
  terminal.send("\x03")
  await exited
})

test("with text selected the history search keeps its keys, and Esc clears the selection first", async () => {
  const { terminal, screen, view, shows, idle, exited } = await setup([{ text: "some reply text" }])
  terminal.send("go\r")
  await shows("some reply text")
  await idle()
  const at = cellOf(screen, "reply")
  terminal.send(press(at.x, at.y) + drag(at.x + 4, at.y) + release(at.x + 4, at.y))
  await waitFor(() => clipboard(terminal.output) === "reply", "copied")
  await waitFor(() => terminal.output.includes("\x1b[7mreply"), "marked")
  terminal.send("\x12")
  await shows("search history")
  // Typing goes to the search.
  terminal.send("g")
  await waitFor(() => /search history › g/.test(view()), "typed into the search")
  terminal.clearWrites()
  terminal.send(ESC)
  await waitFor(() => terminal.output.includes("reply"), "the row drawn again, unmarked")
  expect(view()).toContain("search history")
  terminal.send(ESC)
  await waitFor(() => !view().includes("search history"), "the search left")
  terminal.send("\x03")
  await exited
})

test("a drag along the top row selects there; it scrolls up once it came back to it", async () => {
  // A list: every row has text, the top one too.
  const long = Array.from({ length: 30 }, (_, i) => `- item ${i + 1}`).join("\n")
  const { terminal, screen, shows, idle, exited } = await setup([{ text: long }])
  terminal.send("go\r")
  await shows("item 30")
  await idle()
  const top = screen.lines[0]!
  expect(top).toContain("item")
  terminal.send(press(2, 0) + drag(4, 0) + drag(6, 0))
  // Nothing scrolls: the text of the top row is selected.
  await waitFor(() => terminal.output.includes("\x1b[7m"), "marked")
  terminal.send(release(6, 0))
  await waitFor(() => clipboard(terminal.output) !== undefined, "copied")
  expect(screen.lines[0]).toBe(top)
  expect(clipboard(terminal.output)).toBe(top.slice(2, 7))
  // Started lower, a drag to the top row scrolls.
  terminal.send(press(2, 3) + drag(2, 1) + drag(2, 0))
  await waitFor(() => screen.lines[0] !== top, "scrolled up")
  terminal.send(release(2, 0))
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
  // The find bar keeps its essential keys; the input's hint row stays, blank.
  expect(view()).toMatch(/2\/2 · Enter older · Esc close$/m)
  expect(view()).not.toContain("newer")
  expect(view()).not.toContain("Enter send")
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

test("text-default emoji are drawn two cells wide as measured; copies keep the source text", async () => {
  const reply = "| to | from |\n| --- | --- |\n| ✉ Ana | ❤ x |\n| Bo | yy |"
  const { terminal, screen, shows, idle, exited } = await setup([{ text: reply }])
  terminal.send("go\r")
  await shows("Bo")
  await idle()
  // VS16 asks for the emoji form, so the terminal draws the two cells that were measured.
  const rows = screen.grid.filter((r) => r.join("").includes("Ana") || r.join("").includes("Bo"))
  expect(rows.length).toBe(2)
  expect(rows[0]!.join("")).toContain("✉\uFE0F Ana")
  expect(rows[0]!.join("")).toContain("❤\uFE0F x")
  // The table's column separators line up from row to row.
  const bars = (r: string[]) => r.flatMap((c, i) => (c === "│" ? [i] : []))
  expect(bars(rows[0]!)).toEqual(bars(rows[1]!))
  // Find matches the text as written.
  terminal.send(CTRL_F)
  await shows("⌕ find")
  terminal.send("✉ Ana")
  await shows("1/1")
  terminal.send(ESC)
  await waitFor(() => !screen.lines.join("\n").includes("⌕ find"), "find closed")
  terminal.send("\x1bc")
  await shows("Copied the last reply")
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")
  // What was copied is the reply as written, without the VS16 added for drawing.
  expect(screen.oscs).toContain(`52;c;${b64(reply)}`)
  terminal.send("\x03")
  expect(await exited).toBe(0)
  // So is what stays on the normal screen.
  expect(screen.mainText).toContain("✉\uFE0F Ana")
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
  await waitFor(() => /message \d+ of/.test(view()), "the user message selected")
  // The selection's bar keeps its essential keys; moving is in the key reference.
  expect(view()).toMatch(/[›❯] message \d+ of \d+ · (Enter fold · )?y copy · Esc back$/m)
  expect(view()).not.toContain(" move")
  terminal.send("y")
  await shows("Copied the message")
  expect(terminal.output).toContain(`\x1b]52;c;${b64("go")}\x07`)
  terminal.send(ESC)
  terminal.send("\x03")
  await exited
})

test("a selected reply opens into its code blocks: each is selected and copied on its own", async () => {
  const text = "Two snippets:\n\n```ts\nconst a = 1\n```\n\nand\n\n```sh\necho hi\necho there\n```\n\nDone."
  const { terminal, view, shows, idle, exited } = await setup([{ text }], { cols: 70, rows: 24 })
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")
  terminal.send("go\r")
  await shows("Done.")
  await idle()
  terminal.send(CTRL_UP)
  await waitFor(() => /reply \d+ of \d+ · → code blocks/.test(view()), "the reply selected")
  terminal.send(RIGHT)
  await shows("code block 1 of 2 in the reply")
  terminal.send("y")
  await shows("Copied the code block")
  expect(terminal.output).toContain(`\x1b]52;c;${b64("const a = 1")}\x07`)
  terminal.send(DOWN)
  await shows("code block 2 of 2 in the reply")
  // Only the code block's rows are marked.
  expect(view()).toMatch(/▌ ╭[^\n]*\n▌ │ echo hi/)
  expect(view()).not.toContain("▌ Two snippets")
  terminal.send("c")
  await waitFor(() => terminal.output.includes(b64("echo hi\necho there")), "the second copied")
  // Esc goes back to the whole reply, Esc again stops selecting.
  terminal.send(ESC)
  await waitFor(() => /reply \d+ of \d+/.test(view()) && !/code block \d/.test(view()), "back to the reply")
  terminal.send(ESC)
  await waitFor(() => !SELECT_BAR.test(view()), "done selecting")
  terminal.send("\x03")
  await exited
})

test("a selected call opens the sub-agent viewer on its sub-agent", async () => {
  let finish!: () => void
  const gate = new Promise<void>((r) => {
    finish = r
  })
  const reply = (req: { messages: { role: string; content: unknown }[] }) => {
    const child = JSON.stringify(req.messages[0]?.content).includes('"scan"')
    const answered = req.messages.at(-1)?.role === "toolResult"
    if (child) return { text: "scanned" }
    return answered ? { text: "started it" } : { toolCalls: [{ name: "launch", args: {} }] }
  }
  const { terminal, view, shows, idle, exited, agent } = await setup([reply, reply, reply], {
    cols: 80,
    commands: true,
  })
  agent.tools.register(
    defineTool({
      name: "launch",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        ctx.session!.spawn!({ role: "explorer", title: "Scan the logs", prompt: "scan" })
        await gate
        return textResult("Started")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await shows("◆ Scan the logs")
  finish()
  await shows("started it")
  await idle()
  terminal.send(CTRL_UP)
  terminal.send(CTRL_UP)
  await waitFor(() => /tool call \d+ of \d+ · Enter unfold · → sub-agent/.test(view()), "the call selected")
  terminal.send("o")
  await waitFor(() => view().includes("Esc back") && !SELECT_BAR.test(view()), "the viewer")
  expect(view()).toContain("Scan the logs")
  terminal.send(ESC)
  await waitFor(() => SELECT_BAR.test(view()), "back, still selected")
  terminal.send(ESC)
  terminal.send("\x03")
  await exited
})

test("a selected row of background sub-agents opens the viewer on them with →", async () => {
  const { terminal, view, shows, exited, agent, tree, bus } = await setup([{ text: "scanned" }], {
    cols: 80,
    commands: true,
  })
  const group = tree!.createGroup(agent, { name: "workflow demo", compact: true })
  const kid = group.spawn({ role: "explorer", title: "Scan api", prompt: "scan" })
  await shows("◆ workflow demo")
  await bus.flush()
  terminal.send(CTRL_UP)
  await waitFor(() => /background sub-agents \d+ of \d+ · .*→ sub-agent/.test(view()), "the row selected")
  terminal.send(RIGHT)
  await waitFor(() => view().includes("Esc back") && view().includes("Scan api"), "the viewer")
  terminal.send(ESC)
  await waitFor(() => /background sub-agents \d+ of \d+/.test(view()), "back, still selected")
  terminal.send(ESC)
  await kid.result()
  group.end()
  await group.ended()
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
  expect(view()).not.toMatch(SELECT_BAR)
  terminal.send("\x1b[B\r")
  await shows("thanks")
  await idle()
  expect(view()).toContain("└ true")
  // A form draws over the transcript on the same alternate screen.
  const form = host.ui.api("x").form(webhookForm)
  await shows("Where to send build results")
  terminal.send("https://ci.example\x13")
  expect(await form).toEqual({ url: "https://ci.example" })
  await shows("└ true")
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
  const shown =
    /── resumed s_[^\n]*─\n\n\n› earlier question\n\n\n {2}Earlier answer\.\n\n● read old\.ts\n {2}└ old contents/
  expect(view()).toMatch(shown)
  terminal.send("\x03")
  await exited
  expect(screen.mainText).toMatch(shown)
})

test("/clear starts the transcript afresh: find, copying, selecting and the printout see the new session only", async () => {
  const { terminal, view, shows, idle, exited, screen, ai, bus, host, commands } = await setup(
    [{ text: "old answer" }, { text: "new answer" }],
    { commands: true },
  )
  let next: Agent | undefined
  await host.load((api) => {
    api.registerCommand({
      name: "clear",
      description: "",
      run: async () => {
        next = new Agent({ ai, model: ai.model("mock/m1"), cwd: "/work/proj", systemPrompt: "", bus })
        commands!.switchTo(next)
      },
    })
  }, "test-clear")
  terminal.send("old question\r")
  await shows("old answer")
  await idle()
  terminal.send("/clear\r")
  await waitFor(() => next !== undefined && view().includes("── new session"), "the new session")
  expect(view()).toContain(`── new session ${next!.sessionId} `)
  // The boundary is the one place that names it.
  expect(view().split(next!.sessionId)).toHaveLength(2)
  expect(view()).toContain("Amira · mock/m1")
  expect(view()).not.toContain("old question")
  expect(view()).not.toContain("old answer")
  // Nothing of the old session to find or copy.
  terminal.send(CTRL_F)
  terminal.send("old")
  await shows("no matches")
  terminal.send(ESC)
  terminal.send("\x1bc")
  await shows("Nothing to copy")
  terminal.send("new question\r")
  await shows("new answer")
  await idle()
  terminal.send("\x03")
  await exited
  expect(screen.mainText).toContain("new answer")
  expect(screen.mainText).not.toContain("old answer")
})

test("a resumed compaction's summary block says why it happened", async () => {
  const exchange = (text: string): Message[] => [
    { role: "user", content: [{ type: "text", text }] },
    {
      role: "assistant",
      content: [{ type: "text", text: `re ${text}` }],
      model: { provider: "mock", model: "m1" },
    },
  ]
  const { terminal, shows, exited } = await setup([{ text: "Fixed the parser." }], {
    cols: 100,
    history: [...exchange("a"), ...exchange("b"), ...exchange("c")],
    prepare: (agent) => agent.compact(),
  })
  await shows("▸ Compacted (you asked) · summary of earlier messages · 1 line")
  terminal.send("\x03")
  await exited
})

test("a compaction's summary in a resumed history is a folded block that unfolds", async () => {
  const history: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "The earlier part of this conversation was compacted. Summary:\n\nFixed the parser.\nTests pass.",
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Understood. I will continue from this summary." }],
      model: { provider: "amira", model: "compaction" },
      stopReason: "end",
    } as Message,
    { role: "user", content: [{ type: "text", text: "and now?" }] },
  ]
  const { terminal, view, shows, exited, screen } = await setup([], { history })
  await shows("▸ Compacted summary of earlier messages · 2 lines")
  expect(view()).not.toContain("Understood")
  expect(view()).not.toContain("Fixed the parser")
  terminal.send(CTRL_UP)
  terminal.send(CTRL_UP)
  await waitFor(() => /summary \d+ of \d+ · Enter unfold/.test(view()), "the summary selected")
  terminal.send("\r")
  await shows("Fixed the parser.")
  expect(view()).toContain("▾ Compacted summary of earlier messages")
  terminal.send(ESC)
  terminal.send("\x03")
  await exited
  // Unfolded by hand, it prints unfolded.
  expect(screen.mainText).toContain("Fixed the parser.")
})

// --- images (D83)

const SIXEL: GraphicsReplies = { answered: true, sixel: true, kitty: false }
const KITTY: GraphicsReplies = { answered: true, sixel: false, kitty: true, cell: { width: 10, height: 20 } }
const WT = { WT_SESSION: "1" }
/**
 * The images extension's part, made up: every image is 40×120 pixels (4 columns and 6 rows of
 * the 10×20 cells Windows Terminal draws Sixel in), encoded as made-up data of the fitted size.
 */
const images: ImageProvider = {
  id: "test-images",
  open: async () => ({ width: 40, height: 120, encode: async (req) => fakePayload(req) }),
}
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
 * Where the image's cells must be, from where its neighbors "top" and "bottom" are: its rows
 * (six unless said) between them, cut to the transcript (which ends a row above the input box).
 */
function expectedImageRows(screen: VirtualScreen, height = 6): number[] {
  const lines = screen.lines
  const top = lines.indexOf("  top")
  const bottom = lines.indexOf("  bottom")
  const paneEnd = lines.findIndex((l) => l.startsWith("╭")) - 1
  let start: number
  let end: number
  if (top >= 0) {
    start = top + 2
    end = Math.min(top + 1 + height, paneEnd - 1)
  } else if (bottom >= 0) {
    start = Math.max(0, bottom - 1 - height)
    end = bottom - 2
  } else return []
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i)
}

test("an image in a reply is drawn in its rows of the transcript, once; exiting prints its alt text", async () => {
  const { terminal, screen, view, shows, idle, exited } = await setup([{ text: imageReply() }], {
    env: WT,
    graphics: SIXEL,
    images,
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
    images,
  })
  terminal.send("go\r")
  await shows("line 30")
  await idle()
  // Following the end: the image is far above, nothing drawn.
  expect(imageRows(screen)).toEqual([])
  const seen = new Set<string>()
  // Each step waits for its frame and for the image to be where its rows are (a loaded machine
  // can take longer than any fixed pause).
  const step = async (key: string) => {
    const before = screen.lines.join("\n")
    terminal.send(key)
    await waitFor(() => screen.lines.join("\n") !== before, "the scrolled frame")
    const placed = () => Bun.deepEquals(imageRows(screen), expectedImageRows(screen))
    await waitFor(placed, "the image in its rows").catch(() => {})
    expect(imageRows(screen)).toEqual(expectedImageRows(screen))
  }
  for (let n = 0; n < 45; n++) {
    await step(SHIFT_UP)
    const rows = imageRows(screen)
    seen.add(rows.length === 0 ? "off" : rows.length < 6 ? "cropped" : "whole")
    if (screen.lines[0] === "Amira · mock/m1 · /work/proj") break
  }
  // Down again, past it: every row it covered is erased.
  for (let n = 0; n < 45 && screen.lines.indexOf("  line 30") === -1; n++) await step(SHIFT_DOWN)
  expect(imageRows(screen)).toEqual([])
  expect([...seen].sort()).toEqual(["cropped", "off", "whole"])
  terminal.send("\x03")
  await exited
})

test("kitty: the image is sent once, placed as it scrolls, removed off screen and freed on exit", async () => {
  const { terminal, screen, shows, idle, exited } = await setup([{ text: imageReply(12) }], {
    env: { TERM: "xterm-kitty" },
    graphics: KITTY,
    images,
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
    images,
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
    images,
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
  expect(imageRows(screen)).toEqual(expectedImageRows(screen, 4))
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
    images,
  })
  terminal.send("go\r")
  await shows("bottom")
  await idle()
  await waitFor(() => imageRows(screen).length === 6, "the image")
  terminal.send(CTRL_UP)
  await waitFor(() => /reply \d+ of/.test(view()), "selected")
  // Selected, the block is marked in its first column: the image stays where it is.
  await waitFor(() => screen.lines.some((l) => l.startsWith("▌ ▓▓▓▓")), "the block marked")
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
    images,
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
    images,
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

// --- Markdown renderers of extensions (D88)

/** Renders ```wide blocks as a rule the width it is given, and says how wide, after `delayMs`. */
function ruleRenderer(calls: number[], delayMs = 0): MarkdownRendererDefinition {
  return {
    id: "rule",
    match: { codeLang: ["wide"] },
    render: async (_node, ctx) => {
      calls.push(ctx.width)
      if (delayMs) await Bun.sleep(delayMs)
      return { lines: [{ kind: "text", text: `${ctx.width}${"=".repeat(ctx.width - 2)}` }] }
    },
  }
}

test("full screen: a node an extension renders shows as code until its lines come in, and again at a new width", async () => {
  const calls: number[] = []
  const { terminal, view, shows, idle, resize, exited } = await setup(
    [{ text: "top\n\n```wide\nanything\n```\n\nbottom" }],
    { markdown: [ruleRenderer(calls, 60)] },
  )
  terminal.send("go\r")
  await shows("bottom")
  // Until the rendering is in, the block shows as the code it is.
  expect(view()).toContain("╭─ wide")
  await shows(`  58${"=".repeat(56)}`)
  await idle()
  expect(view()).not.toContain("╭─ wide")
  expect(view()).toContain(`  top\n\n  58${"=".repeat(56)}\n\n  bottom`)
  // A resize reflows it: rendered for the new width, once per width.
  resize(40, 20)
  await shows(`  38${"=".repeat(36)}`)
  resize(60, 20)
  await shows(`  58${"=".repeat(56)}`)
  expect(calls.filter((w) => w === 58)).toHaveLength(1)
  expect(calls).toContain(38)
  // Exiting prints the rendering too: the normal screen gets text.
  terminal.send("\x03")
  await exited
  expect(terminal.output.slice(terminal.output.lastIndexOf("\x1b[?1049l"))).toContain(`58${"=".repeat(56)}`)
})

test("full screen: a renderer's image is drawn like a Markdown image; without a provider the code shows", async () => {
  const chart: MarkdownRendererDefinition = {
    id: "chart",
    match: { codeLang: ["chart"] },
    render: (_node, ctx) => (ctx.images ? { image: { data: new TextEncoder().encode("png") } } : undefined),
  }
  const text = "top\n\n```chart\npie\n```\n\nbottom"
  const drawn = await setup([{ text }], { env: WT, graphics: SIXEL, images, markdown: [chart], rows: 24 })
  drawn.terminal.send("go\r")
  await drawn.shows("bottom")
  await drawn.idle()
  await waitFor(() => drawn.screen.images.length > 0, "the image")
  expect(drawn.screen.images.at(-1)).toMatchObject({ protocol: "sixel", rows: 6, cols: 4 })
  expect(imageRows(drawn.screen)).toEqual(expectedImageRows(drawn.screen))
  drawn.terminal.send("\x03")
  await drawn.exited
  const none = await setup([{ text }], { env: WT, graphics: SIXEL, markdown: [chart] })
  none.terminal.send("go\r")
  await none.shows("bottom")
  await none.idle()
  expect(none.view()).toContain("  ╭─ chart\n  │ pie\n  ╰─")
  expect(none.screen.images).toEqual([])
  none.terminal.send("\x03")
  await none.exited
})

test("an extension's notice shows in the transcript", async () => {
  const { host, shows, terminal, exited } = await setup([])
  await host.load((api) => {
    api.notify("hook biome · src/a.ts · exit 1\nsrc/a.ts:3 unused variable", "warning")
  }, "ext:hooks")
  await shows("hook biome · src/a.ts · exit 1")
  await shows("  src/a.ts:3 unused variable")
  terminal.send("\x03")
  await exited
})
