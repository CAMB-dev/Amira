import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAi, createMockDialect, type MockStep, NO_MODEL, userMessage } from "@amira/ai"
import {
  type AnyEvent,
  type ChildSession,
  type CommandDefinition,
  defineTool,
  type ImageInput,
  type ImageOpenContext,
  type ImageProvider,
  type InputHandler,
  type MarkdownRendererDefinition,
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
import { FakeTerminal, type GraphicsReplies } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { fakePayload } from "../../tui-kit/test/fake-images.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import {
  activityLabel,
  lastReasoningLine,
  pendingMessageRows,
  retryLabel,
  runInteractive,
  statusRetryLabel,
  tildePath,
} from "../src/app.ts"
import { FileIndex, type FileSource, fileList } from "../src/file-index.ts"

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
  /** Runs on the agent once the history is in, before the UI starts (e.g. a compaction). */
  prepare?: (agent: Agent) => Promise<unknown>
  /** Prompts sent before, for ↑/↓ and Ctrl+R. */
  promptHistory?: PromptHistory
  /** The files the @ picker offers. */
  files?: string[]
  /** Where the @ picker gets them, in place of `files`. */
  fileSource?: FileSource
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
  /** An image provider, as the images extension registers one (D88). */
  images?: ImageProvider
  /** Markdown renderers extensions register (D88). */
  markdown?: MarkdownRendererDefinition[]
  /** Live panels extensions register. */
  panels?: PanelDefinition[]
  /** Called with the options the UI sets the terminal up with. */
  onSetup?: (opts: { images?: boolean; background?: boolean } | undefined) => void
}

async function setup(steps: MockStep[], o: SetupOptions = {}) {
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  await host.load(statusExtension, "builtin:status")
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers:
      o.noModel === "none"
        ? []
        : [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 128_000 } }],
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
  if (o.images || o.markdown) {
    await host.load((api) => {
      if (o.images) api.registerImageProvider(o.images)
      for (const r of o.markdown ?? []) api.registerMarkdownRenderer(r)
    }, "test-render")
  }
  if (o.history) agent.messages.push(...o.history)
  await o.prepare?.(agent)
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
    imageProviders: host.images,
    markdownRenderers: host.markdown,
    onReady: () => agent.start("startup"),
    files: o.fileSource ?? fileList(async () => o.files ?? []),
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
  // One blank line between blocks, and the reply indented so it reads apart from the rest. The
  // user's message is on a band with a row of it above and below (blank on this screen).
  expect(text).toContain(
    [
      "Amira · mock/m1 · /work/proj",
      // Where to start, right under the banner.
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
      "",
      "╭",
    ].join("\n"),
  )
  terminal.send("\x03")
  expect(await exited).toBe(0)
  expect(terminal.isRaw).toBe(false)
})

test("without providers the UI starts with a welcome card; a message sent keeps its text in the input", async () => {
  const notice = "No providers configured — add one with /provider add, then pick a model with /model."
  const { terminal, all, live, shows, agent, exited, mock } = await setup([], {
    noModel: "none",
    notice,
    cols: 100,
  })
  // The card says what the notice would, as steps.
  await shows("Welcome to Amira. Three steps to a first message:")
  expect(all()).toContain("1. Add a provider: /provider add")
  expect(all()).toContain("2. Pick one of its models: /model")
  expect(all()).toContain("3. Ask away: @ mentions files, /help lists the commands and keys")
  expect(all()).not.toContain(notice)
  expect(all()).toContain("Amira · (no model) · /work/proj")
  await waitFor(() => live().includes("╰─ (no model) ─"), "the status's (no model)")
  terminal.send("hello\r")
  await shows("No providers configured: add one with /provider add, then pick a model with /model.")
  // Not sent: the message waits in the input for a model.
  expect(live()).toContain("│ › hello")
  expect(agent.messages).toEqual([])
  expect(mock.requests).toHaveLength(0)
  terminal.send("\x03")
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("with providers but no model picked, a message says to pick one and stays in the input", async () => {
  const { terminal, live, shows, exited } = await setup([], {
    noModel: "unpicked",
    notice: 'No model selected — pick one with /model, or set "model" in settings.json.',
  })
  await shows("No model selected — pick one with /model")
  terminal.send("hello\r")
  await shows("No model selected: pick one with /model.")
  expect(live()).toContain("› hello")
  terminal.send("\x03")
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("a banner wider than the terminal wraps at a word, not where the terminal cuts it", async () => {
  const { terminal, all, exited } = await setup([], { cols: 24 })
  expect(all()).toContain("Amira · mock/m1 ·\n/work/proj")
  terminal.send("\x03")
  expect(await exited).toBe(0)
})

test("a home directory in the banner reads as ~", () => {
  expect(tildePath("/home/ada/proj", { HOME: "/home/ada" })).toBe("~/proj")
  expect(tildePath("/home/ada", { HOME: "/home/ada/" })).toBe("~")
  expect(tildePath("/home/adam/proj", { HOME: "/home/ada" })).toBe("/home/adam/proj")
  expect(tildePath("/work/proj", { HOME: "/home/ada" })).toBe("/work/proj")
  // Windows: the profile is the home, whatever HOME a shell set; the drive's case does not matter.
  const win = { USERPROFILE: "C:\\Users\\Ada", HOME: "/c/Users/Ada" }
  expect(tildePath("c:\\Users\\Ada\\proj", win, "win32")).toBe("~\\proj")
  expect(tildePath("C:\\Users\\Adam\\proj", win, "win32")).toBe("C:\\Users\\Adam\\proj")
})

test("a startup notice about something else shows under the welcome card", async () => {
  const { terminal, all, shows, exited } = await setup([], {
    noModel: "none",
    notice: "settings.json could not be read",
    cols: 100,
    // The session says there are no providers; the notice is about something else.
    commands: [],
    control: { providers: () => [] },
  })
  await shows("Welcome to Amira. Three steps to a first message:")
  await shows("settings.json could not be read")
  expect(all()).not.toContain("No providers configured")
  terminal.send("\x03")
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

test("many calls at once take at most half the screen: output first, then the first calls give way", async () => {
  const calls = Array.from({ length: 8 }, (_, i) => ({ name: "stream", args: { command: `job${i + 1}` } }))
  const { terminal, live, shows, idle, exited, agent } = await setup(
    [{ toolCalls: calls }, { text: "all built" }],
    {
      rows: 14,
    },
  )
  const releases: (() => void)[] = []
  agent.tools.register(
    defineTool({
      name: "stream",
      ...parallel,
      execute: async (_p, ctx) => {
        ctx.update(textResult("l1\nl2\n"))
        await new Promise<void>((r) => releases.push(r))
        return textResult("ok")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => releases.length === 8 && live().includes("job8"), "all running")
  // 14 rows: at most 7 for the calls, their output dropped, the first three counted.
  expect(live()).not.toContain("│ l2")
  expect(live()).toContain("… 3 earlier calls")
  expect(live()).not.toContain("job3 ")
  expect(live()).toContain("job4")
  for (const r of releases) r()
  await shows("all built")
  await idle()
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
  await shows("⊘ Interrupted")
  await idle()
  // What it printed before it was stopped stays under it.
  expect(all()).toContain("⊘ hang sleep 100\n  └ interrupted\n    Command was aborted.\n\n⊘ Interrupted")
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
  // Wrapped to the width, hanging under the result mark, below the echo's band.
  expect(all()).toContain(
    "› /verbose collapsed\n\n  └ Tool output: collapsed (applies to tool results from now\n    on; Ctrl+O cycles)",
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
    ["● edit src/a.ts", "  └ +1 -1", "    11   keep", "    12 - old", "    12 + new", "", "  ok"].join("\n"),
  )
  terminal.send("\x03")
  await exited
})

test("successful reads in a row, over steps too, go to the scrollback as one Explored row", async () => {
  const { terminal, all, shows, idle, exited } = await setup(
    [
      {
        toolCalls: [
          { name: "read", args: { path: "a.ts" } },
          { name: "read", args: { path: "b.ts" } },
        ],
      },
      { toolCalls: [{ name: "read", args: { path: "c.ts" } }] },
      { text: "done" },
    ],
    { presenters: true },
  )
  terminal.send("go\r")
  await shows("done")
  await idle()
  expect(all()).toContain("● Explored · Read a.ts, b.ts, c.ts\n\n  done")
  expect(all()).not.toContain("● read a.ts")
  terminal.send("\x03")
  await exited
})

test("a resumed session shows its thinking folded and marks a reply that was interrupted", async () => {
  const { terminal, all, exited } = await setup([], {
    history: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "let me see" },
          { type: "text", text: "Half an ans" },
        ],
        model: { provider: "mock", model: "m1" },
        stopReason: "aborted",
      },
    ],
  })
  await waitFor(() => all().includes("⊘ Interrupted"), "history")
  expect(all()).toContain("› go\n\n\n∴ Thought\n\n  Half an ans\n\n⊘ Interrupted")
  terminal.send("\x03")
  await exited
})

test("a resumed session shows a boundary with its id, then its history like the live transcript", async () => {
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
  expect(all()).toContain(`── resumed ${agent.sessionId} ${"─".repeat(38)}\n\n\n› count`)
  expect(all()).toContain(["› count", "", "", "● glob *.ts", "  └ 2 files", "", "  Two."].join("\n"))
  terminal.send("\x03")
  await exited
})

test("the activity line shows what the turn does, its time and output tokens; the hint how to interrupt", async () => {
  const { terminal, live, idle, exited } = await setup([{ text: "x".repeat(200), delayMs: 20 }])
  terminal.send("go\r")
  await waitFor(() => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] working · 0s · ↓ \d+ tokens$/m.test(live()), "activity")
  expect(live()).toContain(`Enter steer · ${QUEUE_HINT} queue · Esc interrupt`)
  await idle()
  expect(live()).not.toContain("Esc interrupt")
  terminal.send("\x03")
  await exited
})

test("while tools run the activity line names them and keeps its spinner and time", async () => {
  const { terminal, live, idle, exited, agent } = await setup(
    [
      {
        toolCalls: [
          { name: "slowa", args: {} },
          { name: "slowb", args: {} },
        ],
      },
      { text: "ok" },
    ],
    { cols: 80 },
  )
  const release: Record<string, () => void> = {}
  for (const name of ["slowa", "slowb"]) {
    agent.tools.register(
      defineTool({
        name,
        description: "",
        parameters: {},
        concurrency: "parallel",
        execute: () =>
          new Promise((r) => {
            release[name] = () => r(textResult("done"))
          }),
      }),
      "test",
    )
  }
  const activity = (label: string) => new RegExp(`^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ${label} · \\d+s( · ↓ \\d+ tokens)?$`, "m")
  terminal.send("go\r")
  await waitFor(() => activity("2 tools running").test(live()), "two tools")
  // The rows keep their own spinners.
  expect(live()).toMatch(/● slowa +[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d+s/)
  release.slowb!()
  await waitFor(() => activity("1 tool running").test(live()), "one tool left")
  release.slowa!()
  await idle()
  expect(live()).not.toContain("Esc interrupt")
  terminal.send("\x03")
  await exited
})

test("the activity label names the most specific activity", () => {
  const base = { compacting: false, running: [] as string[], preparing: undefined, thinking: false }
  expect(activityLabel(base)).toBe("working")
  expect(activityLabel({ ...base, thinking: true })).toBe("thinking")
  expect(activityLabel({ ...base, preparing: "bash" })).toBe("preparing bash")
  // Running tools are counted: their own rows name them.
  expect(activityLabel({ ...base, running: ["bash"], thinking: true })).toBe("1 tool running")
  expect(activityLabel({ ...base, running: ["bash", "read", "grep"] })).toBe("3 tools running")
  expect(activityLabel({ ...base, compacting: true, running: ["bash"] })).toBe("compacting the conversation")
  const retry = { attempt: 2, maxRetries: 3, status: 429, kind: "rate", at: Date.now() + 5500 }
  expect(activityLabel({ ...base, running: ["bash"], retry })).toBe("retrying in 6s (2/3) · 429")
  expect(retryLabel({ ...retry, status: undefined, at: 0 }, 1000)).toBe("retrying in 0s (2/3) · rate")
  expect(activityLabel({ ...base, preparing: "write", waiting: true })).toBe("waiting for you")
  expect(activityLabel({ ...base, thinking: true, retrying: "retrying (2/3)" })).toBe("retrying (2/3)")
})

test("a failed model request reads as one line and the next step; the raw answer stays folded", async () => {
  const raw = `HTTP 401: {"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}`
  const { terminal, all, shows, idle, exited } = await setup([{ error: { message: raw, status: 401 } }], {
    cols: 80,
  })
  terminal.send("hi\r")
  await shows("The API key was rejected by the provider (HTTP 401)")
  await idle()
  expect(all()).toContain("Set a new key with /provider key mock")
  expect(all()).not.toContain("invalid_api_key")
  terminal.send("\x03")
  await exited
})

test("while a failed request waits to be sent again, the activity line says so", async () => {
  const { terminal, live, shows, idle, exited } = await setup([
    { error: { message: "HTTP 429: slow down", status: 429, retryable: true } },
    { text: "got through" },
  ])
  terminal.send("hi\r")
  await waitFor(() => /retrying in 1s \(1\/3\) · 429/.test(live()), "the retry line")
  await shows("got through")
  await idle()
  expect(live()).not.toContain("retrying")
  terminal.send("\x03")
  await exited
})

test("a retry reads as the status says it, when and why if the event tells", () => {
  expect(statusRetryLabel({ reason: "retrying (2/3)" })).toBe("retrying (2/3)")
  expect(statusRetryLabel({ reason: "compacting" })).toBeUndefined()
  expect(statusRetryLabel({})).toBeUndefined()
  expect(statusRetryLabel({ retry: { attempt: 2, maxRetries: 3, delayMs: 5200, status: 429 } })).toBe(
    "retrying in 6s (2/3) · 429",
  )
  expect(statusRetryLabel({ reason: "retrying (1/3)", retry: { attempt: 1 } })).toBe("retrying (1)")
})

test("the activity line shows the last line of the reasoning while the model thinks", async () => {
  let release!: () => void
  const until = new Promise<void>((r) => {
    release = r
  })
  const { terminal, live, idle, exited } = await setup(
    [{ thinking: "First, the plan.\nThen look at   a.ts\n\n", text: "done", hold: { chunks: 0, until } }],
    { cols: 100 },
  )
  terminal.send("go\r")
  await waitFor(
    () => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] thinking · \d+s · ↓ \d+ tokens · Then look at a\.ts$/m.test(live()),
    "the reasoning",
  )
  release()
  await idle()
  expect(live()).not.toContain("Then look at")
  terminal.send("\x03")
  await exited
  expect(lastReasoningLine("")).toBe("")
  expect(lastReasoningLine("a\n  b  c \n")).toBe("b c")
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
  expect(live()).toMatch(/compacting the conversation · 0s$/m)
  expect(live()).toContain("Esc interrupt")
  expect(live()).not.toContain("↓")
  expect(await compacted).toBe(true)
  await shows("second answer")
  await idle()
  expect(all()).toContain("Compacted")
  terminal.send("\x03")
  await exited
})

/** A user message and its reply, for histories. */
const exchange = (text: string): Message[] => [
  { role: "user", content: [{ type: "text", text }] },
  {
    role: "assistant",
    content: [{ type: "text", text: `re ${text}` }],
    model: { provider: "mock", model: "m1" },
  },
]

test("an automatic compaction's notice says it passed the threshold, and how far", async () => {
  const { terminal, all, shows, idle, exited } = await setup(
    [
      // 105k of the default 128k window: the next call compacts first.
      { text: "first answer", usage: { input: 105_000 } },
      { text: "SUMMARY" },
      { text: "second answer" },
    ],
    { cols: 120, history: [...exchange("a"), ...exchange("b")] },
  )
  terminal.send("q1\r")
  await shows("first answer")
  await idle()
  terminal.send("q2\r")
  await shows("second answer")
  await idle()
  expect(all()).toMatch(
    /Compacted automatically at 82% of 128k: 4 older messages into a summary \(105k → ~\d+k tokens\)\./,
  )
  terminal.send("\x03")
  await exited
})

test("a resumed compaction's summary line says why it happened", async () => {
  const { terminal, all, shows, exited } = await setup([{ text: "Fixed the parser." }], {
    cols: 100,
    history: [...exchange("a"), ...exchange("b"), ...exchange("c")],
    prepare: (agent) => agent.compact(),
  })
  await shows("▸ Compacted (you asked) · summary of earlier messages · 1 line")
  expect(all()).not.toContain("Compacted summary of earlier messages")
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
  await shows("⊘ Interrupted")
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
  // With text in the input the hint says how to break a line, not how to see the keys.
  expect(live()).toContain("Enter send · Shift+Enter newline")
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

test("a streamed reply with text-default emoji is drawn with VS16, its table aligned", async () => {
  const reply = "Got ✉ from ⚠ ops.\n\n| a | b |\n| --- | --- |\n| ✉ ☑ | x |\n| yyyy | z |"
  const { terminal, screen, shows, idle, all, exited } = await setup([{ text: reply, delayMs: 2 }])
  terminal.send("go\r")
  await shows("yyyy")
  await idle()
  expect(all()).toContain("Got ✉\uFE0F from ⚠\uFE0F ops.")
  const rows = [...screen.scrollback, ...screen.lines].filter((l) => l.includes("x") || l.includes("yyyy"))
  // Measured as the terminal draws it: ✉ with VS16 takes two cells, a bare one would take one.
  const bar = (l: string) => Bun.stringWidth(l.slice(0, l.indexOf("│")))
  const table = rows.filter((l) => l.includes("│"))
  expect(table.length).toBe(2)
  expect(bar(table[0]!)).toBe(bar(table[1]!))
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
  // In the assistant's gutter, one blank line from the prompt's band, blank rows between blocks blank.
  expect(text).toContain(`› go\n\n\n  ${markers[0]} heading\n\n  Some bold`)
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

test("the editor sits in a rounded box with the status in its border, and the caret inside", async () => {
  const { terminal, screen, live, exited } = await setup([], { cols: 30, rows: 12 })
  await waitFor(() => live().includes("Message Amira"), "input box")
  terminal.send("héllo 你好")
  await waitFor(() => live().includes("héllo 你好"), "typed text")
  const rows = screen.lines
  const top = rows.findIndex((l) => l.startsWith("╭"))
  expect(rows.slice(top, top + 3)).toEqual([
    `╭${"─".repeat(28)}╮`,
    "│ › héllo 你好               │",
    "╰─ m1 ──────────────── proj ─╯",
  ])
  expect(rows[top + 3]).toBe("Enter send")
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
  expect(rows[top]).toContain("↑ 16 rows")
  expect(rows.slice(top + 1, top + 5).map((l) => l.slice(1, -1).trim())).toEqual([
    "row 17",
    "row 18",
    "row 19",
    "row 20",
  ])
  expect(rows[top + 5]).toBe("╰─ m1 ──────────────── proj ─╯")
  // The start of the transcript is still in view: the box did not push it off.
  expect(rows[1]).toContain("Amira")
  // Moving up past the shown rows scrolls, and the border says what is below.
  for (let i = 0; i < 6; i++) terminal.send("\x1b[A")
  // The count of rows below goes into the border after the status.
  await waitFor(() => live().includes("╰─ m1 ───── proj · ↓ 3 rows ─╯"), "scrolled up")
  expect(live()).toContain("↑ 13 rows")
  expect(screen.y).toBe(top + 1)
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("a reply with only thinking shows that it thought, not that there was no reply", async () => {
  const { terminal, shows, idle, all, exited } = await setup([{ thinking: "hmm" }])
  terminal.send("go\r")
  await shows("∴ Thought for 1s")
  await idle()
  expect(all()).not.toContain("No reply")
  // Folded: the thinking itself is not shown at the summary level.
  expect(all()).not.toContain("hmm")
  terminal.send("\x03")
  await exited
})

test("a reply's thinking goes before its text", async () => {
  const { terminal, shows, idle, all, exited } = await setup([{ thinking: "first idea", text: "Answer." }])
  terminal.send("go\r")
  await shows("Answer.")
  await idle()
  expect(all()).toMatch(/∴ Thought for 1s\n\n {2}Answer\./)
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
  await shows("Extension x.ts: boom")
  await shows('Settings: f: unknown setting "colour" (ignored)')
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
  // activity line under it keeps its spinner, says what runs and the turn's time.
  expect(seenWhileRunning).toMatch(/● block +[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 0s/)
  expect(seenWhileRunning).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 1 tool running · 0s( · ↓ \d+ tokens)?$/m)
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

test("Esc with a steering message waiting stops the turn and sends the message at once", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    (req) => ({ text: `saw ${lastUserText(req)}` }),
  ])
  terminal.send("go\r")
  await shows("01234567")
  terminal.send("keep this\r")
  await waitFor(() => live().includes("steering › keep this"), "steering line")
  expect(live()).toContain("Esc send queued")
  terminal.send("\x1b[27u")
  await shows("⊘ Interrupted")
  await shows("saw keep this")
  await idle()
  expect(live()).not.toContain("steering ›")
  expect(agent.messages.filter((m) => m.role === "user").length).toBe(2)
  terminal.send("\x03")
  await exited
})

test("Esc merges the steering and queued messages into one, in the order they were typed", async () => {
  const { terminal, live, all, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    (req) => ({ text: `saw ${lastUserText(req).replace(/\n\n/g, " + ")}` }),
  ])
  terminal.send("go\r")
  await shows("01234567")
  terminal.send(`then summarize${ALT_ENTER}`)
  await waitFor(() => live().includes("queued › then summarize"), "queued line")
  terminal.send("also check b\r")
  await waitFor(() => live().includes("steering › also check b"), "steering line")
  terminal.send("\x1b[27u")
  await shows("saw then summarize + also check b")
  await idle()
  // One prompt, shown as the messages it was made of.
  expect(agent.messages.filter((m) => m.role === "user").length).toBe(2)
  expect(all()).toContain("› then summarize")
  expect(all()).toContain("› also check b")
  terminal.send("\x03")
  await exited
})

test("a message sent right after Esc goes after the messages Esc released, not before them", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    (req) => ({ text: `saw ${lastUserText(req)}` }),
    (req) => ({ text: `saw ${lastUserText(req)}` }),
  ])
  terminal.send("go\r")
  await shows("01234567")
  terminal.send(`then summarize${ALT_ENTER}`)
  await waitFor(() => live().includes("queued › then summarize"), "queued line")
  terminal.send("\x1b[27u")
  await shows("⊘ Interrupted")
  // Typed while the released message still waited out a second Esc: it does not overtake it.
  terminal.send("and then this\r")
  await shows("saw and then this")
  await idle()
  expect(userTexts(agent)).toEqual(["go", "then summarize", "and then this"])
  terminal.send("\x03")
  await exited
})

test("waiting messages take at most two rows each, and a few of them, above the input", () => {
  const long = "word ".repeat(40)
  const rows = pendingMessageRows(
    [
      { label: "steering", text: long },
      { label: "queued", text: "short" },
      { label: "queued", text: "two" },
      { label: "queued", text: "three" },
      { label: "queued", text: "four" },
    ],
    40,
    plain.theme,
  )
  expect(rows).toEqual([
    "steering › word word word word word word",
    "           word word word word word wor…",
    "queued › short",
    "queued › two",
    "+2 more waiting",
  ])
})

test("Esc twice opens the rewind picker; the message picked is cut off and back in the input", async () => {
  const rewound: number[] = []
  const { terminal, live, all, agent, shows, idle, exited } = await setup(
    [{ text: "first answer" }, { text: "second answer" }],
    {
      commands: [],
      control: {
        rewind: async (index: number) => {
          rewound.push(index)
          agent.messages.splice(index)
        },
      },
    },
  )
  terminal.send("first question\r")
  await shows("first answer")
  await idle()
  terminal.send("second question\r")
  await shows("second answer")
  await idle()
  terminal.send("\x1b[27u\x1b[27u")
  await waitFor(() => live().includes("? Rewind the conversation"), "the picker")
  // Newest first.
  expect(live()).toMatch(/❯ 1 second question\n.*2 first question/)
  terminal.send("\r")
  await shows("Files were not restored")
  expect(rewound).toEqual([2])
  expect(live()).toContain("› second question")
  expect(all()).toContain("Rewound the conversation")
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
  await shows("⊘ Interrupted")
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
  await shows("⊘ Interrupted")
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
  // Nothing is preselected: ↓ picks Yes, then Enter answers.
  terminal.send("\x1b[B\r")
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
  expect(all()).toContain("? Pick one ❯ green")
  expect(all()).toContain("? Skip me ❯ cancelled")
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
  expect(rows.filter((l) => l.trim()).at(-1)).toContain("Tab complete · Enter run · Esc close")
  expect(rows.slice(editorRow).join("\n")).not.toContain("mock/m1")
  expect(live()).not.toContain("Enter send")
  // Prefix first: "/he" puts help on top; Tab completes it, Enter runs it.
  terminal.send("he")
  await waitFor(() => live().includes("❯ /help"), "help selected")
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
    const end = lines.findIndex((l) => l.startsWith("Tab complete"))
    return end === -1 ? [] : lines.slice(start, end).map((l) => l.trimEnd())
  }
  const steps: [string, string[]][] = [
    [
      "/",
      [
        // Nothing marked on a bare "/"; names show the arguments they take.
        "  /clear                   Start a new session",
        "  /help                    List the slash commands",
        "  /model [provider/model]  Switch the model",
        "  /quit                    Leave Amira",
        "  /status                  Show the status",
      ],
    ],
    ["m", ["❯ /model [provider/model]  Switch the model"]],
    ["o", ["❯ /model [provider/model]  Switch the model"]],
    ["d", ["❯ /model [provider/model]  Switch the model"]],
    ["e", ["❯ /model [provider/model]  Switch the model"]],
    ["l", ["❯ /model [provider/model]  Switch the model"]],
    [" ", ["❯ deepseek/deepseek-flash", "  deepseek/deepseek-pro", "  openai/gpt-5"]],
    ["d", ["❯ deepseek/deepseek-flash", "  deepseek/deepseek-pro"]],
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
  await waitFor(() => live().includes("❯ /pick"), "popup")
  await Bun.sleep(40)
  const before = frames.length
  terminal.send(" ")
  await Bun.sleep(80)
  const drawn = frames.slice(before)
  expect(drawn).toHaveLength(1)
  expect(drawn[0]!.join("\n")).toContain("❯ alpha")
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
  await waitFor(() => live().includes("❯ /chatty"), "popup")
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
  await waitFor(() => live().includes("❯ openai/gpt-5"), "selection moved")
  terminal.send("\r")
  await shows("Model: openai/gpt-5")
  // Part of a candidate typed: Enter takes the best match.
  terminal.send("/model flash")
  await waitFor(() => live().includes("❯ deepseek/deepseek-flash"), "filtered")
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
  await waitFor(() => live().includes("❯ deepseek/deepseek-flash"), "candidates for deep")
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
  await waitFor(() => live().includes("❯ /model"), "popup")
  terminal.send("\r")
  await waitFor(() => live().includes("? Model"), "picker")
  terminal.send("gpt")
  await waitFor(() => live().includes("filter ❯ gpt") && !live().includes("deepseek-pro"), "filtered")
  terminal.send("\r")
  await shows("Model: openai/gpt-5")
  terminal.send("\x03")
  await exited
})

test("Esc closes the popup without leaving the text; Enter then runs what was typed", async () => {
  const log: string[] = []
  const { terminal, live, all, shows, exited } = await setup([], { commands: testCommands(log) })
  terminal.send("/sta")
  await waitFor(() => live().includes("❯ /status"), "popup")
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
  expect(live().split("╰")[1]).not.toContain("/help")
  expect(live()).toContain("Tab complete · Enter run · Esc close")
  terminal.send("rev")
  await waitFor(() => live().includes("❯ $review-pr"), "review-pr selected")
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
  await waitFor(() => live().includes("❯ $home-assistant"), "listed")
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
  await waitFor(() => live().includes("  $deploy"), "skill popup")
  expect(live()).toContain("Ctrl+Y run · Ctrl+G close")
  // A bare "$" marks nothing: the first ↓ marks the first skill.
  terminal.send("\x0e")
  await waitFor(() => live().includes("❯ $deploy"), "first marked")
  terminal.send("\x0e")
  await waitFor(() => live().includes("❯ $review-pr"), "moved down")
  terminal.send("\x0e")
  await waitFor(() => live().includes("❯ $deploy"), "wrapped")
  terminal.send("\x07")
  await waitFor(() => !live().includes("Ship it"), "closed")
  terminal.send("d")
  await waitFor(() => live().includes("❯ $deploy"), "open again")
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

test("with sub-agents running, Esc says they go on, and quitting takes a second Ctrl+C", async () => {
  const { terminal, live, all, shows, idle, exited, agent } = await setup(
    [
      { toolCalls: [{ name: "spawn_bg", args: {} }] },
      { text: "late child", delayMs: 3000 },
      { text: "never shown", delayMs: 2000 },
    ],
    { cols: 90, tree: true },
  )
  agent.tools.register(
    defineTool({
      name: "spawn_bg",
      description: "",
      parameters: {},
      execute: async (_p, ctx) => {
        ctx.session!.spawn!({ role: "explorer", title: "Look around", prompt: "look" })
        return textResult("started")
      },
    }),
    "test",
  )
  terminal.send("go\r")
  await waitFor(() => (agent.tree?.children.length ?? 0) === 1, "the child")
  await Bun.sleep(100)
  terminal.send("\x1b[27u")
  await shows("Interrupted · 1 sub-agent still running · /agents")
  await idle()
  let quit = false
  void exited.then(() => {
    quit = true
  })
  terminal.send("\x03")
  await waitFor(
    () => live().includes("1 sub-agent still running — Ctrl+C again to stop them and quit"),
    "the warning",
  )
  await Bun.sleep(50)
  expect(quit).toBe(false)
  terminal.send("\x03")
  await exited
  expect(all()).not.toContain("never shown")
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
    /● delegate\n {2}├ ◆ Outer task ✓ explorer [^\n]*outer done\n {2}│ └ ◆ Inner check ✓ explorer [^\n]*inner done\n {2}└ outer done/,
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
  const { terminal, live, all, idle, exited, agent, bus } = await setup([reply, reply, reply], {
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
  // The one it stopped may not have ended yet when the turn does.
  await waitFor(() => /Interrupted · [12] sub-agents? still running · \/agents/.test(all()), "the interrupt")
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
  // No turn runs: sub-agents working in the background bring no activity line.
  expect(live()).not.toContain("Esc interrupt")
  expect(live()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (working|running)/)
  finish()
  await child!.result()
  await bus.flush()
  await waitFor(() => !live().includes("running in background"), "the rows gone")
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

test("inline: a blank line sets the conversation apart from the shell, above the banner and after /quit", async () => {
  const { terminal, screen, shows, idle, exited } = await setup([{ text: "the answer" }], {
    commands: testCommands([]),
  })
  expect(screen.lines[0]).toBe("")
  expect(screen.lines[1]).toContain("Amira")
  terminal.send("hello\r")
  await shows("the answer")
  await idle()
  terminal.send("/quit\r")
  expect(await exited).toBe(0)
  // The cursor, where the shell's prompt goes, is a blank line under the last of it.
  expect(screen.lines[screen.y]).toBe("")
  expect(screen.lines[screen.y - 1]).toBe("")
  // (The row between is the band behind the echo.)
  expect(screen.lines[screen.y - 3]).toContain("/quit")
})

test("inline: Alt+C copies the last reply; a key of the full-screen view says so once", async () => {
  const { terminal, shows, idle, exited } = await setup([{ text: "Use **bold** here." }])
  terminal.send("\x1bc")
  await shows("Nothing to copy in the last reply.")
  terminal.send("go\r")
  await shows("Use bold here.")
  await idle()
  terminal.send("\x1bc")
  await shows("Copied the last reply")
  expect(terminal.output).toContain(`\x1b]52;c;${Buffer.from("Use **bold** here.").toString("base64")}\x07`)
  // With text in the input, Ctrl+↑ is the input's (it moves up in it): no note yet.
  terminal.send("draft")
  await shows("draft")
  terminal.send("\x1b[1;5A")
  terminal.send("\x03")
  terminal.send("\x1b[5~")
  await shows("PgUp is for full-screen mode")
  terminal.send("\x03\x03")
  await exited
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
  expect(live()).toContain("1 - old")
  expect(live()).toContain("1 + new")
  expect(live()).toContain("❯ 1 merge")
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
  expect(live()).toContain("+ line 1")
  expect(live()).toContain("+ line 54")
  expect(live()).toContain("❯ 1 merge")
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
  expect(all()).toContain("› one\n\n\n\n› two")
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
  expect(screen.lines[1]).toContain("Amira")
  terminal.send("\x03\x03")
  await exited
})

test("typing @ offers project files; Tab inserts the path and the message keeps it", async () => {
  const { terminal, agent, live, shows, idle, exited } = await setup([{ text: "read it" }], {
    files: ["src/app.ts", "src/format.ts", "README.md"],
  })
  terminal.send("look at @form")
  await waitFor(() => live().includes("❯ src/format.ts"), "file list")
  expect(live()).toContain("Tab/Enter insert")
  // Like the command list, it opens below the input box, in place of the status bar.
  const rows = live().split("\n")
  expect(rows.findIndex((l) => l.includes("❯ src/format.ts"))).toBeGreaterThan(
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
test("typing @ while the project is still listed shows a status row at once, then the files as they come", async () => {
  let emit!: (paths: string[]) => void
  let finish!: () => void
  const fileSource = new FileIndex("/work/proj", {
    list: (_cwd, e) => {
      emit = e
      return new Promise<void>((r) => {
        finish = r
      })
    },
  })
  const { terminal, live, exited } = await setup([], { fileSource, cols: 60 })
  terminal.send("see @app")
  await waitFor(() => /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] indexing… 0 files$/m.test(live()), "status row")
  // The input box took every key; the row is where the list goes, below the box.
  expect(live()).toContain("│ › see @app")
  const rows = live().split("\n")
  expect(rows.findIndex((l) => l.includes("indexing…"))).toBeGreaterThan(
    rows.findIndex((l) => l.startsWith("╰")),
  )
  emit(Array.from({ length: 12_345 }, (_, i) => `gen/f${i}.ts`).concat("src/app.ts"))
  await waitFor(
    () => /❯ src\/app\.ts/.test(live()) && live().includes("indexing… 12,346 files"),
    "first files",
  )
  finish()
  await waitFor(() => !live().includes("indexing…"), "indexed")
  expect(live()).toMatch(/❯ src\/app\.ts/)
  terminal.send("\t")
  await waitFor(() => live().includes("› see @src/app.ts"), "inserted")
  terminal.send("\x03\x03")
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
  // Focus reports stay on without the bell: extensions get them as ui.focus.
  expect(terminal.output).toContain("\x1b[?1004h")
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

test("focus reports reach extensions as ui.focus, once per change", async () => {
  const { terminal, agent, exited } = await setup([])
  const seen: boolean[] = []
  agent.bus.subscribe((e) => void (e.type === "ui.focus" && seen.push(e.data.focused)), {
    types: ["ui.focus"],
  })
  terminal.send("\x1b[O\x1b[O\x1b[I\x1b[I\x1b[O")
  await agent.bus.flush()
  expect(seen).toEqual([false, true, false])
  terminal.send("\x03")
  await exited
})

test("a narrow hint drops whole items instead of cutting one", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([{ text: "slow answer", delayMs: 40 }], {
    cols: 40,
  })
  terminal.send("go\r")
  await waitFor(() => agent.status === "working", "working")
  // The hint keeps its most useful items whole: the queue key goes first.
  await waitFor(() => /^Enter steer · Esc interrupt$/m.test(live()), "working hint")
  expect(live()).not.toContain(" queue")
  expect(live()).not.toContain("interr…")
  await shows("slow answer")
  await idle()
  await waitFor(() => /^Enter send · \? keys$/m.test(live()), "idle hint")
  terminal.send("\x03")
  await exited
})

test("keybindings replace the default keys, and the hints name them", async () => {
  const keys = new Keybindings({
    ...defaultKeys({ vscode: false }),
    queue: ["ctrl+t"],
    cancel: ["ctrl+x"],
    newline: ["ctrl+j"],
    interrupt: ["ctrl+g"],
    help: ["f1"],
  })
  const { terminal, live, agent, shows, idle, exited } = await setup(
    [{ text: "first", delayMs: 40 }, { text: "later" }],
    { keybindings: keys, cols: 100 },
  )
  await waitFor(() => live().includes("Enter send · F1 keys"), "idle hint")
  terminal.send("go")
  await waitFor(() => live().includes("Enter send · Ctrl+J newline"), "hint with text")
  terminal.send("\r")
  await waitFor(() => agent.status === "working", "working")
  await waitFor(() => live().includes("Enter steer · Ctrl+T queue · Ctrl+G interrupt"), "working hint")
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
  expect(live()).toContain("Enter accept · Ctrl+R older · Ctrl+X cancel")
  terminal.send("\x18")
  await waitFor(() => !live().includes("search history"), "search closed")
  terminal.send("\x10")
  await waitFor(() => live().includes("› old prompt"), "recalled with Ctrl+P")
  terminal.send("\x03")
  terminal.send("@src")
  // The directory named as typed first, then its file.
  await waitFor(() => live().includes("❯ src/\n  src/app.ts"), "file list")
  expect(live()).toContain("Tab/Enter insert · Ctrl+X close")
  terminal.send("\x18")
  await waitFor(() => !live().includes("src/app.ts"), "file list closed")
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

/**
 * A stand-in for the images extension's provider: `size` says what each image is (undefined:
 * it cannot be shown), encoding makes up data of the fitted size.
 */
function testImages(
  size: (input: ImageInput, ctx: ImageOpenContext) => Promise<{ width: number; height: number } | undefined>,
): ImageProvider {
  return {
    id: "test-images",
    open: async (input, ctx) => {
      const s = await size(input, ctx)
      return s && { ...s, encode: async (req) => fakePayload(req) }
    },
  }
}
/** 30×40 pixels: 3 columns and 2 rows of 10×20 cells, as Sixel draws it in whole bands. */
const CHART = { width: 30, height: 40 }
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
    images: testImages(async (input, ctx) => {
      fetched++
      expect(input).toEqual({ url: "https://img.test/chart.png" })
      expect(ctx).toMatchObject({ protocol: "sixel", cwd: "/work/proj" })
      // Slower than the lines after it take to stream: they wait for it.
      await Bun.sleep(60)
      return CHART
    }),
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
  expect(all.join("\n")).not.toContain("🖼\uFE0F chart")
  terminal.send("\x03")
  await exited
})

test("without an image provider, one that cannot open it, or tui.images off, an image is its alt text", async () => {
  const setups: ({ images?: boolean; background?: boolean } | undefined)[] = []
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
  // No images extension: the terminal could draw it, but nothing makes it drawable (D88).
  const local = await run("![secret](https://img.test/secret.png)\n\ndone", {})
  expect(local.images).toBe(0)
  // Windows Terminal makes links clickable: the URL is in the link, not shown.
  expect(local.text).toContain("  🖼\uFE0F secret\n\n  done")
  const failing = await run("![gone](https://img.test/404.png)\n\ndone", {
    images: testImages(async () => {
      throw new Error("HTTP 404")
    }),
  })
  expect(failing.images).toBe(0)
  expect(failing.text).toContain("  🖼\uFE0F gone\n\n  done")
  const off = await run("![chart](https://img.test/chart.png)\n\ndone", {
    settings: { images: "off" },
    images: testImages(async () => CHART),
  })
  expect(off.images).toBe(0)
  expect(off.text).toContain("  🖼\uFE0F chart")
  expect(setups).toEqual([
    { images: true, background: true },
    { images: true, background: true },
    { images: false, background: true },
  ])
  // Without Sixel in the terminal's answer, "auto" draws none either.
  const text = await run("![chart](https://img.test/chart.png)\n\ndone", {
    graphics: { answered: true, sixel: false, kitty: false },
    images: testImages(async () => CHART),
  })
  expect(text.images).toBe(0)
})

test("an image slower than its time is committed as its alt text, and what follows goes on", async () => {
  const { terminal, screen, all, shows, idle, exited } = await setup(
    [{ text: "![slow](https://img.test/slow.png)\n\nafter it" }],
    {
      env: WT,
      graphics: SIXEL,
      images: testImages(
        (_input, { signal }) =>
          new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      ),
    },
  )
  terminal.send("go\r")
  await shows("after it")
  await idle()
  // Both show in the live region while waiting, then go to the scrollback as they were.
  await Bun.sleep(3300)
  expect(all()).toContain("  🖼\uFE0F slow\n\n  after it")
  expect(screen.images).toEqual([])
  terminal.send("\x03")
  await exited
}, 10_000)

// --- Markdown renderers of extensions (D88)

/** A renderer of ```box blocks: each line of the code in a frame, after `delayMs` when given. */
function boxRenderer(calls: { code: string; width: number }[], delayMs?: number): MarkdownRendererDefinition {
  const draw = (code: string) => {
    const lines = code.split("\n")
    const w = Math.max(...lines.map((l) => l.length))
    return {
      lines: [
        { kind: "accent" as const, text: `┌${"─".repeat(w + 2)}┐` },
        ...lines.map((l) => ({ kind: "code" as const, text: `│ ${l.padEnd(w)} │` })),
        { kind: "accent" as const, text: `└${"─".repeat(w + 2)}┘` },
      ],
    }
  }
  return {
    id: "box",
    match: { codeLang: ["box"] },
    render: (node, ctx) => {
      if (node.type !== "code") return undefined
      calls.push({ code: node.code, width: ctx.width })
      return delayMs === undefined ? draw(node.code) : Bun.sleep(delayMs).then(() => draw(node.code))
    },
  }
}

test("inline: a code block an extension renders is committed once as its lines, in order; others stay code", async () => {
  const calls: { code: string; width: number }[] = []
  const markers = ["L1", "L2", "L3"]
  const check = transcriptChecker(markers)
  const text = "line L1\n\n```box\nA --> B\nB --> C\n```\n\nline L2\n\n```js\nx()\n```\n\nline L3"
  const { terminal, screen, all, shows, idle, exited } = await setup([{ text, delayMs: 2 }], {
    cols: 40,
    rows: 24,
    markdown: [boxRenderer(calls)],
    onWrite: (s) => check.onWrite(s),
  })
  terminal.send("go\r")
  await shows("line L3")
  await idle()
  expect(check.problems).toEqual([])
  check.final(screen)
  expect(all()).toContain(
    [
      "  line L1",
      "",
      "  ┌─────────┐",
      "  │ A --> B │",
      "  │ B --> C │",
      "  └─────────┘",
      "",
      "  line L2",
    ].join("\n"),
  )
  expect(all()).toContain("  ╭─ js\n  │ x()\n  ╰─")
  expect(all()).not.toContain("╭─ box")
  // Asked once, when it closed, for the reply's width less its indent.
  expect(calls).toEqual([{ code: "A --> B\nB --> C", width: 38 }])
  terminal.send("\x03")
  await exited
})

test("inline: a rendering on its way holds what follows; one that takes too long goes as the code", async () => {
  const calls: { code: string; width: number }[] = []
  const late = await setup([{ text: "```box\nlate\n```\n\nafter it" }], {
    markdown: [boxRenderer(calls, 80)],
  })
  late.terminal.send("go\r")
  await late.shows("after it")
  await late.idle()
  await waitFor(() => late.all().includes("│ late │"), "the rendering")
  const text = late.all()
  expect(text.indexOf("│ late │")).toBeLessThan(text.indexOf("after it"))
  expect(text).not.toContain("╭─ box")
  late.terminal.send("\x03")
  await late.exited
  // Slower than its renderer's time: the code block is committed, and what follows goes on.
  const slow = await setup([{ text: "```box\nslow\n```\n\nafter it" }], {
    markdown: [{ ...boxRenderer([], 5000), waitMs: 100 }],
  })
  slow.terminal.send("go\r")
  await slow.shows("after it")
  await slow.idle()
  await Bun.sleep(200)
  expect(slow.all()).toContain("  ╭─ box\n  │ slow\n  ╰─\n\n  after it")
  slow.terminal.send("\x03")
  await slow.exited
})

test("inline: a resumed history renders its blocks through extensions too, in order, waiting for late ones", async () => {
  const calls: { code: string; width: number }[] = []
  const reply = (text: string): Message => ({
    role: "assistant",
    content: [{ type: "text", text }],
    model: { provider: "mock", model: "m1" },
  })
  const { terminal, all, exited } = await setup([], {
    rows: 40,
    markdown: [boxRenderer(calls, 60)],
    history: [
      { role: "user", content: [{ type: "text", text: "draw" }] },
      reply("First:\n\n```box\nA\n```\n\nafter A"),
      reply("```box\nB\n```\n\nafter B"),
    ],
  })
  await waitFor(() => all().includes("── resumed"), "history")
  // Meanwhile what waits for them shows below as it is, the blocks as code.
  await waitFor(() => all().includes("│ B │"), "the renderings")
  await Bun.sleep(50)
  const text = all()
  expect(text).toContain("  First:\n\n  ┌───┐\n  │ A │\n  └───┘\n\n  after A")
  expect(text).toContain("  ┌───┐\n  │ B │\n  └───┘\n\n  after B")
  expect(text).not.toContain("╭─ box")
  expect(calls.map((c) => c.code)).toEqual(["A", "B"])
  terminal.send("\x03")
  await exited
})

test("inline: a renderer's image goes to the image providers; a renderer that throws leaves the code", async () => {
  const opened: string[] = []
  const errors: string[] = []
  const { terminal, screen, all, shows, idle, exited, bus } = await setup(
    [{ text: "```chart\npie\n```\n\n```broken\nx\n```\n\ndone" }],
    {
      env: WT,
      graphics: SIXEL,
      images: testImages(async (input) => {
        opened.push("data" in input ? new TextDecoder().decode(input.data) : input.url)
        return CHART
      }),
      markdown: [
        {
          id: "chart",
          match: { codeLang: ["chart"] },
          render: async () => ({ image: { data: new TextEncoder().encode("png of pie") } }),
        },
        {
          id: "broken",
          match: { codeLang: ["broken"] },
          render: () => {
            throw new Error("no parser")
          },
        },
      ],
    },
  )
  bus.subscribe((e) => {
    if (e.type === "extension.error") errors.push((e.data as { error: string }).error)
  })
  terminal.send("go\r")
  await shows("done")
  await idle()
  await waitFor(() => screen.images.length > 0, "the image")
  expect(opened).toEqual(["png of pie"])
  expect(screen.images).toEqual([expect.objectContaining({ protocol: "sixel", rows: 2, cols: 3 })])
  expect(all()).toContain("  ╭─ broken\n  │ x\n  ╰─")
  await waitFor(() => errors.length > 0, "the error")
  expect(errors).toEqual(['markdown renderer "broken" failed: no parser'])
  terminal.send("\x03")
  await exited
})

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
    // How to fold them is in the key reference, not the hint.
    expect(live()).not.toContain("fold panels")
    terminal.send("\x14")
    await waitFor(() => !live().includes("› test it"), `${mode}: folded`)
    expect(live()).toContain("Todos 1/3")
    // Folded, the hint says how to unfold them.
    expect(live()).toContain("Ctrl+T unfold panels")
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

test("live panels give way on a short screen: folded, then cut, the input box always shown", async () => {
  for (const mode of ["fullscreen", "inline"] as const) {
    const items = Array.from({ length: 9 }, (_, i) => `• step ${i + 1}`)
    const { terminal, live, exited } = await setup([], {
      cols: 70,
      rows: 12,
      settings: { mode },
      panels: [
        {
          id: "todo",
          render: () => [
            { kind: "muted", text: "Todos 0/9" },
            ...items.map((text) => ({ kind: "text" as const, text })),
          ],
        },
      ],
    })
    await waitFor(() => live().includes("Todos 0/9"), `${mode}: the panel`)
    const rows = live().split("\n")
    // Folded to its header, since the whole list does not fit; the input box and hints stay.
    expect(live()).not.toContain("step 1")
    expect(rows.some((r) => r.startsWith("╰"))).toBe(true)
    expect(rows.some((r) => r.includes("Enter send · ? keys"))).toBe(true)
    terminal.send("\x04")
    await exited
  }
})

test("an extension's notice shows in the transcript", async () => {
  const { host, shows, terminal, exited } = await setup([])
  await host.load((api) => api.notify("hook prettier · a.ts · ok", "success"), "ext:hooks")
  await shows("✓ hook prettier · a.ts · ok")
  terminal.send("\x03")
  await exited
})

const BORDER = /^╰─.*─╯$/m

test("the status goes under a dialog that takes the input box's place, and back into the border", async () => {
  for (const mode of ["inline", "fullscreen"] as const) {
    const { terminal, live, host, bus, exited } = await setup([], { settings: { mode } })
    bus.emit(
      "workspace.changed",
      { cwd: "/work/proj", repoRoot: "/work/proj", branch: "main", dirty: true },
      {
        sessionId: "host",
      },
    )
    await waitFor(() => /^╰─ m1 ─+ main\* ─╯$/m.test(live()), `${mode}: the status in the border`)
    const answer = host.ui.api("x").confirm("Proceed?")
    await waitFor(() => live().includes("Proceed?"), `${mode}: the dialog`)
    const rows = live().split("\n")
    // No input box: the status is a line of its own under the dialog, the hint is gone.
    expect(rows.some((r) => r.startsWith("╰"))).toBe(false)
    const status = rows.findIndex((r) => /^m1 {2,}main\*$/.test(r))
    expect(status).toBeGreaterThan(rows.findIndex((r) => r.includes("Proceed?")))
    expect(live()).not.toContain("Enter send")
    terminal.send("\x1b[27u")
    expect(await answer).toBeUndefined()
    await waitFor(() => BORDER.test(live()) && live().includes("main* ─╯"), `${mode}: back in the border`)
    expect(live()).not.toMatch(/^m1 {2,}main\*$/m)
    terminal.send("\x03")
    await exited
  }
})

test("a command list below the input box leaves the status in the border", async () => {
  const { terminal, live, exited } = await setup([], { commands: testCommands([]) })
  terminal.send("/")
  await waitFor(() => live().includes("Tab complete · Enter run · Esc close"), "the list")
  expect(live()).toMatch(/^╰─ m1 ─+ proj ─╯$/m)
  terminal.send("\x03\x03")
  await exited
})

test("the status in the border keeps to the width and drops items by priority, in both modes", async () => {
  for (const mode of ["inline", "fullscreen"] as const) {
    for (const cols of [100, 44, 34, 12]) {
      const { terminal, live, agent, bus, idle, exited } = await setup(
        [{ text: "ok", usage: { input: 108_800, output: 0, cost: 0.042 } }],
        { cols, settings: { mode } },
      )
      bus.emit(
        "workspace.changed",
        { cwd: "/work/proj", repoRoot: "/work/proj", branch: "feat/x", dirty: true },
        {
          sessionId: agent.sessionId,
        },
      )
      terminal.send("go\r")
      await idle()
      const border = () =>
        live()
          .split("\n")
          .find((r) => r.startsWith("╰")) ?? ""
      await waitFor(() => border().includes("m1") || cols < 16, `${mode} ${cols}: the status`)
      const line = border()
      expect([mode, cols, line.length]).toEqual([mode, cols, cols])
      expect(line.endsWith("╯")).toBe(true)
      for (const row of live().split("\n")) expect(row.length).toBeLessThanOrEqual(cols)
      const shown = ["m1", "ctx 109k/128k (85%)", "$0.042", "feat/x*"].filter((t) => line.includes(t))
      // Whole items only, the lowest priority gone first.
      expect([mode, cols, shown]).toEqual([
        mode,
        cols,
        ["m1", "ctx 109k/128k (85%)", "$0.042", "feat/x*"].slice(
          0,
          cols >= 100 ? 4 : cols >= 44 ? 3 : cols >= 34 ? 2 : 1,
        ),
      ])
      terminal.send("\x03")
      await exited
    }
  }
})

test("? opens the key reference on an empty input; it lists every action with its keys and Esc closes it", async () => {
  for (const mode of ["inline", "fullscreen"] as const) {
    const keys = new Keybindings({ ...defaultKeys({ vscode: false }), queue: ["ctrl+t"] })
    const { terminal, live, exited } = await setup([], { settings: { mode }, keybindings: keys, rows: 20 })
    await waitFor(() => live().includes("Enter send · ? keys"), `${mode}: the hint`)
    terminal.send("?")
    await waitFor(() => live().includes("? Keys"), `${mode}: the reference`)
    const text = live()
    expect(text).toContain("To change a key, map the action name")
    expect(text).toMatch(/^Input$/m)
    // The keys bound now, all of them, next to what they do.
    expect(text).toMatch(/^ {2}Enter +Send the message/m)
    expect(text).toMatch(/^ {2}Ctrl\+T +While a turn runs, send the message/m)
    // Keys that do not fit the column go on under it; the action's name follows its description.
    expect(text).toMatch(/^ {2}Shift\+Enter, +Insert a line break · newline\n {2}Ctrl\+Enter$/m)
    expect(text).toMatch(/↑↓ PgUp PgDn Home End scroll · Esc close$/m)
    // It scrolls to the end, where the last group is.
    terminal.send("\x1b[F")
    await waitFor(() => /^end · /m.test(live()), `${mode}: scrolled to the end`)
    // The transcript's keys are listed only where the full-screen view has them.
    expect(live().includes("Text selected with the mouse")).toBe(mode === "fullscreen")
    terminal.send("\x1b[27u")
    await waitFor(() => live().includes("Enter send · ? keys"), `${mode}: closed`)
    expect(live()).not.toContain("? Keys")
    // With text in the input, ? is typed.
    terminal.send("a?")
    await waitFor(() => live().includes("› a?"), `${mode}: typed`)
    expect(live()).not.toContain("? Keys")
    terminal.send("\x03\x03")
    await exited
  }
})

test("the input's editing keys: Ctrl+W and Ctrl+U cut, Ctrl+Y pastes back, Ctrl+Z undoes", async () => {
  const { terminal, live, exited } = await setup([])
  terminal.send("one two three")
  await waitFor(() => live().includes("one two three"), "typed")
  terminal.send("\x17")
  await waitFor(() => live().includes("› one two ") && !live().includes("three"), "word cut")
  terminal.send("\x15")
  await waitFor(() => !live().includes("one two"), "line cut")
  terminal.send("\x19")
  await waitFor(() => live().includes("one two"), "pasted back")
  terminal.send("\x1a")
  await waitFor(() => !live().includes("one two"), "undone")
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("Ctrl+G edits the message in $VISUAL and takes the text back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amira-editor-"))
  const script = join(dir, "fake-editor.ts")
  writeFileSync(
    script,
    'import { appendFileSync } from "node:fs"\nappendFileSync(process.argv[2]!, " and more\\n")\n',
  )
  try {
    const { terminal, live, exited } = await setup([], {
      env: { VISUAL: `"${process.execPath}" "${script}"` },
    })
    terminal.send("draft")
    await waitFor(() => live().includes("› draft"), "typed")
    terminal.send("\x07")
    await waitFor(() => live().includes("› draft and more"), "edited")
    terminal.send("\x03")
    terminal.send("\x03")
    await exited
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("full screen, the input box stays put while the list under it gets shorter", async () => {
  const { terminal, live, screen, exited } = await setup([], {
    commands: testCommands([]),
    settings: { mode: "fullscreen" },
  })
  const boxTop = () => screen.lines.findIndex((l) => l.startsWith("╭"))
  terminal.send("/")
  await waitFor(() => live().includes("/status"), "the list")
  const top = boxTop()
  terminal.send("mo")
  await waitFor(() => live().includes("❯ /model") && !live().includes("/status"), "narrowed")
  expect(boxTop()).toBe(top)
  // Closed, the rows it kept go too.
  terminal.send("\x1b[27u")
  await waitFor(() => !live().includes("Switch the model"), "closed")
  expect(boxTop()).toBeGreaterThan(top)
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("commands get the common keys as bound now, for /help; the transcript's only full screen", async () => {
  for (const mode of ["inline", "fullscreen"] as const) {
    const { terminal, shows, all, exited } = await setup([], {
      cols: 120,
      settings: { mode },
      commands: [
        {
          name: "keys",
          description: "List the keys",
          run: (_a, ctx) =>
            ctx.print((ctx.keys?.() ?? []).map((k) => `${k.keys}=${k.description}`).join("\n")),
        },
      ],
    })
    terminal.send("/keys\r")
    await shows("Enter=Send the message; while a turn runs, steer it")
    expect(all()).toContain("Ctrl+R=Search the prompts sent before")
    expect(all()).toContain("Esc=Stop the turn; twice in a row, rewind to an earlier message")
    expect(all()).toContain("?=Every key and what it does")
    if (mode === "fullscreen") expect(all()).toContain("Ctrl+F=Find text in the transcript")
    else expect(all()).not.toContain("Find text in the transcript")
    terminal.send("\x03")
    await exited
  }
})
