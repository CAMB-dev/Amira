import { expect } from "bun:test"
import { createAi, createMockDialect, type MockStep, NO_MODEL, userMessage } from "@amira/ai"
import {
  type AnyEvent,
  type CommandDefinition,
  defineTool,
  type Extension,
  type ImageProvider,
  type InputHandler,
  type MarkdownRendererDefinition,
  type Message,
  type PanelDefinition,
  type SessionControl,
  type SkillDefinition,
  type TuiSettings,
  textResult,
} from "@amira/api"
import type { SessionStore } from "@amira/core"
import {
  Agent,
  AgentTree,
  CommandHost,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  ToolRegistry,
} from "@amira/core"
import { FakeTerminal, type GraphicsReplies } from "@amira/tui-kit"
import { builtinPresenters } from "../../../extensions/builtin-tools/src/index.ts"
import statusExtension from "../../../extensions/status/src/index.ts"
import terminalStatusExtension from "../../../extensions/terminal-status/src/index.ts"
import { VirtualScreen } from "../../tui-kit/test/screen.ts"
import { runInteractive } from "../src/app.ts"
import { type FileSource, fileList } from "../src/file-index.ts"
import type { ClipboardContent } from "../src/image-input.ts"
import type { Keybindings } from "../src/keybindings.ts"
import type { PromptHistory } from "../src/prompt-history.ts"

export const noProbe = async () => ({
  capabilities: { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
  leftoverInput: "",
})

/** Alt+Enter in the kitty keyboard protocol. */
export const ALT_ENTER = "\x1b[13;3u"
/** Windows terminals keep Alt+Enter for fullscreen, so the hint names Ctrl+Q there. */
export const QUEUE_HINT = process.platform === "win32" ? "Ctrl+Q" : "Alt+Enter"

export async function waitFor(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

export interface SetupOptions {
  cwd?: string
  acceptsImages?: boolean
  clipboard?: (cwd: string, signal: AbortSignal) => Promise<ClipboardContent>
  session?: SessionStore
  cols?: number
  rows?: number
  initialPrompt?: string
  leftoverInput?: string
  startupEvents?: AnyEvent[]
  /** Slash commands to offer; the UI gets a CommandHost when given. */
  commands?: CommandDefinition[]
  aliases?: Record<string, string>
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
  /** Extensions to load (their commands and views are offered), as the CLI loads them. */
  extensions?: Extension[]
  /** Background jobs running, as the CLI tells the UI. */
  runningJobs?: () => number
  noBuiltins?: boolean
}

export async function setup(steps: MockStep[], o: SetupOptions = {}) {
  const bus = new EventBus()
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools })
  await host.load(statusExtension, "builtin:status")
  if (!o.noBuiltins) await host.load(terminalStatusExtension, "builtin:terminal-status")
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers:
      o.noModel === "none"
        ? []
        : [
            {
              id: "mock",
              dialect: "mock",
              baseUrl: "",
              defaultModel: { contextWindow: 128_000, caps: { images: o.acceptsImages ?? false } },
            },
          ],
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
    cwd: o.cwd ?? "/work/proj",
    ...(o.session ? { session: o.session } : {}),
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
  for (const [i, ext] of (o.extensions ?? []).entries()) await host.load(ext, `test-ext-${i}`)
  if (o.commands || o.extensions) {
    await host.load((api) => {
      for (const c of o.commands ?? []) api.registerCommand(c)
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
      ...(o.aliases ? { aliases: o.aliases } : {}),
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
    bindTerminal: (terminal) => host.bindTerminal(terminal),
    agent,
    status: host.status,
    panels: host.panels,
    ui: host.ui,
    ...(commands ? { commands } : {}),
    ...(o.tuiCommands ? { registerCommand: (c) => host.commands.register(c, "builtin:tui") } : {}),
    ...(o.presenters ? { toolRenderers: host.renderers } : {}),
    ...(o.extensions ? { views: host.views } : {}),
    ...(o.runningJobs ? { runningJobs: o.runningJobs } : {}),
    terminal,
    setup: async (_t, _env, setupOpts) => {
      o.onSetup?.(setupOpts)
      const probed = await noProbe()
      const graphics = setupOpts?.images && o.graphics ? { graphics: o.graphics } : {}
      return { capabilities: { ...probed.capabilities, ...graphics }, leftoverInput: o.leftoverInput ?? "" }
    },
    imageProviders: host.images,
    ...(o.clipboard ? { clipboard: o.clipboard } : {}),
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

export const INPUT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXZkAAAAASUVORK5CYII="
export const inputImage = (name = "photo.png") => ({ name, mimeType: "image/png", data: INPUT_PNG })
export const paste = (text: string) => `\x1b[200~${text}\x1b[201~`

export async function closeImageApp(s: Awaited<ReturnType<typeof setup>>) {
  s.agent.abort()
  await s.idle()
  s.terminal.send("\x03\x03")
  expect(await s.exited).toBe(0)
}

export const parallel = { description: "", parameters: {}, concurrency: "parallel" as const }

export const exchange = (text: string): Message[] => [
  { role: "user", content: [{ type: "text", text }] },
  {
    role: "assistant",
    content: [{ type: "text", text: `re ${text}` }],
    model: { provider: "mock", model: "m1" },
  },
]

export const userTexts = (agent: Agent) =>
  agent.messages.flatMap((m) =>
    m.role === "user" ? [m.content.map((b) => (b.type === "text" ? b.text : "")).join("")] : [],
  )

export const lastUserText = (req: { messages: { role: string; content: unknown }[] }) => {
  const m = req.messages.at(-1)!
  return m.role === "user" ? (m.content as { text: string }[])[0]!.text : m.role
}

export const MODELS = ["deepseek/deepseek-flash", "deepseek/deepseek-pro", "openai/gpt-5"]

/** Commands like the built-in ones, enough to drive the popup. */
export function testCommands(log: string[]): CommandDefinition[] {
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

/** A skill like the skills extension's: it sends its text, shown as the line typed. */
export function testSkill(name: string, description: string): SkillDefinition {
  return {
    name,
    description,
    run: (args, ctx) =>
      ctx.session.send(`SKILL ${name} BODY ${args}`, {
        display: { text: `$${name}${args ? ` ${args}` : ""}`, note: `Loaded skill ${name} (3 lines)` },
      }),
  }
}

export async function skillSetup(steps: MockStep[], o: SetupOptions = {}) {
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

/**
 * Follows markers (L1, P2, ...) through a transcript. After every write, the markers on screen or
 * in the scrollback must have no hole: a hole means a line was drawn and then lost off the top of
 * the live region, to be printed again later — the view jumps back up when that happens.
 */
export function transcriptChecker(markers: string[]) {
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
