// Owns interactive options, shared UI constants and startup helpers.
import { homedir } from "node:os"
import type { AnyEvent, CommandDefinition, ShimmerEffect, TerminalApi, TuiSettings } from "@amira/api"
import {
  type Agent,
  type AgentPort,
  type CommandHost,
  type CommandRunOptions,
  createLocalAgentPort,
  type PanelRegistry,
  type StatusRegistry,
  type ThemeRegistry,
  type UiRequests,
} from "@amira/core"
import type { EditorImage, InputEvent, SetupResult, Terminal, Theme, ThemeVariant } from "@amira/tui-kit"
import { applyClockSetting } from "../clock.ts"
import type { ViewSource } from "../extension-view.ts"
import type { FileSource } from "../file-index.ts"
import { glyphs } from "../glyphs.ts"
import type { ClipboardContent } from "../image-input.ts"
import type { Keybindings } from "../keybindings.ts"
import type { ImageSource, MarkdownRenderSource } from "../markdown-nodes.ts"
import type { PromptHistory } from "../prompt-history.ts"
import type { PresenterSource } from "../tool-view.ts"
import type { TranscriptView } from "../view.ts"
import type { FrontendConversationRef, FrontendConversationSource } from "./frontend-focus.ts"
import type { OverlayRequestBackend } from "./overlays.ts"

export type FrontendEffect =
  | { readonly kind: "detach" | "rewind" | "unfocus" }
  | { readonly kind: "view"; readonly view: "background-job" | "subagent"; readonly id: string }
  | ({ readonly kind: "focus" } & FrontendConversationRef)

export interface InteractiveOptions {
  agent?: Agent
  /** Host-owned display reads. Omitted by local embedders: composed for this UI's lifetime. */
  frontend?: AgentPort
  /** Finite, live command effects only; replay must not re-open views or change focus. */
  subscribeFrontendEffects?: (listener: (effect: FrontendEffect) => void) => () => void
  /** Optional invocation-scoped command callbacks, owned by a transport adapter. */
  bindCommandFrontend?: (invocationId: string, options: CommandRunOptions) => () => void
  /** Cached DTO-backed owned-conversation reads and events; no executable remote handles. */
  conversations?: FrontendConversationSource
  status: StatusRegistry
  /** Live panels registered by extensions, shown above the activity line. */
  panels?: PanelRegistry
  /** Extension dialogs, answered inline. Without it they are left to other frontends. */
  ui?: UiRequests
  /** Transport-backed dialogs/forms; presentation reads its cached lifecycle state. */
  requests?: OverlayRequestBackend
  /**
   * Slash commands and their completion popup. It owns the active session: the UI follows
   * the agent it switches to (/clear, /resume).
   */
  commands?: CommandHost
  /** Cached command/skill metadata and asynchronous completion, without a local command host. */
  completions?: Pick<
    CommandHost,
    "complete" | "list" | "completeSkill" | "skills" | "inputLine" | "skillLine"
  >
  /**
   * Adds the TUI's own slash commands (/verbose) to the registry `commands` runs from; the
   * returned function removes them again when the UI quits.
   */
  registerCommand?: (command: CommandDefinition) => () => void
  /** Presenters of tool calls registered by extensions (D1); unknown tools use a generic one. */
  toolRenderers?: PresenterSource
  /** Full-screen view kinds registered by extensions, which commands open with openView. */
  views?: ViewSource
  /** Events emitted before the UI subscribed, such as extension load errors. */
  startupEvents?: AnyEvent[]
  /** Sent as the first message once the UI is up. */
  initialPrompt?: string
  /** Pick a stored session before starting; cancellation exits instead of leaving an unsaved chat. */
  resumePicker?: boolean
  /** Shown as a warning under the banner, e.g. that no model is selected yet. */
  notice?: string
  /** Called once the UI listens to the bus, e.g. to announce the session. */
  onReady?: () => void
  /** Binds terminal effects before session.start; the returned function detaches on quit. */
  bindTerminal?: (terminal: TerminalApi) => () => void
  terminal?: Terminal
  /** Terminal setup; injectable for tests. Defaults to probing the real terminal. */
  setup?: (
    terminal: Terminal,
    env?: Record<string, string | undefined>,
    opts?: { images?: boolean; background?: boolean },
  ) => Promise<SetupResult>
  theme?: Theme
  /** Named themes, live across file reloads and extension registration/disposal. */
  themes?: Pick<ThemeRegistry, "get" | "list" | "subscribe"> & Partial<Pick<ThemeRegistry, "source">>
  /**
   * Persists applied choices only. Omitted shimmer preserves it; explicit undefined removes
   * the override. Preview and cancellation never call this.
   */
  saveTheme?: (name: string, variant: ThemeVariant, shimmer?: ShimmerEffect) => void | Promise<void>
  /** Delivers reloaded theme, appearance and shimmer settings to the running UI. */
  subscribeThemeSettings?: (listener: (settings: TuiSettings | undefined) => void) => () => void
  /**
   * Prompts sent before, for ↑/↓ and Ctrl+R; the CLI passes the project's persisted history.
   * Default: one kept in memory for this run.
   */
  history?: PromptHistory
  /** The files the @ picker offers. Default: the working directory's, from git or a walk. */
  files?: FileSource
  /** Host-owned sources for focused conversation working directories; never walk them locally. */
  filesForCwd?: (cwd: string) => FileSource
  /** Local clipboard/editor cwd, independent of a remote workspace or focused conversation. */
  localCwd?: string
  /** Explicit workspace image read. A remote frontend must supply this instead of local IO. */
  readWorkspaceImage?: (cwd: string, path: string, signal: AbortSignal) => Promise<EditorImage>
  /** The keys of every action; defaults to the defaults for this terminal. See loadKeybindings. */
  keybindings?: Keybindings
  /** The `tui` settings: bell, title, progress indicator, reflow, what Enter does while working. */
  settings?: TuiSettings
  /** @deprecated Ignored: the UI always runs fullscreen. Inline requests show a removal notice. */
  mode?: "fullscreen" | "inline"
  /** Tells the terminal apart (Windows Terminal, VS Code); injectable for tests. */
  env?: Record<string, string | undefined>
  /** Image providers registered by extensions (D88); without one, images are their alt text. */
  imageProviders?: ImageSource
  /** Clipboard reader; injectable without OS clipboard access in tests. */
  clipboard?: (cwd: string, signal: AbortSignal) => Promise<ClipboardContent>
  /** Markdown renderers registered by extensions (D88), e.g. diagrams for ```mermaid blocks. */
  markdownRenderers?: MarkdownRenderSource
  /**
   * How many background jobs (commands the shell tools run in the background) are running
   * now. Quitting while some run asks first, as it does for sub-agents; they stop on exit.
   */
  runningJobs?: () => number
}

/** Shared startup directions, limited to capabilities this frontend actually supplies. */
export function startupDirections(
  view: Pick<TranscriptView, "banner">,
  keys: Keybindings,
  commands: boolean,
) {
  const helpKey = keys.label("help")
  const starts = [
    commands && "/help commands",
    "@ files",
    commands && "$ skills",
    helpKey && `${helpKey} keys`,
  ].filter(Boolean)
  view.banner((theme) => theme.muted(starts.join(` ${glyphs.separator} `)))
}

/** Local embedding compatibility; the CLI normally supplies its own port. */
export async function withFrontend<T>(
  opts: InteractiveOptions,
  run: (opts: InteractiveOptions & { frontend: AgentPort }) => Promise<T>,
): Promise<T> {
  if (!opts.frontend && !opts.agent) throw new Error("Interactive UI requires a frontend or local agent")
  const frontend = opts.frontend ?? createLocalAgentPort({ agent: opts.agent!, commands: opts.commands })
  const restoreClock = applyClockSetting(opts.settings?.clock)
  try {
    return await run({ ...opts, frontend })
  } finally {
    restoreClock()
    if (!opts.frontend) await frontend.detach()
  }
}

/** One notice for either legacy inline request, even when both the flag and setting are present. */
export function inlineModeNotice(opts: Pick<InteractiveOptions, "mode" | "settings">): string | undefined {
  if (opts.mode === "inline" || opts.settings?.mode === "inline") {
    return "inline mode was removed; running fullscreen. Use -p for plain output."
  }
  return undefined
}

/** Startup warnings not already explained by the no-provider welcome card. */
export function startupNotices(opts: InteractiveOptions, welcome: boolean): string[] {
  return [
    opts.notice && !(welcome && opts.notice.startsWith("No providers")) ? opts.notice : undefined,
    inlineModeNotice(opts),
  ].filter((notice): notice is string => !!notice)
}

/** The renderer's shortest time between frames, and how long a key waits for async candidates. */
export const FRAME_MS = 16

/** Bracketed pastes this big become one placeholder in the editor, expanded when sent. */
export const FOLD_PASTES = { lines: 8, chars: 1000 }

/** Events without a turn that the UI shows whatever session emitted them. */
export const HOST_EVENTS = new Set<string>([
  "extension.error",
  "extension.notice",
  "ui.render",
  "extension.loaded",
  "ui.request",
  "ui.resolved",
])

/** How long a note such as "Tool output: full" replaces the key hints. */
export const HINT_NOTE_MS = 4000

/** Two presses of the interrupt key (Esc) within this many ms are a double press: rewind. */
export const DOUBLE_ESC_MS = 500

/** The start of the rewind picker's request id, which the UI asks itself rather than an extension. */
export const REWIND_ID = "tui-rewind-"

/** The steps to a first message, shown at startup while no provider is configured. */
export function welcomeCard(): string {
  return [
    "Welcome to Amira. Three steps to a first message:",
    "1. Add a provider: /provider add",
    "2. Pick one of its models: /model",
    "3. Ask away: @ mentions files, /help lists the commands and keys",
  ].join("\n")
}

/** `path` with the home directory as "~", as shells write it. */
export function tildePath(
  path: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  // On Windows the profile is the home; a HOME some shell set (Git Bash, MSYS) may spell it
  // another way ("/c/Users/…") and would never match the cwd.
  const candidates = platform === "win32" ? [env.USERPROFILE, env.HOME] : [env.HOME, env.USERPROFILE]
  const home = (candidates.find((h) => h?.trim()) || homedir()).replace(/[\\/]+$/, "")
  if (!home) return path
  const sep = path.charAt(home.length)
  const same =
    platform === "win32"
      ? path.slice(0, home.length).toLowerCase() === home.toLowerCase()
      : path.startsWith(home)
  return same && (sep === "" || sep === "/" || sep === "\\") ? `~${path.slice(home.length)}` : path
}

/** Legacy overlays get wheel arrows; declarative overlays keep original pointer coordinates. */
export function overlayKeys(e: InputEvent, pointer = false): InputEvent[] {
  if (pointer || e.type !== "mouse") return [e]
  if (e.action !== "wheel" || (e.button !== "up" && e.button !== "down")) return []
  const k: InputEvent = { type: "key", name: e.button, ctrl: false, shift: false, alt: false }
  return [k, k, k]
}

/**
 * Opens the session picker for `amira -r`. When it ends without switching sessions (cancelled or
 * unavailable), quits: the temporary host must not stay open as a fresh session.
 */
export function resumeAtStartup(deps: {
  run(line: string): Promise<void>
  agent(): unknown
  quit(): void
}): void {
  const initial = deps.agent()
  void deps.run("/resume").then(() => {
    if (deps.agent() === initial) deps.quit()
  })
}
