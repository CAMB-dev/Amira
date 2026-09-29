import type { CommandDefinition, InputHandler } from "./commands.ts"
import type {
  EventEnvelope,
  EventMap,
  Intercept,
  InterceptorMap,
  InterceptorOptions,
  NoticeLevel,
} from "./events.ts"
import type { RunCommandOptions, RunCommandResult } from "./process.ts"
import type { Settings } from "./settings.ts"
import type { SkillDefinition } from "./skills.ts"
import type { ToolPresenter } from "./tool-renderers.ts"
import type { ToolDefinition } from "./tools.ts"
import type { StatusItem, UiApi } from "./ui.ts"
import type { ViewDefinition } from "./views.ts"

export interface InterceptContext {
  sessionId: string
  signal: AbortSignal
}

export interface ExtensionAPI {
  readonly apiVersion: string
  /** The working directory of the sessions this host serves. */
  readonly cwd: string
  /** Amira's per-user directory: `$AMIRA_HOME`, or `~/.amira`. */
  readonly home: string
  /** Returns a function that removes this registration. */
  registerTool(tool: ToolDefinition): () => void
  /**
   * Adds a slash command (D55). A name that is taken is reported as extension.error and
   * skipped, unless the command sets `override: true`. Aliases shadowed by a command's name or
   * taken over by a later command are reported as extension.error too, but the command is kept.
   */
  registerCommand(command: CommandDefinition): () => void
  /**
   * Adds a skill the user runs as `$<name>`. A name that is taken is reported as
   * extension.error and skipped, unless the skill sets `override: true`.
   */
  registerSkill(skill: SkillDefinition): () => void
  /**
   * Claims lines the user sends before they reach the model (see InputHandler), e.g. `@name
   * text` while a swarm runs. The handler registered last is asked first.
   */
  registerInputHandler(handler: InputHandler): () => void
  /** Adds an item to the status bar. Replacing an existing id requires `override: true`. */
  registerStatusItem(item: StatusItem): () => void
  /**
   * Experimental (D1): sets how frontends show calls of the tool `toolName`, whoever registered
   * the tool. The last presenter registered for a name wins; removing it restores the one before.
   */
  registerToolRenderer(toolName: string, presenter: ToolPresenter<any, any>): () => void
  /**
   * Experimental: adds a full-screen view kind that commands open with CommandContext.openView
   * and data of their own. Like presenters, the last view registered for a kind wins and
   * removing it restores the one before. The frontend's own kind ("subagent") is reported as
   * extension.error and skipped.
   */
  registerView(view: ViewDefinition): () => void
  /** Asks frontends to redraw, e.g. after a status item's state changed. */
  requestRender(): void
  /** The merged settings (D35), e.g. for an extension's own section such as mcpServers. */
  readonly settings: Readonly<Settings>
  /**
   * Runs a command off the main thread (a slow spawn cannot freeze the UI), killing the
   * whole process tree on abort, timeout and exit.
   */
  runCommand(argv: string[], options: RunCommandOptions): Promise<RunCommandResult>
  /** Reports a failure that happened after loading (e.g. in background work) as extension.error. */
  reportError(error: string): void
  /**
   * Tells the user something outside a command (extension.notice), e.g. that a hook failed.
   * Frontends show it as a notice: the TUI in the transcript, print mode on stderr. Keep it
   * short, and name what it is about, since the extension's name is not shown. Default "info".
   */
  notify(text: string, level?: NoticeLevel): void
  /**
   * Runs `handler` when Amira exits, after session.end. The process waits for the handlers,
   * but only a few seconds: then `signal` aborts and Amira exits anyway. For short work that
   * must not be cut off, such as a command the user configured for the end of a session.
   * Returns a function that removes it; unloading the extension removes it too.
   */
  onExit(handler: (signal: AbortSignal) => void | Promise<void>): () => void
  /** Asks the user through whichever frontend is attached (select, confirm, input). */
  readonly ui: UiApi
  on<K extends keyof EventMap>(type: K, handler: (event: EventEnvelope<K>) => void): () => void
  intercept<K extends keyof InterceptorMap>(
    point: K,
    handler: (
      value: InterceptorMap[K],
      ctx: InterceptContext,
    ) => Intercept<InterceptorMap[K]> | Promise<Intercept<InterceptorMap[K]>>,
    options?: InterceptorOptions,
  ): () => void
}

export type Extension = (api: ExtensionAPI) => void | Promise<void>

export function defineExtension(ext: Extension): Extension {
  return ext
}

export function defineTool<P>(tool: ToolDefinition<P>): ToolDefinition<P> {
  return tool
}
