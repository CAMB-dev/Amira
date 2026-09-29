import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep, NO_MODEL, userMessage } from "@amira/ai"
import {
  type AnyEvent,
  type ChildSession,
  type CommandDefinition,
  defineTool,
  type InputHandler,
  type Message,
  type PanelDefinition,
  type SessionControl,
  type SkillDefinition,
  type SpawnGroup,
  type TuiSettings,
  textResult,
} from "@amira/api"
import { builtinPresenters } from "@amira/builtin-tools"
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
import { FakeTerminal, type GraphicsReplies, type RemoteImageFetch } from "@amira/tui-kit"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"

import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { PromptHistory } from "../src/prompt-history.ts"

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
  /** `$` skills to offer, next to `commands`. */
  skills?: SkillDefinition[]
  /** Input handlers extensions register, next to `commands`. */
  inputs?: InputHandler[]
  control?: Partial<SessionControl>
  /** Give the agent a tree, so tools can start sub-agents. */
  tree?: boolean
  /** Sub-agents working at once in that tree. */
  maxConcurrent?: number
  /** Called after every write to the terminal, once the screen shows it. */
  onWrite?: (screen: VirtualScreen) => void
  /** Present tool calls with the built-in tools' presenters. */
  presenters?: boolean
  /** Let the UI add its own commands (/verbose). */
  tuiCommands?: boolean
  /** A conversation the session starts with, as if resumed. */
  history?: Message[]
  /** Prompts sent before, for ↑/↓ and Ctrl+R. */
  promptHistory?: PromptHistory
  /** The files the @ picker offers. */
  files?: string[]
  /** The environment the UI tells the terminal apart by; empty by default. */
  env?: Record<string, string | undefined>
  keybindings?: Keybindings
  settings?: TuiSettings
  /** Start without a model (NO_MODEL); "none" also configures no provider. */
  noModel?: "none" | "unpicked"
  /** The startup notice, as the CLI passes it when there is no model. */
  notice?: string
  /** What the terminal says about graphics when asked (only when images are not off). */
  graphics?: GraphicsReplies
  /** How images in replies are fetched from the web. */
  imageFetch?: RemoteImageFetch
  /** Live panels extensions register. */
  panels?: PanelDefinition[]
  /** Called with the options the UI sets the terminal up with. */
  onSetup?: (opts: { images?: boolean } | undefined) => void
}

async function setup(steps: MockStep[], o: SetupOptions = {}) {
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  await host.load(statusExtension, "builtin:status")
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: o.noModel === "none" ? [] : [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const tree = o.tree
    ? {
        tree: new AgentTree({
          ai,
          sections: () => [],
          ...(o.maxConcurrent ? { maxConcurrent: o.maxConcurrent } : {}),
        }),
      }
    : {}
  const agent = new Agent({
    ai,
    model: o.noModel ? NO_MODEL : ai.model("mock/m1"),
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
      for (const s of o.skills ?? []) api.registerSkill(s)
      for (const h of o.inputs ?? []) api.registerInputHandler(h)
    }, "test-commands")
    commands = new CommandHost({
      registry: host.commands,
      skills: host.skills,
      inputs: host.inputs,
      bus,
      ui: host.ui,
      control: (o.control ?? {}) as SessionControl,
      agent,
    })
  }
  if (o.presenters) {
    for (const [name, p] of Object.entries(builtinPresenters)) host.renderers.register(name, p)
  }
  if (o.panels) {
    await host.load((api) => {
      for (const p of o.panels!) api.registerPanel(p)
    }, "test-panels")
  }
  if (o.history) agent.messages.push(...o.history)
  const exited = runInteractive({
    agent,
    status: host.status,
    panels: host.panels,
    ui: host.ui,
    ...(commands ? { commands } : {}),
    ...(o.tuiCommands ? { registerCommand: (c) => host.commands.register(c, "builtin:tui") } : {}),
    ...(o.presenters ? { toolRenderers: host.renderers } : {}),
    terminal,
    setup: async (_t, _env, setupOpts) => {
      o.onSetup?.(setupOpts)
      const probed = await noProbe()
      const graphics = setupOpts?.images && o.graphics ? { graphics: o.graphics } : {}
      return { capabilities: { ...probed.capabilities, ...graphics }, leftoverInput: o.leftoverInput ?? "" }
    },
    ...(o.imageFetch ? { imageFetch: o.imageFetch } : {}),
    onReady: () => agent.start("startup"),
    files: { files: async () => o.files ?? [] },
    ...(o.promptHistory ? { history: o.promptHistory } : {}),
    env: o.env ?? {},
    ...(o.keybindings ? { keybindings: o.keybindings } : {}),
    ...(o.settings ? { settings: o.settings } : {}),
    ...(o.initialPrompt ? { initialPrompt: o.initialPrompt } : {}),
    ...(o.startupEvents ? { startupEvents: o.startupEvents } : {}),
    ...(o.notice ? { notice: o.notice } : {}),
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
  return { agent, ai, mock, bus, host, commands, terminal, screen, all, live, shows, idle, exited }
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
  expect(text).toContain("└ contents of a.ts (+2 lines)")
  expect(text.indexOf("● read")).toBeLessThan(text.indexOf("The file has three lines."))
  // One blank line between blocks, and the reply indented so it reads apart from the rest.
  expect(text).toContain(
    [
      "Amira · mock/m1 · /work/proj",
      "",
      "› what is in a.ts?",
      "",
      "● read a.ts",
      "  └ contents of a.ts (+2 lines)",
      "",
      "  The file has three lines.",
      "",
      "╭",
    ].join("\n"),
  )
  terminal.send("\x03")
  expect(await exited).toBe(0)
  expect(terminal.isRaw).toBe(false)
})

test("without providers the UI starts, says how to add one, and a message explains it again", async () => {
  const notice = "No providers configured — add one with /provider add, then pick a model with /model."
  const { terminal, all, live, shows, idle, exited, mock } = await setup([], {
    noModel: "none",
    notice,
    cols: 100,
  })
  await shows(notice)
  expect(all()).toContain("Amira · (no model) · /work/proj")
  await waitFor(() => live().includes("(no model)  "), "the status bar's (no model)")
  terminal.send("hello\r")
  await shows("no providers configured; add one with /provider add, then pick a model with /model")
  await idle()
  expect(mock.requests).toHaveLength(0)
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("with providers but no model picked, a message says to pick one", async () => {
  const { terminal, shows, idle, exited } = await setup([], { noModel: "unpicked" })
  terminal.send("hello\r")
  await shows("no model selected; pick one with /model")
  await idle()
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

const parallel = { description: "", parameters: {}, concurrency: "parallel" as const }

test("parallel tool calls reach the transcript in call order, whichever finishes first", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup([
    {
      toolCalls: [
        { name: "slow", args: { path: "a.ts" } },
        { name: "fast", args: { path: "b.ts" } },
      ],
    },
    { text: "done" },
  ])
  let release!: () => void
  let fastDone = false
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
    defineTool({
      name: "fast",
      ...parallel,
      execute: async () => {
        fastDone = true
        return textResult("fast result")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  // fast finished first: it waits below slow in the live region, not in the transcript yet.
  await waitFor(() => fastDone && /● slow a\.ts .*\n● fast b\.ts$/m.test(live()), "fast held under slow")
  await Bun.sleep(30)
  expect(all()).not.toContain("fast result")
  release()
  await shows("done")
  await idle()
  expect(all()).toContain(
    ["● slow a.ts", "  └ slow result", "● fast b.ts", "  └ fast result", "", "  done"].join("\n"),
  )
  terminal.send("\x03")
  await exited
})

test("a running tool shows the last lines of its output live, and only its result once done", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "stream", args: { command: "make" } }] },
    { text: "built" },
  ])
  let release!: () => void
  agent.tools.register(
    defineTool({
      name: "stream",
      ...parallel,
      execute: async (_p, ctx) => {
        ctx.update(textResult("l1\nl2\nl3\nl4\nl5\n"))
        await new Promise<void>((r) => {
          release = r
        })
        return textResult("ok")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => live().includes("│ l5"), "live output")
  expect(live()).toContain("  │ l3\n  │ l4\n  │ l5")
  expect(live()).not.toContain("│ l2")
  release()
  await shows("built")
  await idle()
  expect(all()).toContain("● stream make\n  └ ok")
  expect(all()).not.toContain("│ l5")
  terminal.send("\x03")
  await exited
})

test("Esc interrupting a running tool marks it interrupted, muted, not failed", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "hang", args: { command: "sleep 100" } }] },
  ])
  agent.tools.register(
    defineTool({
      name: "hang",
      ...parallel,
      execute: (_p, ctx) =>
        new Promise((r) =>
          ctx.signal.addEventListener("abort", () => r(textResult("Command was aborted.", true))),
        ),
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => live().includes("● hang sleep 100"), "running")
  terminal.send("\x1b[27u")
  await shows("Interrupted.")
  await idle()
  expect(all()).toContain("⊘ hang sleep 100\n  └ interrupted\n\n⊘ Interrupted.")
  expect(all()).not.toContain("✗")
  terminal.send("\x03")
  await exited
})

test("failures show their output cut to 8 lines; Ctrl+O shows all of later ones and says so", async () => {
  const out = Array.from({ length: 20 }, (_, i) => `out ${i + 1}`).join("\n")
  const { terminal, live, all, shows, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "fail", args: {} }] },
    { text: "one" },
    { toolCalls: [{ name: "fail", args: {} }] },
    { text: "two" },
  ])
  agent.tools.register(
    defineTool({ name: "fail", ...parallel, execute: async () => textResult(`bad\n${out}`, true) }),
    "test",
  )
  terminal.send("go\r")
  await shows("one")
  await idle()
  expect(all()).toContain("✗ fail\n  └ bad (+20 lines)\n    out 1\n")
  expect(all()).toContain("    … 13 more lines\n")
  expect(all()).not.toContain("out 10")
  terminal.send("\x0f")
  await waitFor(() => live().includes("Tool output: full (applies to tool results from now on"), "hint")
  terminal.send("again\r")
  await shows("two")
  await idle()
  // The first result stays as it was committed; the second one is complete.
  expect(all().split("    out 10\n").length - 1).toBe(1)
  expect(all().split("… 13 more lines").length - 1).toBe(1)
  terminal.send("\x03")
  await exited
})

test("/verbose sets the tool output level, printed under the command", async () => {
  const { terminal, all, shows, exited } = await setup([], { commands: testCommands([]), tuiCommands: true })
  terminal.send("/verbose collapsed\r")
  await shows("Tool output: collapsed")
  // Wrapped to the width, hanging under the result mark.
  expect(all()).toContain(
    "› /verbose collapsed\n  └ Tool output: collapsed (applies to tool results from now\n    on; Ctrl+O cycles)",
  )
  terminal.send("/verbose loud\r")
  await shows('Unknown level "loud"')
  terminal.send("\x03")
  await exited
})

test("the built-in presenters: an edit shows its diff with line numbers", async () => {
  const { terminal, all, shows, idle, exited, agent } = await setup(
    [
      { toolCalls: [{ name: "edit", args: { path: "src/a.ts", old_string: "old", new_string: "new" } }] },
      { text: "ok" },
    ],
    { presenters: true },
  )
  agent.tools.register(
    defineTool({
      name: "edit",
      ...parallel,
      execute: async () => ({
        content: [{ type: "text", text: "Edited src/a.ts: replaced 1 occurrence" }],
        details: {
          path: "/work/proj/src/a.ts",
          replacements: 1,
          added: 1,
          removed: 1,
          hunks: [{ oldStart: 11, oldLines: 2, newStart: 11, newLines: 2, lines: [" keep", "-old", "+new"] }],
        },
      }),
    }),
    "test",
  )
  terminal.send("go\r")
  await shows("ok")
  await idle()
  expect(all()).toContain(
    ["● edit src/a.ts", "  └ +1 −1", "    11  keep", "    12 -old", "    12 +new", "", "  ok"].join("\n"),
  )
  terminal.send("\x03")
  await exited
})

test("a resumed session shows its history like the live transcript, then a separator with its id", async () => {
  const { terminal, all, agent, exited } = await setup([], {
    presenters: true,
    history: [
      { role: "user", content: [{ type: "text", text: "count" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "glob", args: { pattern: "*.ts" } }],
        model: { provider: "mock", model: "m1" },
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "glob",
        content: [{ type: "text", text: "a.ts\nb.ts" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Two." }],
        model: { provider: "mock", model: "m1" },
      },
    ],
  })
  await waitFor(() => all().includes("── resumed"), "history")
  expect(all()).toContain(
    ["› count", "", "● glob *.ts", "  └ 2 files", "", "  Two.", "", `── resumed ${agent.sessionId} ──`].join(
      "\n",
    ),
  )
  terminal.send("\x03")
  await exited
})

test("the activity line shows what the turn does, its time, output tokens and how to interrupt", async () => {
  const { terminal, live, idle, exited } = await setup([{ text: "x".repeat(200), delayMs: 20 }])
  terminal.send("go\r")
  await waitFor(() => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] working · 0s · ↓ \d+ tokens · Esc interrupt/.test(live()), "activity")
  await idle()
  expect(live()).not.toContain("Esc interrupt")
  terminal.send("\x03")
  await exited
})

test("a message sent during /compact counts its own time and tokens, not the last turn's", async () => {
  const said = (text: string): Message[] => [
    { role: "user", content: [{ type: "text", text }] },
    {
      role: "assistant",
      content: [{ type: "text", text: `re ${text}` }],
      model: { provider: "mock", model: "m1" },
    },
  ]
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      { text: "first answer", usage: { input: 10, output: 4321 } },
      { text: "SUMMARY ".repeat(40), delayMs: 10 },
      { text: "second answer" },
    ],
    { cols: 80, history: [...said("a"), ...said("b")] },
  )
  terminal.send("q1\r")
  await shows("first answer")
  await idle()
  const compacted = agent.compact()
  await waitFor(() => live().includes("compacting the conversation"), "compacting")
  terminal.send("q2\r")
  await waitFor(() => /› q2|Enter steer/.test(live()), "sent")
  // The prompt waits for the compaction; its activity line starts from zero meanwhile.
  expect(live()).toMatch(/compacting the conversation · 0s · Esc interrupt/)
  expect(live()).not.toContain("↓")
  expect(await compacted).toBe(true)
  await shows("second answer")
  await idle()
  expect(all()).toContain("Compacted")
  terminal.send("\x03")
  await exited
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

test("a Markdown reply streams block by block: every row once, in order, never cut and reprinted", async () => {
  const markers: string[] = []
  const m = (kind: "L" | "P") => {
    const id = `${kind}${markers.length + 1}`
    markers.push(id)
    return id
  }
  const parts = [
    `# ${m("L")} heading`,
    "",
    `Some **bold ${m("L")}** and \`code ${m("L")}\` here.`,
    Array.from({ length: 40 }, () => m("P")).join(" "),
    "",
    ...Array.from({ length: 6 }, () => `- item ${m("L")} with *emphasis*`),
    `  - nested ${m("L")}`,
    "",
    "```ts",
    ...Array.from({ length: 8 }, () => `const ${m("L")} = "x" // note`),
    "```",
    "",
    `> quoted ${m("L")}`,
    "",
    "| col | other |",
    "|-----|-------|",
    ...Array.from({ length: 5 }, () => `| ${m("L")} | **v** |`),
    "",
    `Done ${m("L")}.`,
  ]
  const check = transcriptChecker(markers)
  const { terminal, screen, shows, idle, all, exited } = await setup(
    [{ text: parts.join("\n"), delayMs: 1 }],
    {
      cols: 40,
      rows: 12,
      onWrite: (s) => check.onWrite(s),
    },
  )
  terminal.send("go\r")
  await shows(`Done ${markers.at(-1)}.`)
  await idle()
  expect(check.problems).toEqual([])
  check.final(screen)
  const text = all()
  expect(text).toContain(`${markers[0]} heading`)
  expect(text).not.toContain("# L1")
  expect(text).toContain("Some bold L2 and code L3 here.")
  expect(text).toContain("• item")
  expect(text).toContain("╭─ ts")
  expect(text).toContain("▎ quoted")
  expect(text).toMatch(/col +│ other/)
  // In the assistant's gutter, one blank line from the prompt, blank rows between blocks blank.
  expect(text).toContain(`› go\n\n  ${markers[0]} heading\n\n  Some bold`)
  expect(text).toContain("\n  ╭─ ts\n  │ const")
  expect(text).not.toMatch(/\n +\n/)
  terminal.send("\x03")
  await exited
})

test("a URL longer than the screen is cut to fit it, never cut and reprinted", async () => {
  // Four characters a marker, so that none is split where the URL wraps: 42 columns less the
  // reply's gutter leave 40 for the text.
  const markers = Array.from({ length: 80 }, (_, i) => `L${i + 10}`)
  const check = transcriptChecker(markers)
  const { terminal, screen, shows, idle, exited } = await setup(
    [{ text: `See https://example.com/${markers.join("/")} for details`, delayMs: 1 }],
    { cols: 42, rows: 12, onWrite: (s) => check.onWrite(s) },
  )
  terminal.send("go\r")
  await shows("for details")
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
  // Typed with Shift+Enter between rows: a paste this long would be folded into a placeholder.
  terminal.send(Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join("\x1b[13;2u"))
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
  await shows("└ passed")
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

test('with tui.submitWhileWorking "queue", Enter queues while working and the queue key steers', async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup(
    [
      { text: "looking", delayMs: 60, toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
      (req) => ({ text: `saw ${lastUserText(req)}` }),
      (req) => ({ text: `then ${lastUserText(req)}` }),
    ],
    { settings: { submitWhileWorking: "queue" }, cols: 80 },
  )
  // Idle, Enter just sends.
  await waitFor(() => live().includes("Enter send"), "idle hint")
  terminal.send("go\r")
  await waitFor(() => live().includes(`Enter queue · ${QUEUE_HINT} steer`), "the swapped hint")
  terminal.send("after it\r")
  await shows("queued › after it")
  terminal.send("now B\x11")
  await shows("saw now B")
  await shows("then after it")
  await idle()
  const users = agent.messages
    .filter((m) => m.role === "user")
    .map((m) => (m.content[0] as { text: string }).text)
  // The steer joined the first turn; the queued one became the next.
  expect(users).toEqual(["go", "now B", "after it"])
  terminal.send("\x03")
  await exited
})

test("submit.steer and submit.queue keys do one thing whatever the setting; commands still run at once", async () => {
  for (const mode of ["steer", "queue"] as const) {
    const keys = new Keybindings({
      ...defaultKeys({ vscode: false }),
      "submit.steer": ["ctrl+t"],
      "submit.queue": ["ctrl+g"],
    })
    const { terminal, agent, shows, idle, exited } = await setup(
      [
        { text: "looking", delayMs: 300, toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
        (req) => ({ text: `saw ${lastUserText(req)}` }),
        (req) => ({ text: `then ${lastUserText(req)}` }),
      ],
      { keybindings: keys, settings: { submitWhileWorking: mode }, commands: testCommands([]), cols: 80 },
    )
    terminal.send("go\r")
    await waitFor(() => agent.status === "working", "working")
    terminal.send("later\x07")
    await shows("queued › later")
    terminal.send("B\x14")
    // A slash command sent with either key runs now, not after the turn.
    terminal.send("/status\x07")
    await shows("STATUS OK")
    expect(agent.status).toBe("working")
    await shows("saw B")
    await shows("then later")
    await idle()
    const users = agent.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content[0] as { text: string }).text)
    expect(users).toEqual(["go", "B", "later"])
    terminal.send("\x03")
    await exited
  }
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

const subagentNotice = (text: string) =>
  userMessage(`report: ${text}`, { text: `◆ explorer finished · 41s · 12.3k tok`, origin: "subagent" })

test("a background result wakes the idle session as a notice line; a draft in the editor stays", async () => {
  const { terminal, live, all, agent, shows, idle, exited } = await setup([
    (req) => ({ text: `reacting to ${lastUserText(req)}` }),
  ])
  terminal.send("half-typed")
  await waitFor(() => live().includes("half-typed"), "the draft")
  agent.expectNotice().deliver(subagentNotice("found it"))
  await shows("reacting to report: found it")
  await idle()
  const text = all()
  expect(text).toContain("◆ explorer finished · 41s · 12.3k tok")
  expect(text).not.toContain("› ◆")
  expect(text).not.toContain("› report")
  expect(live()).toContain("half-typed")
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("a background result during a turn shows as a notice where it joins, not as steering", async () => {
  const { terminal, live, all, agent, shows, idle, exited } = await setup([
    { text: "looking", delayMs: 60, toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
    (req) => ({ text: `then saw ${lastUserText(req)}` }),
  ])
  terminal.send("go\r")
  await waitFor(() => live().includes(`Enter steer · ${QUEUE_HINT} queue`), "working")
  agent.expectNotice().deliver(subagentNotice("B"))
  await Bun.sleep(20)
  expect(live()).not.toContain("steering ›")
  await shows("then saw report: B")
  await idle()
  const text = all()
  expect(text.indexOf("● read")).toBeLessThan(text.indexOf("◆ explorer finished"))
  expect(text.indexOf("◆ explorer finished")).toBeLessThan(text.indexOf("then saw report: B"))
  // A block of the transcript like any other: one blank line before it and after it.
  expect(text).toMatch(/[^\n]\n\n◆ explorer finished · 41s · 12\.3k tok\n\n {2}then saw/)
  terminal.send("\x03")
  await exited
})

test("a background result an interrupt kept waiting shows as pending and joins the next message", async () => {
  const { terminal, live, all, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    (req) => ({ text: `now saw ${req.messages.length} messages` }),
  ])
  terminal.send("go\r")
  await shows("01234567")
  agent.expectNotice().deliver(subagentNotice("C"))
  await waitFor(() => live().includes("◆ explorer finished · 41s · 12.3k tok · pending"), "pending line")
  terminal.send("\x1b[27u")
  await shows("Interrupted.")
  await idle()
  expect(live()).toContain("· pending")
  terminal.send("next\r")
  await shows("now saw")
  await idle()
  expect(live()).not.toContain("· pending")
  const text = all()
  expect(text.indexOf("› next")).toBeLessThan(text.indexOf("◆ explorer finished"))
  expect(agent.waitingNotices).toBe(0)
  terminal.send("\x03")
  await exited
})

test("a failed woken turn shows the countdown to the resend; a message sent first clears it", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([
    { error: { message: "provider down" } },
    { text: "answered you" },
  ])
  agent.expectNotice().deliver(subagentNotice("R"))
  await shows("provider down")
  await idle()
  await waitFor(() => /◆ sub-agents' results · pending · retry in (10|9)s/.test(live()), "the countdown")
  expect(agent.noticeRetry?.attempt).toBe(1)
  terminal.send("hello\r")
  await shows("answered you")
  await idle()
  expect(live()).not.toContain("retry in")
  expect(agent.noticeRetry).toBeUndefined()
  terminal.send("\x03")
  await exited
})

test("a held background result woken by a later one leaves no pending line behind", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    { text: "both seen" },
  ])
  terminal.send("go\r")
  await shows("01234567")
  agent.expectNotice().deliver(subagentNotice("first"))
  await waitFor(() => live().includes("· pending"), "pending line")
  terminal.send("\x1b[27u")
  await shows("Interrupted.")
  await idle()
  agent.expectNotice().deliver(subagentNotice("second"))
  await shows("both seen")
  await idle()
  expect(live()).not.toContain("· pending")
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

test("typing a slash opens the command list below the editor; Tab and Enter complete and run", async () => {
  const log: string[] = []
  const { terminal, live, shows, exited } = await setup([], { commands: testCommands(log) })
  terminal.send("/")
  await waitFor(() => live().includes("/status"), "popup")
  const rows = live().split("\n")
  const popupRow = rows.findIndex((l) => l.includes("/clear"))
  // The editor sits in the input box: "│ › /     │".
  const editorRow = rows.findIndex((l) => /^│ › \/ *│$/.test(l.trimEnd()))
  expect(editorRow).toBeGreaterThan(-1)
  expect(popupRow).toBeGreaterThan(editorRow)
  // The list takes the place of the status bar and the hint, and ends with its own hint.
  expect(rows.filter((l) => l.trim()).at(-1)).toContain("↑↓ select · Tab complete · Enter run · Esc close")
  expect(rows.slice(editorRow).join("\n")).not.toContain("mock/m1")
  expect(live()).not.toContain("Enter send")
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

test("typing a command: the input box stays put and each key draws one frame with its list", async () => {
  const frames: string[][] = []
  const { terminal, live, exited } = await setup([], {
    commands: testCommands([]),
    onWrite: (screen) => void frames.push([...screen.lines]),
  })
  await waitFor(() => live().includes("Enter send"), "first frame")
  await Bun.sleep(40)
  const boxTop = (lines: string[]) => lines.findIndex((l) => l.startsWith("╭"))
  const top = boxTop(frames.at(-1)!)
  expect(top).toBeGreaterThan(-1)
  /** The rows between the box's bottom edge and the popup's hint. */
  const list = (lines: string[]) => {
    const start = lines.findIndex((l) => l.startsWith("╰")) + 1
    const end = lines.findIndex((l) => l.startsWith("↑↓ select"))
    return end === -1 ? [] : lines.slice(start, end).map((l) => l.trimEnd())
  }
  const steps: [string, string[]][] = [
    [
      "/",
      [
        "› /clear   Start a new session",
        "  /help    List the slash commands",
        "  /model   Switch the model",
        "  /quit    Leave Amira",
        "  /status  Show the status",
      ],
    ],
    ["m", ["› /model  Switch the model"]],
    ["o", ["› /model  Switch the model"]],
    ["d", ["› /model  Switch the model"]],
    ["e", ["› /model  Switch the model"]],
    ["l", ["› /model  Switch the model"]],
    [" ", ["› deepseek/deepseek-flash", "  deepseek/deepseek-pro", "  openai/gpt-5"]],
    ["d", ["› deepseek/deepseek-flash", "  deepseek/deepseek-pro"]],
  ]
  for (const [k, expected] of steps) {
    const before = frames.length
    terminal.send(k)
    await Bun.sleep(60)
    const drawn = frames.slice(before)
    expect({ key: k, frames: drawn.length }).toEqual({ key: k, frames: 1 })
    expect(boxTop(drawn[0]!)).toBe(top)
    expect(list(drawn[0]!)).toEqual(expected)
  }
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("async argument candidates get a frame to arrive, so the key still draws once", async () => {
  const frames: string[][] = []
  const { terminal, live, exited } = await setup([], {
    commands: [
      {
        name: "pick",
        description: "Pick",
        args: {
          complete: async () => {
            await Bun.sleep(3)
            return [{ value: "alpha" }, { value: "beta" }]
          },
        },
        run: () => {},
      },
    ],
    onWrite: (screen) => void frames.push([...screen.lines]),
  })
  terminal.send("/pick")
  await waitFor(() => live().includes("› /pick"), "popup")
  await Bun.sleep(40)
  const before = frames.length
  terminal.send(" ")
  await Bun.sleep(80)
  const drawn = frames.slice(before)
  expect(drawn).toHaveLength(1)
  expect(drawn[0]!.join("\n")).toContain("› alpha")
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("a command's echo and everything it prints reach the screen in one frame", async () => {
  const writes: string[] = []
  const { terminal, live, shows, exited } = await setup([], {
    commands: [
      {
        name: "chatty",
        description: "Prints twice",
        run: (_a, ctx) => {
          ctx.print("first line")
          ctx.print("second line")
        },
      },
    ],
    onWrite: (screen) => void writes.push(screen.lines.join("\n")),
  })
  terminal.send("/chatty")
  await waitFor(() => live().includes("› /chatty"), "popup")
  await Bun.sleep(40)
  const before = writes.length
  terminal.send("\r")
  await shows("second line")
  await Bun.sleep(60)
  const drawn = writes.slice(before)
  expect(drawn).toHaveLength(1)
  expect(drawn[0]).toContain("first line")
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

test("a command that sends a long prompt shows as typed, with its note, while the model gets it all", async () => {
  let agent!: Agent
  const long = Array.from({ length: 40 }, (_, i) => `instruction line ${i}`).join("\n")
  const skill: CommandDefinition = {
    name: "review-pr",
    description: "A skill",
    run: (args, ctx) =>
      ctx.session.send(long, {
        display: { text: `/review-pr ${args}`, note: "Loaded skill review-pr (40 lines)" },
      }),
  }
  const s = await setup([{ text: "Reviewing." }], {
    commands: [skill],
    control: {
      send: async (text, opts) => {
        await agent.prompt(userMessage(text, opts?.display))
      },
    },
  })
  agent = s.agent
  s.terminal.send("/review-pr 123\r")
  await s.shows("Reviewing.")
  await s.idle()
  const text = s.all()
  expect(text).toContain("› /review-pr 123\n  └ Loaded skill review-pr (40 lines)")
  expect(text).not.toContain("instruction line")
  const sent = s.mock.requests[0]!.messages[0]!
  expect(sent).toEqual({ role: "user", content: [{ type: "text", text: long }] })
  s.terminal.send("\x03")
  await s.exited
})

/** A skill like the skills extension's: it sends its text, shown as the line typed. */
function testSkill(name: string, description: string): SkillDefinition {
  return {
    name,
    description,
    run: (args, ctx) =>
      ctx.session.send(`SKILL ${name} BODY ${args}`, {
        display: { text: `$${name}${args ? ` ${args}` : ""}`, note: `Loaded skill ${name} (3 lines)` },
      }),
  }
}

async function skillSetup(steps: MockStep[], o: SetupOptions = {}) {
  let agent!: Agent
  const s = await setup(steps, {
    commands: testCommands([]),
    skills: [testSkill("review-pr", "Review a pull request"), testSkill("deploy", "Ship it")],
    control: {
      send: async (text, opts) => {
        await agent.prompt(userMessage(text, opts?.display))
      },
    },
    ...o,
  })
  agent = s.agent
  return s
}

test("typing $ opens the skill list; Enter runs the skill, shown as typed with its note", async () => {
  const { terminal, live, all, mock, shows, idle, exited } = await skillSetup([{ text: "Reviewing." }])
  terminal.send("$")
  await waitFor(() => live().includes("$review-pr"), "skill popup")
  expect(live()).toContain("$deploy")
  expect(live()).toContain("Review a pull request")
  // Skills are not commands: the "/" list leaves them out.
  expect(live()).not.toContain("/help")
  expect(live()).toContain("↑↓ select · Tab complete · Enter run · Esc close")
  terminal.send("rev")
  await waitFor(() => live().includes("› $review-pr"), "review-pr selected")
  terminal.send("\t")
  await waitFor(() => live().includes("$review-pr [arguments]"), "usage")
  terminal.send("123\r")
  await shows("Reviewing.")
  await idle()
  expect(all()).toContain("› $review-pr 123\n  └ Loaded skill review-pr (3 lines)")
  expect(all()).not.toContain("SKILL review-pr BODY")
  expect(mock.requests[0]!.messages[0]).toEqual({
    role: "user",
    content: [{ type: "text", text: "SKILL review-pr BODY 123" }],
  })
  terminal.send("\x03")
  await exited
})

test("the / list has no skills, and /<skill> points at $ instead of running it", async () => {
  const { terminal, live, agent, shows, exited } = await skillSetup([], { cols: 100 })
  terminal.send("/")
  await waitFor(() => live().includes("/status"), "command popup")
  expect(live()).not.toContain("review-pr")
  terminal.send("de")
  await Bun.sleep(30)
  expect(live()).not.toContain("deploy")
  // Ctrl+C clears the input.
  terminal.send("\x03")
  await waitFor(() => live().includes("Message Amira"), "cleared")
  terminal.send("/deploy now\r")
  await shows("Unknown command /deploy — skills now start with $: $deploy")
  expect(agent.messages).toEqual([])
  terminal.send("\x03")
  await exited
})

test("a line an input handler claims runs at once, also during a turn, and never reaches the model", async () => {
  const got: string[] = []
  const { terminal, agent, all, shows, idle, mock, exited } = await setup(
    [{ text: "Working on it.", delayMs: 300 }, { text: "Hello." }],
    {
      commands: testCommands([]),
      inputs: [
        {
          name: "swarm",
          claims: (t) => /^@writer\s/.test(t),
          run: (t, ctx) => {
            got.push(t)
            ctx.print("→ writer: message sent")
          },
        },
      ],
    },
  )
  terminal.send("start\r")
  await waitFor(() => agent.status === "working", "turn")
  terminal.send("@writer keep it short\r")
  await shows("→ writer: message sent")
  expect(got).toEqual(["@writer keep it short"])
  await idle()
  expect(all()).toContain("› @writer keep it short")
  // Not steered into the turn: the model only ever saw the first message.
  expect(mock.requests).toHaveLength(1)
  expect(JSON.stringify(agent.messages)).not.toContain("keep it short")
  // A line nobody claims is a message as usual.
  terminal.send("@reader hi\r")
  await shows("Hello.")
  expect(JSON.stringify(mock.requests[1]!.messages)).toContain("@reader hi")
  terminal.send("\x03")
  await exited
})

test("text that starts with $ but names no skill is sent as a message", async () => {
  const { terminal, agent, all, live, shows, idle, exited } = await skillSetup(
    [{ text: "Noted." }, { text: "Sure." }],
    { skills: [testSkill("home-assistant", "Smart home")] },
  )
  terminal.send("$100 is the price\r")
  await shows("Noted.")
  await idle()
  // "$HOME" lists home-assistant, but only its case-exact start would run it: Enter sends it.
  terminal.send("$HOME")
  await waitFor(() => live().includes("› $home-assistant"), "listed")
  terminal.send("\r")
  await shows("Sure.")
  await idle()
  const users = agent.messages.filter((m) => m.role === "user")
  expect(users.map((m) => (m.content[0] as { text: string }).text)).toEqual(["$100 is the price", "$HOME"])
  expect(all()).not.toContain("Unknown")
  terminal.send("\x03")
  await exited
})

test("the $ list takes its keys from the keybindings like the / list", async () => {
  const keys = new Keybindings({
    ...defaultKeys({ vscode: false }),
    "popup.down": ["ctrl+n"],
    "popup.accept": ["ctrl+y"],
    "popup.close": ["ctrl+g"],
  })
  const { terminal, live, all, shows, idle, exited } = await skillSetup([{ text: "Deployed." }], {
    keybindings: keys,
    cols: 100,
  })
  terminal.send("$")
  await waitFor(() => live().includes("› $deploy"), "skill popup")
  expect(live()).toContain("Ctrl+Y run · Ctrl+G close")
  terminal.send("\x0e")
  await waitFor(() => live().includes("› $review-pr"), "moved down")
  terminal.send("\x0e")
  await waitFor(() => live().includes("› $deploy"), "wrapped")
  terminal.send("\x07")
  await waitFor(() => !live().includes("Ship it"), "closed")
  terminal.send("d")
  await waitFor(() => live().includes("› $deploy"), "open again")
  terminal.send("\x19")
  await shows("Deployed.")
  await idle()
  expect(all()).toContain("› $deploy\n  └ Loaded skill deploy (3 lines)")
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

/** A tool that starts one sub-agent per title, all at once, and waits for them. */
function delegateTool(role = "explorer") {
  return defineTool<{ titles: string[] }>({
    name: "delegate",
    description: "",
    parameters: {},
    concurrency: "parallel",
    execute: async (p, ctx) => {
      const kids = p.titles.map((title) =>
        ctx.session!.spawn!({
          role: title.startsWith("Add") ? "coder" : role,
          title,
          prompt: `do: ${title}`,
        }),
      )
      const results = await Promise.all(kids.map((k) => k.result()))
      return textResult(results.map((r) => r.text).join("\n"))
    },
  })
}

test("sub-agents show under their call: title, role, time, tokens, current tool, queued ones", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      { toolCalls: [{ name: "delegate", args: { titles: ["US market trend", "Add status bar test"] } }] },
      { toolCalls: [{ name: "read", args: { path: "a.ts" } }], usage: { input: 4000, output: 100 } },
      { text: "trend is up", delayMs: 400 },
      { text: "test added", usage: { input: 1200, output: 30 } },
      { text: "all done" },
    ],
    { cols: 80, tree: true, maxConcurrent: 1 },
  )
  agent.tools.register(delegateTool(), "test")
  terminal.send("go\r")
  // The first one runs its tool; the second waits for the slot.
  await waitFor(
    () =>
      /● delegate +. \d+s\n {2}├ ◆ US market trend · explorer · \d+s · 4\.1k tok\n {2}│ └ ● read a\.ts\n {2}└ ◆ Add status bar test · coder · queued\n/.test(
        live(),
      ),
    "rows under the call",
  )
  // No list of sub-agents at the bottom of the live region: only the activity line is there.
  expect(live().match(/◆/g)).toHaveLength(2)
  await shows("all done")
  await idle()
  const text = all()
  // Each one's rows became its end line, committed with the call right under its head, in order.
  expect(text).toMatch(
    /● delegate\n {2}├ ◆ US market trend ✓ explorer · \d+\.\ds · 4\.1k tok · trend is up\n {2}├ ◆ Add status bar test ✓ coder · \d+\.\ds · 1\.2k tok · test added\n {2}└ trend is up/,
  )
  expect(text.match(/◆ US market trend/g)).toHaveLength(1)
  // Nothing is left of them in the live region below the transcript.
  expect(live().split("  all done")[1]).not.toContain("◆")
  // The children's replies only show as their commander's tool result, not as replies of their own.
  expect(text).not.toMatch(/^ {2}trend is up$/m)
  terminal.send("\x03")
  await exited
})

test("a sub-agent's end line stays with its call when that call is held behind a slower one", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      {
        toolCalls: [
          { name: "slow", args: { path: "big.log" } },
          { name: "delegate", args: { titles: ["Look around"] } },
        ],
      },
      { text: "child answer" },
      { text: "all done" },
    ],
    { cols: 80, tree: true },
  )
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
  agent.tools.register(delegateTool(), "test")
  terminal.send("go\r")
  // The child is done and so is its call, but both wait below the running slow call.
  await waitFor(
    () => /● slow big\.log .*\n● delegate\n {2}└ ◆ Look around ✓ .*child answer/m.test(live()),
    "held",
  )
  release()
  await shows("all done")
  await idle()
  const text = all()
  expect(text).toMatch(
    /● slow big\.log\n {2}└ slow result\n● delegate\n {2}├ ◆ Look around ✓ [^\n]*child answer\n {2}└ child answer/,
  )
  expect(text.match(/◆ Look around ✓/g)).toHaveLength(1)
  terminal.send("\x03")
  await exited
})

test("parallel calls each keep their own sub-agents, matched by call id, not by task", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      {
        toolCalls: [
          { name: "delegate", args: { titles: ["First pass"] } },
          { name: "delegate", args: { titles: ["Second pass"] } },
        ],
      },
      { text: "one", delayMs: 200 },
      { text: "two", delayMs: 200 },
      { text: "all done" },
    ],
    { cols: 80, tree: true },
  )
  agent.tools.register(delegateTool(), "test")
  terminal.send("go\r")
  await waitFor(
    () => /● delegate .*\n {2}└ ◆ First pass · .*\n● delegate .*\n {2}└ ◆ Second pass · /.test(live()),
    "each under its own call",
  )
  await shows("all done")
  await idle()
  expect(all()).toMatch(
    /● delegate\n {2}├ ◆ First pass ✓ [^\n]*\n {2}└ \w+\n● delegate\n {2}├ ◆ Second pass ✓ [^\n]*\n {2}└ \w+/,
  )
  terminal.send("\x03")
  await exited
})

test("nested sub-agents sit one level deeper under their parent's row", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      { toolCalls: [{ name: "delegate", args: { titles: ["Outer task"] } }] },
      { toolCalls: [{ name: "delegate", args: { titles: ["Inner check"] } }] },
      { text: "inner done", delayMs: 400 },
      { text: "outer done" },
      { text: "all done" },
    ],
    { cols: 80, tree: true },
  )
  agent.tools.register(delegateTool(), "test")
  terminal.send("go\r")
  await waitFor(
    () =>
      /● delegate +. \d+s\n {2}└ ◆ Outer task · explorer · \d+s · 0 tok\n {4}└ ● delegate\n {4}└ ◆ Inner check · explorer · \d+s · 0 tok\n/.test(
        live(),
      ),
    "nested rows",
  )
  await shows("all done")
  await idle()
  expect(all()).toMatch(
    /● delegate\n {2}├ ◆ Outer task ✓ explorer [^\n]*outer done\n {4}└ ◆ Inner check ✓ explorer [^\n]*inner done\n {2}└ outer done/,
  )
  terminal.send("\x03")
  await exited
})

test("after an interrupt, a sub-agent it stopped gets its end line; one that runs on and finishes does not", async () => {
  // Replies go by who asks: the commander, or a child by its task.
  const reply = (req: { messages: { role: string; content: unknown }[] }) => {
    const task = JSON.stringify(req.messages[0]?.content)
    if (task.includes("keep going")) return { text: "kept at it", delayMs: 300 }
    if (task.includes("stop me")) return { text: "never", delayMs: 5000 }
    return { toolCalls: [{ name: "pair", args: {} }] }
  }
  const { terminal, live, all, shows, idle, exited, agent, bus } = await setup([reply, reply, reply], {
    cols: 90,
    tree: true,
  })
  let survivor: ChildSession | undefined
  agent.tools.register(
    defineTool({
      name: "pair",
      description: "",
      parameters: {},
      // Like the main session's agent calls: an interrupt stops one child, the other runs on.
      execute: (_p, ctx) => {
        survivor = ctx.session!.spawn!({ role: "explorer", title: "Keep going", prompt: "keep going" })
        const stopped = ctx.session!.spawn!({ role: "explorer", title: "Stop me", prompt: "stop me" })
        return new Promise((r) =>
          ctx.signal.addEventListener("abort", () => {
            stopped.abort("interrupted")
            r(textResult("Started in the background"))
          }),
        )
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => live().includes("◆ Stop me · explorer"), "both running")
  terminal.send("\x1b[27u")
  await shows("Interrupted.")
  await survivor!.result()
  await idle()
  await bus.flush()
  await waitFor(() => !live().includes("running in background"), "the rows gone")
  expect(all()).toMatch(/└ ◆ Stop me ⊘ explorer · [^\n]*stopped/)
  expect(all().match(/◆ Stop me ⊘/g)).toHaveLength(1)
  // The survivor's notice (the agent extension's) reports it; no line of its own here.
  expect(all()).not.toContain("◆ Keep going ✓")
  terminal.send("\x03")
  await exited
})

test("sub-agents that outlive their call run on under a head shaped like the call, with no end line", async () => {
  let finish!: () => void
  // The child and the commander ask in no fixed order: each reply goes by who asks.
  const reply = (req: { messages: { role: string; content: unknown }[] }) => {
    const child = JSON.stringify(req.messages[0]?.content).includes('"scan"')
    const answered = req.messages.at(-1)?.role === "toolResult"
    if (child)
      return answered
        ? { text: "scanned" }
        : { toolCalls: [{ name: "scan", args: { path: "logs/app.log" } }] }
    return answered ? { text: "started it" } : { toolCalls: [{ name: "launch", args: {} }] }
  }
  const { terminal, live, all, shows, idle, exited, agent, bus } = await setup([reply, reply, reply, reply], {
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
  // The call is committed; its sub-agent runs on in the live region.
  expect(all()).toMatch(/● launch\n {2}└ Started in the background/)
  await waitFor(
    () =>
      /● launch · 1 sub-agent · running in background · \d+s\n {2}└ ◆ Scan the logs · explorer · \d+s · 0 tok\n {4}└ ● scan logs\/app\.log\n/.test(
        live(),
      ),
    "background rows",
  )
  const committed = all().split("running in background")[0]!
  expect(committed).not.toContain("Scan the logs")
  finish()
  await child!.result()
  await bus.flush()
  await waitFor(() => !live().includes("◆ background"), "the rows gone")
  // Its end is reported by its notice (the agent extension's), not by an end line of its own.
  expect(all()).not.toContain("◆ Scan the logs ✓")
  terminal.send("\x03")
  await exited
})

test("a compact spawn group shows as one line with its owner's status, not a row per member", async () => {
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
  const { terminal, live, all, shows, idle, exited, agent, bus } = await setup(
    [reply, reply, reply, reply, reply, reply, reply, reply],
    { cols: 90, tree: true },
  )
  let group: SpawnGroup | undefined
  // Members wait here until the test has seen the line.
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
      /● flow · 3 sub-agents · running in background · \d+s\n {2}└ ◆ workflow demo · Explore · 0\/3 agents\n/.test(
        live(),
      ),
    "one line for the group",
  )
  expect(live()).not.toContain("Scan api")
  group!.setStatus("Verify · 2/3 agents")
  await waitFor(() => live().includes("◆ workflow demo · Verify · 2/3 agents"), "the new status")
  release()
  await group!.ended()
  await bus.flush()
  await waitFor(() => !live().includes("workflow demo"), "the line gone")
  // Its members never get lines of their own.
  expect(all()).not.toContain("Scan core")
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
  expect(live()).toContain("› 1 merge")
  terminal.send("2")
  await idle()
  expect(agent.messages.find((m) => m.role === "toolResult")?.content[0]).toEqual({
    type: "text",
    text: "keep",
  })
  terminal.send("\x03")
  await exited
})

const userTexts = (agent: Agent) =>
  agent.messages.flatMap((m) =>
    m.role === "user" ? [m.content.map((b) => (b.type === "text" ? b.text : "")).join("")] : [],
  )

test("a big paste shows as one placeholder, in the input box and the transcript, and is sent in full", async () => {
  const { terminal, agent, all, live, shows, idle, exited } = await setup([{ text: "got it" }])
  const log = Array.from({ length: 30 }, (_, i) => `log line ${i}`).join("\n")
  terminal.send(`see \x1b[200~${log}\x1b[201~ please`)
  await waitFor(() => live().includes("see [pasted 30 lines #1] please"), "placeholder")
  expect(live()).not.toContain("log line 3")
  terminal.send("\r")
  await shows("got it")
  await idle()
  expect(userTexts(agent)).toEqual([`see ${log} please`])
  expect(all()).toContain("› see [pasted 30 lines #1] please")
  expect(all()).not.toContain("log line 3")
  terminal.send("\x03")
  await exited
})

/** A tool that asks for a review of a diff `lines` long. */
function reviewTool(lines: number) {
  const diff = Array.from({ length: lines }, (_, i) => `+line ${i + 1}`).join("\n")
  return (api: Parameters<Parameters<ExtensionHost["load"]>[0]>[0]) => {
    api.registerTool(
      defineTool({
        name: "review",
        description: "",
        parameters: {},
        execute: async () =>
          textResult(String(await api.ui.reviewDiff("Merge the worktree?", diff, ["merge", "keep"]))),
      }),
    )
  }
}

test("a diff review taller than the terminal keeps its title, options and keys in view", async () => {
  const { host, terminal, live, idle, exited } = await setup(
    [{ toolCalls: [{ name: "review", args: {} }] }, { text: "reviewed" }],
    { rows: 14 },
  )
  await host.load(reviewTool(54), "reviewer")
  terminal.send("go\r")
  await waitFor(() => live().includes("? Merge the worktree?"), "review dialog")
  const rows = live().split("\n")
  expect(rows.some((l) => /… \d+ more lines …/.test(l))).toBe(true)
  expect(live()).toContain("+line 1")
  expect(live()).toContain("+line 54")
  expect(live()).toContain("› 1 merge")
  expect(live()).toContain("  2 keep")
  expect(live()).toContain("↑↓ move · Enter choose · Esc cancel")
  expect(live()).not.toContain("type to filter")
  // The running call that asked stays in view above it, and the frame fits the screen.
  expect(rows.some((l) => l.startsWith("● review"))).toBe(true)
  expect(rows[0]).not.toContain("line")
  terminal.send("1")
  await idle()
  terminal.send("\x03")
  await exited
})

test("↑ on an empty editor recalls what was sent, and ↓ goes back to empty", async () => {
  const history = new PromptHistory()
  const { terminal, agent, live, shows, idle, exited } = await setup([{ text: "one" }, { text: "two" }], {
    promptHistory: history,
  })
  terminal.send("first message\r")
  await shows("one")
  await idle()
  expect(history.entries.map((e) => e.text)).toEqual(["first message"])
  terminal.send("\x1b[A")
  await waitFor(() => live().includes("› first message"), "recalled")
  terminal.send("\x1b[B")
  await waitFor(() => live().includes("Message Amira"), "empty again")
  terminal.send("\x1b[A\r")
  await shows("two")
  await idle()
  expect(userTexts(agent)).toEqual(["first message", "first message"])
  terminal.send("\x03")
  await exited
})

test("messages queued together are sent as one turn but shown one by one", async () => {
  const { terminal, all, shows, idle, agent, exited } = await setup([
    { text: "first answer", delayMs: 40 },
    { text: "second answer" },
  ])
  terminal.send("start\r")
  await waitFor(() => agent.status === "working", "working")
  terminal.send(`one${ALT_ENTER}`)
  terminal.send(`two${ALT_ENTER}`)
  await shows("queued › two")
  await shows("second answer")
  await idle()
  expect(all()).toContain("› one\n\n› two")
  expect(all()).not.toContain("  two")
  const prompts = agent.messages.filter((m) => m.role === "user")
  expect(prompts.length).toBe(2)
  terminal.send("\x03")
  await exited
})

test("Ctrl+R searches the history; Enter keeps the match in the editor to send or edit", async () => {
  const history = new PromptHistory()
  for (const t of ["deploy to staging", "run the tests", "deploy to prod"]) history.add([t])
  const { terminal, agent, live, shows, idle, exited } = await setup([{ text: "on it" }], {
    promptHistory: history,
  })
  terminal.send("\x12")
  await waitFor(() => live().includes("search history"), "search line")
  expect(live()).toContain("Esc cancel")
  terminal.send("deploy")
  await waitFor(() => live().includes("› deploy to prod"), "newest match")
  expect(live()).toContain("1 of 2")
  terminal.send("\x12")
  await waitFor(() => live().includes("› deploy to staging"), "older match")
  terminal.send("\r")
  await waitFor(() => !live().includes("search history"), "search closed")
  expect(live()).toContain("› deploy to staging")
  terminal.send("\r")
  await shows("on it")
  await idle()
  expect(userTexts(agent)).toEqual(["deploy to staging"])
  terminal.send("\x03")
  await exited
})

test("Esc leaves the history search with the draft back", async () => {
  const history = new PromptHistory()
  history.add(["old prompt"])
  const { terminal, live, exited } = await setup([], { promptHistory: history })
  terminal.send("my draft\x12old")
  await waitFor(() => live().includes("› old prompt"), "match")
  terminal.send("\x1b")
  await waitFor(() => live().includes("› my draft"), "draft back")
  expect(live()).not.toContain("search history")
  terminal.send("\x03\x03")
  await exited
})

test("Ctrl+L clears the screen and draws the latest transcript and the live region again", async () => {
  const { terminal, screen, live, shows, idle, exited } = await setup([{ text: "the answer" }])
  terminal.send("hello\r")
  await shows("the answer")
  await idle()
  terminal.send("draft")
  await waitFor(() => live().includes("draft"), "draft")
  // Some other program wrote over the screen.
  screen.write("\x1b[1;1HGARBAGE GARBAGE\r\nMORE GARBAGE")
  terminal.send("\x0c")
  await waitFor(() => !live().includes("GARBAGE"), "redrawn")
  expect(live()).toContain("› hello")
  expect(live()).toContain("the answer")
  expect(live()).toContain("› draft")
  expect(screen.lines[0]).toContain("Amira")
  terminal.send("\x03\x03")
  await exited
})

test("typing @ offers project files; Tab inserts the path and the message keeps it", async () => {
  const { terminal, agent, live, shows, idle, exited } = await setup([{ text: "read it" }], {
    files: ["src/app.ts", "src/format.ts", "README.md"],
  })
  terminal.send("look at @form")
  await waitFor(() => live().includes("› src/format.ts"), "file list")
  expect(live()).toContain("Tab/Enter insert")
  // Like the command list, it opens below the input box, in place of the status bar.
  const rows = live().split("\n")
  expect(rows.findIndex((l) => l.includes("› src/format.ts"))).toBeGreaterThan(
    rows.findIndex((l) => l.startsWith("╰")),
  )
  terminal.send("\t")
  await waitFor(() => live().includes("› look at @src/format.ts"), "inserted")
  expect(live()).not.toContain("Tab/Enter insert")
  terminal.send("please\r")
  await shows("read it")
  await idle()
  expect(userTexts(agent)).toEqual(["look at @src/format.ts please"])
  terminal.send("\x03")
  await exited
})
test("the terminal title names the folder and branch, and the progress indicator follows the turn", async () => {
  const { terminal, screen, bus, agent, shows, idle, exited } = await setup([{ text: "done", delayMs: 20 }], {
    env: { WT_SESSION: "1" },
  })
  bus.emit("workspace.changed", { cwd: "/work/proj", branch: "main" }, { sessionId: agent.sessionId })
  await waitFor(() => screen.oscs.includes("0;Amira · proj ⎇ main"), "branch in the title")
  terminal.send("go\r")
  await shows("done")
  await idle()
  const oscs = screen.oscs
  expect(oscs).toContain("0;● Amira · proj ⎇ main")
  expect(oscs).toContain("9;4;3;0")
  expect(oscs.filter((o) => o.startsWith("9;4;")).at(-1)).toBe("9;4;0;0")
  expect(oscs.filter((o) => o.startsWith("0;")).at(-1)).toBe("0;Amira · proj ⎇ main")
  terminal.send("\x03")
  await exited
  // The title is handed back: the terminal's own, or the one saved on the title stack.
  expect(screen.oscs.at(-1)).toBe("0;")
  expect(terminal.output).toContain("\x1b]0;\x07\x1b[23;0t")
})

test("outside Windows Terminal and friends no progress is sent; settings turn title and bell off", async () => {
  const { terminal, screen, shows, idle, exited } = await setup([{ text: "done" }], {
    env: { TERM_PROGRAM: "iTerm.app" },
    settings: { title: false, bell: false },
  })
  terminal.send("\x1b[Ogo\r")
  await shows("done")
  await idle()
  terminal.send("\x03")
  await exited
  expect(screen.oscs).toEqual([])
  expect(screen.bells).toBe(0)
  expect(terminal.output).not.toContain("\x1b[?1004h")
})

test("the bell rings when a turn ends in the background; focus reports never reach the editor", async () => {
  const { terminal, screen, live, shows, idle, exited } = await setup([{ text: "one" }, { text: "two" }])
  expect(terminal.output).toContain("\x1b[?1004h")
  terminal.send("\x1b[Ifirst\r")
  await shows("one")
  await idle()
  expect(screen.bells).toBe(0)
  terminal.send("\x1b[Osecond\r")
  await shows("two")
  await idle()
  expect(screen.bells).toBe(1)
  expect(live()).not.toContain("[O")
  expect(live()).not.toContain("[I")
  terminal.send("\x03")
  await exited
})

test("a narrow hint drops whole items instead of cutting one", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([{ text: "slow answer", delayMs: 40 }], {
    cols: 40,
  })
  terminal.send("go\r")
  await waitFor(() => agent.status === "working", "working")
  // Esc interrupt is on the activity line; the hint keeps its most useful items whole.
  await waitFor(() => live().includes(`Enter steer · ${QUEUE_HINT} queue`), "working hint")
  expect(live()).toContain("· Esc interrupt")
  expect(live()).not.toContain("interr…")
  expect(live()).not.toContain("newl")
  await shows("slow answer")
  await idle()
  await waitFor(() => live().includes("Enter send · Ctrl+C quit"), "idle hint")
  terminal.send("\x03")
  await exited
})

test("keybindings replace the default keys, and the hints name them", async () => {
  const keys = new Keybindings({
    ...defaultKeys({ vscode: false }),
    queue: ["ctrl+t"],
    cancel: ["ctrl+x"],
    newline: ["ctrl+j"],
  })
  const { terminal, live, agent, shows, idle, exited } = await setup(
    [{ text: "first", delayMs: 40 }, { text: "later" }],
    { keybindings: keys, cols: 100 },
  )
  await waitFor(() => live().includes("Enter send · Ctrl+J newline · Ctrl+X quit"), "idle hint")
  terminal.send("go\r")
  await waitFor(() => agent.status === "working", "working")
  await waitFor(() => live().includes("Ctrl+T queue"), "queue hint")
  terminal.send("next\x14")
  await shows("queued › next")
  await shows("later")
  await idle()
  // Ctrl+C is not bound any more; Ctrl+X quits.
  terminal.send("\x03")
  await Bun.sleep(30)
  terminal.send("\x18")
  expect(await exited).toBe(0)
})

test("links in a reply are clickable where the UI's environment says the terminal supports it", async () => {
  for (const env of [{ WT_SESSION: "1" }, {}]) {
    const { terminal, screen, shows, idle, exited } = await setup(
      [{ text: "See [the docs](https://example.com/docs) now." }],
      { env },
    )
    terminal.send("go\r")
    await shows("now.")
    await idle()
    const linked = screen.oscs.some((o) => o.startsWith("8;") && o.endsWith("https://example.com/docs"))
    expect(linked).toBe("WT_SESSION" in env)
    terminal.send("\x03")
    await exited
  }
})

test("history, the history search, the file list and Ctrl+O take their keys from the keybindings too", async () => {
  const keys = new Keybindings({
    ...defaultKeys({ vscode: false }),
    "history.search": ["ctrl+f"],
    "search.cancel": ["ctrl+x"],
    "popup.close": ["ctrl+x"],
    "tool-output": ["ctrl+t"],
    "history.prev": ["ctrl+p"],
  })
  const promptHistory = new PromptHistory()
  promptHistory.add(["old prompt"])
  const { terminal, live, exited } = await setup([], {
    keybindings: keys,
    promptHistory,
    files: ["src/app.ts"],
    tuiCommands: true,
    cols: 80,
  })
  // The default Ctrl+R and ↑ are not bound any more.
  terminal.send("\x12\x1b[A")
  await Bun.sleep(30)
  expect(live()).not.toContain("search history")
  expect(live()).not.toContain("› old prompt")
  terminal.send("\x06")
  await waitFor(() => live().includes("search history"), "search line")
  expect(live()).toContain("Enter accept · Ctrl+R older · Ctrl+S newer · Ctrl+X cancel")
  terminal.send("\x18")
  await waitFor(() => !live().includes("search history"), "search closed")
  terminal.send("\x10")
  await waitFor(() => live().includes("› old prompt"), "recalled with Ctrl+P")
  terminal.send("\x03")
  terminal.send("@src")
  await waitFor(() => live().includes("› src/app.ts"), "file list")
  expect(live()).toContain("↑↓ select · Tab/Enter insert · Ctrl+X close")
  terminal.send("\x18")
  await waitFor(() => !live().includes("› src/app.ts"), "file list closed")
  terminal.send("\x03\x14")
  await waitFor(() => live().includes("Tool output: full"), "tool output note")
  expect(live()).toContain("Ctrl+T cycles")
  terminal.send("\x03")
  await exited
})

test("with tui.reflow off, a narrower terminal does not move up past the live region", async () => {
  for (const reflow of ["on", "off"] as const) {
    const { terminal, all, exited } = await setup([], { settings: { reflow }, cols: 60, rows: 20 })
    await waitFor(() => all().includes("Message Amira"), "input box")
    terminal.clearWrites()
    terminal.setSize(40, 20)
    await waitFor(() => terminal.writes.length > 0, "a frame")
    // The caret is on the editor row, below the box's full-width top border and the blank row
    // above the box: a re-wrapping terminal made that border two rows, one that does not left it one.
    expect(terminal.writes[0]!).toContain(`\r\x1b[${reflow === "on" ? 3 : 2}A\x1b[J`)
    terminal.send("\x03")
    await exited
  }
})

/** A 30×40 PNG: 3 columns and 2 rows of 10×20 cells, as Sixel draws it in whole bands. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAB4AAAAoCAYAAADpE0oSAAAAaklEQVR4Xu3NkQKDUABA0XA4HA6HwzAMwzAIwjAMwzAMwzAMH4Zh2F/U/YjwwuETRWW4Xnjjgy9++CNGghQZchSoUKNBiw49BoyYMGPBioANOw6cMDY2NjY2NjYOxsbGxsbGxsbB2Pix+AZFpUoFb9YsKwAAAABJRU5ErkJggg==",
  "base64",
)
const SIXEL: GraphicsReplies = { answered: true, sixel: true, kitty: false }
const WT = { WT_SESSION: "1" }

test("an image mid-reply is drawn in its place: every row once, in order, the rest waiting for it", async () => {
  const markers: string[] = []
  const m = () => {
    const id = `L${markers.length + 1}`
    markers.push(id)
    return id
  }
  const parts = [
    ...Array.from({ length: 6 }, () => `line ${m()}`),
    "",
    "![chart](https://img.test/chart.png)",
    "",
    ...Array.from({ length: 6 }, () => `line ${m()}`),
  ]
  const check = transcriptChecker(markers)
  let fetched = 0
  const { terminal, screen, shows, idle, exited } = await setup([{ text: parts.join("\n"), delayMs: 2 }], {
    cols: 40,
    rows: 24,
    env: WT,
    graphics: SIXEL,
    onWrite: (s) => check.onWrite(s),
    imageFetch: async (url) => {
      fetched++
      expect(url.href).toBe("https://img.test/chart.png")
      // Slower than the lines after it take to stream: they wait for it.
      await Bun.sleep(60)
      return { bytes: PNG, contentType: "image/png" }
    },
  })
  terminal.send("go\r")
  await shows(`line ${markers.at(-1)}`)
  await idle()
  await waitFor(() => screen.images.length > 0, "the image")
  await Bun.sleep(30)
  expect(check.problems).toEqual([])
  check.final(screen)
  expect(fetched).toBe(1)
  expect(screen.images).toEqual([expect.objectContaining({ protocol: "sixel", col: 2, rows: 2, cols: 3 })])
  const all = [...screen.scrollback, ...screen.lines]
  const row = screen.images[0]!.row
  expect(all.slice(row - 2, row + 4)).toEqual(["  line L6", "", "  ▓▓▓", "  ▓▓▓", "", "  line L7"])
  expect(all.join("\n")).not.toContain("🖼 chart")
  terminal.send("\x03")
  await exited
})

test("an image that cannot be fetched, or a private address, is its alt text; tui.images off draws none", async () => {
  const setups: ({ images?: boolean } | undefined)[] = []
  const run = async (text: string, o: Partial<SetupOptions>) => {
    const { terminal, screen, all, shows, idle, exited } = await setup([{ text }], {
      env: WT,
      graphics: SIXEL,
      onSetup: (opts) => setups.push(opts),
      ...o,
    })
    terminal.send("go\r")
    await shows("done")
    await idle()
    const out = { text: all(), images: screen.images.length }
    terminal.send("\x03")
    await exited
    return out
  }
  // The real fetcher refuses a local address, as web_fetch does.
  const local = await run("![secret](http://127.0.0.1:9/a.png)\n\ndone", {})
  expect(local.images).toBe(0)
  // Windows Terminal makes links clickable: the URL is in the link, not shown.
  expect(local.text).toContain("  🖼 secret\n\n  done")
  const failing = await run("![gone](https://img.test/404.png)\n\ndone", {
    imageFetch: async () => {
      throw new Error("HTTP 404")
    },
  })
  expect(failing.images).toBe(0)
  expect(failing.text).toContain("  🖼 gone\n\n  done")
  const off = await run("![chart](https://img.test/chart.png)\n\ndone", {
    settings: { images: "off" },
    imageFetch: async () => ({ bytes: PNG, contentType: "image/png" }),
  })
  expect(off.images).toBe(0)
  expect(off.text).toContain("  🖼 chart")
  expect(setups).toEqual([{ images: true }, { images: true }, { images: false }])
  // Without Sixel in the terminal's answer, "auto" draws none either.
  const none = await run("![chart](https://img.test/chart.png)\n\ndone", {
    graphics: { answered: true, sixel: false, kitty: false },
    imageFetch: async () => ({ bytes: PNG, contentType: "image/png" }),
  })
  expect(none.images).toBe(0)
})

test("an image slower than its time is committed as its alt text, and what follows goes on", async () => {
  const { terminal, screen, all, shows, idle, exited } = await setup(
    [{ text: "![slow](https://img.test/slow.png)\n\nafter it" }],
    {
      env: WT,
      graphics: SIXEL,
      imageFetch: (_url, { signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
    },
  )
  terminal.send("go\r")
  await shows("after it")
  await idle()
  // Both show in the live region while waiting, then go to the scrollback as they were.
  await Bun.sleep(3300)
  expect(all()).toContain("  🖼 slow\n\n  after it")
  expect(screen.images).toEqual([])
  terminal.send("\x03")
  await exited
}, 10_000)

test("live panels sit above the input in both modes, fold with Ctrl+T and follow their state", async () => {
  for (const mode of ["inline", "fullscreen"] as const) {
    let items = ["✓ write the parser", "› test it", "• ship it"]
    let seen: { sessionId: string; hasData: boolean } | undefined
    const { terminal, live, host, exited } = await setup([], {
      cols: 100,
      settings: { mode },
      panels: [
        {
          id: "todo",
          render: (o) => {
            seen = { sessionId: o.sessionId, hasData: !!o.data }
            if (!items.length) return []
            return [
              {
                kind: "muted",
                text: `Todos ${items.filter((i) => i.startsWith("✓")).length}/${items.length}`,
              },
              ...items.map((text) => ({ kind: text.startsWith("›") ? "accent" : "text", text }) as const),
            ]
          },
        },
      ],
    })
    await waitFor(() => live().includes("› test it"), `${mode}: the panel`)
    const rows = live().split("\n")
    const panelRow = rows.findIndex((r) => r.startsWith("Todos 1/3"))
    const boxRow = rows.findIndex((r) => r.startsWith("╭"))
    expect(panelRow).toBeGreaterThan(-1)
    // The panel, then a blank line, then the input box.
    expect(boxRow).toBe(panelRow + 5)
    expect(seen?.hasData).toBe(true)
    expect(live()).toContain("fold panels")
    terminal.send("\x14")
    await waitFor(() => !live().includes("› test it"), `${mode}: folded`)
    expect(live()).toContain("Todos 1/3")
    expect(live()).toContain("unfold panels")
    terminal.send("\x14")
    items = ["✓ write the parser", "✓ test it", "› ship it"]
    // A change shows at the next redraw the extension asks for.
    await host.load((api) => api.requestRender(), `render-${mode}`)
    await waitFor(() => live().includes("› ship it"), `${mode}: updated`)
    items = []
    await host.load((api) => api.requestRender(), `render2-${mode}`)
    await waitFor(() => !live().includes("Todos"), `${mode}: hidden when empty`)
    terminal.send("\x04")
    await exited
  }
})
