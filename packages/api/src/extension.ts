import type { AssistantMessage, Message, Usage } from "@amira/ai"
import type { BackgroundJobExtension } from "./background-jobs.ts"
import type { CommandDefinition, InputHandler, SessionControl } from "./commands.ts"
import type {
  EventEnvelope,
  EventMap,
  Intercept,
  InterceptorMap,
  InterceptorOptions,
  NoticeLevel,
} from "./events.ts"
import type { FileRestorationOwner } from "./file-rewind.ts"
import type { PanelDefinition } from "./panels.ts"
import type { OpenPipeOptions, PipeProcess, RunCommandOptions, RunCommandResult } from "./process.ts"
import type { ImageProvider, MarkdownRendererDefinition } from "./render.ts"
import type { ServiceName, ServiceOf } from "./services.ts"
import type { SettingsView } from "./settings.ts"
import type { SkillDefinition } from "./skills.ts"
import type { TerminalApi } from "./terminal.ts"
import type { ToolPresenter } from "./tool-renderers.ts"
import type { ToolDefinition } from "./tools.ts"
import type { StatusItem, UiApi } from "./ui.ts"
import type { ViewDefinition } from "./views.ts"
import type { WorkspaceProvider } from "./workspace.ts"

export interface InterceptContext {
  sessionId: string
  signal: AbortSignal
}

/** A host-accounted model call made by an extension. */
export interface CompleteRequest {
  model?: string
  system?: string
  messages: Message[]
  maxTokens?: number
  signal?: AbortSignal
  label?: string
}

/** The assistant reply from an extension's host-accounted model call. */
export interface CompleteResult {
  text: string
  message: AssistantMessage
  usage?: Usage
}

export interface ExtensionAPI {
  /** Structured terminal effects, bound by the interactive frontend; no-op otherwise. */
  readonly terminal: TerminalApi
  /** Claims workspace probing exclusively. Throws if taken; unregisters on unload/reload. */
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void
  /** Claims rewind's file restoration exclusively. Unloading releases the claim. */
  registerFileRestoration(owner: FileRestorationOwner): () => void
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
   * removing it restores the one before. Reserved frontend kinds, if any, are reported as
   * extension.error and skipped.
   */
  registerView(view: ViewDefinition): () => void
  /**
   * Experimental: adds a live panel, lines kept above the activity line such as a todo list
   * (see PanelDefinition). Replacing an existing id requires `override: true`; a taken id is
   * reported as extension.error and skipped.
   */
  registerPanel(panel: PanelDefinition): () => void
  /**
   * Experimental (D88): renders nodes of the model's Markdown replies instead of Amira, e.g.
   * ```mermaid blocks as a diagram, or standalone images (see MarkdownRendererDefinition). An id
   * this extension registered already is reported as extension.error and skipped.
   */
  registerMarkdownRenderer(renderer: MarkdownRendererDefinition): () => void
  /**
   * Experimental (D88): makes images drawable: reads, downloads, decodes and encodes them for
   * the terminal's protocol (see ImageProvider). Without a provider, images are their alt text.
   */
  registerImageProvider(provider: ImageProvider): () => void
  /**
   * Experimental (D88): offers a service to other extensions under `name` (see AmiraServices for
   * names and versioning). A name another extension offers already is reported as
   * extension.error and skipped; unloading removes it.
   */
  provideService<K extends ServiceName>(name: K, service: ServiceOf<K>): () => void
  /**
   * Experimental (D88): the service offered under `name`, or undefined when no extension offers
   * it (now: look it up where it is used, not once at load).
   */
  useService<K extends ServiceName>(name: K): ServiceOf<K> | undefined
  /** Asks frontends to redraw, e.g. after a status item's or a panel's state changed. */
  requestRender(): void
  /** The merged settings (D35) and explicit source layers, e.g. for mcpServers trust checks. */
  readonly settings: SettingsView
  /** Makes a host-accounted side model call without tools or hosted web search. */
  complete(request: CompleteRequest): Promise<CompleteResult>
  /** The current top-level session, when the host has injected session control. */
  session(): SessionControl | undefined
  /** Background jobs started by this extension; host-wide jobs are available only to host code. */
  readonly backgroundJobs: BackgroundJobExtension
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
  /**
   * Runs `handler` for every event of this type. An extension loaded by /reload gets, in the
   * handlers it registers while loading, the events that say where the session already is
   * (its session.start with the current model and context, the last workspace.changed and
   * budget.update) before anything new: a handler that keeps such state needs no other way
   * to recover it. Returns a function that removes the handler.
   */
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
