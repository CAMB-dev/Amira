import type { CommandDefinition, InputHandler } from "./commands.ts"
import type { EventEnvelope, EventMap, Intercept, InterceptorMap, InterceptorOptions } from "./events.ts"
import type { OpenPipeOptions, PipeProcess, RunCommandOptions, RunCommandResult } from "./process.ts"
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
   * Experimental: like registerToolRenderer, but builds on the presenter below it (the one
   * that would be used without this registration, undefined when there is none), e.g. to add
   * lines under the built-in edit presenter's diff. `decorate` is called again whenever the
   * presenters below change, so it should only wrap `below`, not keep state of its own.
   */
  decorateToolRenderer(
    toolName: string,
    decorate: (below: ToolPresenter<any, any> | undefined) => ToolPresenter<any, any>,
  ): () => void
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
  /**
   * Starts a long-lived process with piped stdin, stdout and stderr (e.g. a language server
   * or an MCP server) off the main thread. Events arrive asynchronously: "spawned" (or "exit"
   * with an error when it cannot start), then output, then one "exit". The host kills its
   * process tree when Amira exits; close it yourself when it is no longer needed (e.g. on
   * session.end). `argv[0]` is looked up on PATH, on Windows including `.cmd` and `.bat`
   * launchers (whose arguments may not contain cmd.exe's special characters). Throws for an
   * empty `argv`; a command that cannot start reports "exit" with an error.
   */
  openPipe(argv: string[], options: OpenPipeOptions): PipeProcess
  /** Reports a failure that happened after loading (e.g. in background work) as extension.error. */
  reportError(error: string): void
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
