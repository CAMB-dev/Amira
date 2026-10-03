import { homedir } from "node:os"
import type { AnyEvent, CommandDefinition, TerminalApi, TuiSettings } from "@amira/api"
import type { Agent, CommandHost, PanelRegistry, StatusRegistry, UiRequests } from "@amira/core"
import type { InputEvent, SetupResult, Terminal, Theme } from "@amira/tui-kit"
import type { ViewSource } from "../extension-view.ts"
import type { FileSource } from "../file-index.ts"
import type { ClipboardContent } from "../image-input.ts"
import type { Keybindings } from "../keybindings.ts"
import type { ImageSource, MarkdownRenderSource } from "../markdown-nodes.ts"
import type { PromptHistory } from "../prompt-history.ts"
import type { PresenterSource } from "../tool-view.ts"

export interface InteractiveOptions {
  agent: Agent
  status: StatusRegistry
  /** Live panels registered by extensions, shown above the activity line in both modes. */
  panels?: PanelRegistry
  /** Extension dialogs, answered inline. Without it they are left to other frontends. */
  ui?: UiRequests
  /**
   * Slash commands and their completion popup. It owns the active session: the UI follows
   * the agent it switches to (/clear, /resume).
   */
  commands?: CommandHost
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
  /**
   * Prompts sent before, for ↑/↓ and Ctrl+R; the CLI passes the project's persisted history.
   * Default: one kept in memory for this run.
   */
  history?: PromptHistory
  /** The files the @ picker offers. Default: the working directory's, from git or a walk. */
  files?: FileSource
  /** The keys of every action; defaults to the defaults for this terminal. See loadKeybindings. */
  keybindings?: Keybindings
  /**
   * The `tui` settings: the mode, bell, title, progress indicator, reflow, what Enter does
   * while working.
   */
  settings?: TuiSettings
  /**
   * Full screen (the conversation kept on the alternate screen, scrolled by Amira) or inline
   * (finished output goes to the terminal's scrollback). Default: `settings.mode`, else inline;
   * the CLI defaults to full screen (D84).
   */
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
  "command.output",
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
