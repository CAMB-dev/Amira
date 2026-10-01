import type {
  AssistantMessage,
  ContextWindowSource,
  JSONSchema,
  Message,
  MessageDisplay,
  ModelRef,
  Usage,
} from "@amira/ai"
import type { CompactionUsage } from "./events.ts"
import type { ExtensionAdmin } from "./extensions-admin.ts"
import type { ProviderAdmin } from "./providers.ts"
import type { CommandRule, PermissionMode, ShellMode } from "./settings.ts"
import type { SkillInfo } from "./skills.ts"
import type { SpawnGroup, SpawnGroupInfo, SpawnGroupOptions, SubagentStatus } from "./subagents.ts"
import type { PendingNotice, SessionData, ToolExposure } from "./tools.ts"
import type { UiApi } from "./ui.ts"

/** A suggestion for a command's argument text. */
export interface CommandCandidate {
  /** Replaces the whole argument text when chosen. */
  value: string
  description?: string
  /** Shown in lists in place of `value`, e.g. a command name with its aliases. */
  label?: string
}

/** A slash command (D55). Built-in commands are registered the same way (D27). */
export interface CommandDefinition {
  /** Typed after the slash: letters, digits and `- _ : .`, starting with a letter or digit. */
  name: string
  /**
   * Other names that run this command, e.g. ["exit", "q"] for "quit". Same characters as
   * `name`; "?" is allowed too. A command's name always wins over another command's alias;
   * when two commands claim an alias, the one registered last has it (with a warning).
   * Aliases stay with the name, so an `override` of "quit" still answers to /exit and /q.
   */
  aliases?: string[]
  description: string
  args?: {
    /** Shown after the name in lists, e.g. "[provider/model]". */
    hint?: string
    /**
     * Candidates for the argument text typed so far. Frontends rank them against `prefix`
     * (prefix matches first, then fuzzy ones), so returning every candidate is fine.
     */
    complete?(prefix: string, ctx: CommandCompleteContext): CommandCandidate[] | Promise<CommandCandidate[]>
  }
  /** Must be true to replace a command of the same name registered earlier. */
  override?: boolean
  /** `args` is the text after the name, trimmed. Throwing reports the message to the user. */
  run(args: string, ctx: CommandContext): void | Promise<void>
}

/**
 * Claims some of the lines the user sends before they reach the model, e.g. `@name text`
 * for a message to a swarm member while a swarm runs. Frontends ask the handlers (the one
 * registered last first) about each line that is not a slash command or a skill; the first
 * that claims it runs it, and the model never sees the line.
 */
export interface InputHandler {
  /** Names it in errors, e.g. "swarm". */
  name: string
  /**
   * Whether the line is for this handler. Asked about every line the user sends, so it must
   * answer at once; claim only what is clearly yours (a throw counts as no).
   */
  claims(text: string): boolean
  /** Handles a line it claimed, as a command runs. Throwing reports the message to the user. */
  run(text: string, ctx: CommandContext): void | Promise<void>
}

/** A registered command, as frontends list it. */
export interface CommandInfo {
  name: string
  /** The aliases that run it; ones another command's name shadows are left out. */
  aliases: string[]
  description: string
  hint?: string
  /** The extension that registered it. */
  source: string
}

/** A command alias from settings: typing `/<name> more` runs `/<expansion> more`. */
export interface CommandAlias {
  name: string
  /** The command line it stands for, without the slash, e.g. "model deepseek/deepseek-flash". */
  expansion: string
}

export type CommandFrontend = "tui" | "rpc" | "print"

export type CommandOutputLevel = "info" | "warning" | "error"

export interface CommandCompleteContext {
  readonly cwd: string
  readonly session: SessionControl
}

/** A key of the frontend and what it does, as /help lists it: "Ctrl+R", "Search the prompt history". */
export interface KeyHelp {
  keys: string
  description: string
}

export interface CommandContext extends CommandCompleteContext {
  /** Where the command was typed. */
  readonly frontend: CommandFrontend
  readonly signal: AbortSignal
  /** Dialogs (select, confirm, input); print mode cancels them. */
  readonly ui: UiApi
  /** Shows text to the user: in the transcript, on stdout in print mode, as command.output over rpc. */
  print(text: string, level?: CommandOutputLevel): void
  /** Every registered command, by name. */
  commands(): CommandInfo[]
  /** Every registered skill (run as `$<name>`), by name. */
  skills(): SkillInfo[]
  /** The user's command aliases from settings (`commandAliases`) that are in effect, by name. */
  aliases(): CommandAlias[]
  /** Leaves the interactive UI; frontends with nothing to leave ignore it. */
  quit(): void
  /**
   * The frontend's most useful keys, as its keybindings have them now, for /help; unset where
   * the frontend has no keys of its own.
   */
  readonly keys?: () => readonly KeyHelp[]
  /**
   * Shows a full-screen view, on frontends that have them (the TUI does); unset elsewhere.
   * Returns once the view is shown (the user leaves it when done): true, or false when it
   * cannot be shown now, e.g. while a form holds the screen. Throws for a view kind no
   * extension registered (see ExtensionAPI.registerView).
   */
  readonly openView?: (view: FrontendView) => boolean
}

/**
 * A full-screen view a frontend can show: the live transcript of a sub-agent, or a view kind
 * an extension registered, over the data given here (see ViewDefinition).
 */
export type FrontendView = SubagentView | ExtensionView

export interface SubagentView {
  kind: "subagent"
  sessionId: string
}

export interface ExtensionView {
  /** A kind registered with ExtensionAPI.registerView. */
  kind: string
  /** What the view shows; it is read again at each redraw, so changes to it show up. */
  data?: unknown
}

/** Whether `view` is the frontend's own sub-agent view rather than an extension's. */
export function isSubagentView(view: FrontendView): view is SubagentView {
  return view.kind === "subagent" && typeof (view as Partial<SubagentView>).sessionId === "string"
}

/**
 * Where a sub-agent is: waiting for a slot, working, idle between turns (persistent ones
 * only), or how it ended.
 */
export type SubagentState = "queued" | "running" | "idle" | SubagentStatus

/**
 * A sub-agent's state as every screen words it: running, queued, idle, done, failed, stopped
 * (the states are named for code: an ended one is "error" or "aborted").
 */
export function subagentStateText(state: SubagentState): string {
  return state === "error" ? "failed" : state === "aborted" ? "stopped" : state
}

/** A sub-agent of the session, running or finished, as commands list it. */
export interface SubagentInfo {
  id: string
  parentSessionId: string
  /** 1 for the session's own sub-agents, 2 for theirs. */
  depth: number
  /** "agent" when it was started without a role. */
  role: string
  /** A few words naming its task; the task's first words when it was given none. */
  title: string
  /** The parent's tool call that started it, when known. */
  toolCallId?: string
  /** The prompt it was given. */
  task: string
  status: SubagentState
  model?: ModelRef
  /** When it started working, in ms since the epoch; unset while queued. */
  startedAt?: number
  /** How long it ran, once it ended. */
  durationMs?: number
  /** Tokens and cost of its own replies so far, its sub-agents excluded. */
  usage: Usage
  error?: string
  /** Why it ended early without failing (stopped, turn limit). */
  note?: string
  /** A long-lived child (SpawnOptions.persistent). */
  persistent?: boolean
  /** Turns started so far, for persistent children. */
  turns?: number
  /** The spawn group it counts against. */
  groupId?: string
}

export interface SessionInfo {
  id: string
  cwd: string
  model: ModelRef
  contextWindow: number
  /** Where `contextWindow` came from; "default" means it is a guess. Unset without a model. */
  contextWindowSource?: ContextWindowSource
  /** Tokens the context held at the last reply; unknown before one and right after a compaction. */
  contextTokens?: number
  /** Where the session is stored, once it has been written. */
  file?: string
  /** A turn is running. */
  busy: boolean
  /** Which shell tools the model gets (D68). */
  shell: ShellMode
  /** The permission mode and how many command rules apply; unset where the host has no policy. */
  permissions?: { mode: PermissionMode; rules: number }
}

/** The effective permission settings, for /permissions to list with where each comes from. */
export interface PermissionsReport {
  mode: PermissionMode
  /** Where the mode came from: "default", a settings file or --permission-mode; "this session" after Shift+Tab. */
  modeSource: string
  rules: (CommandRule & { scope: "user" | "project"; file: string })[]
  /** Settings the policy left out (a project loosening, an untrusted project's allow rules). */
  warnings: string[]
}

export interface StoredSessionInfo {
  id: string
  /** Last write, in ms since the epoch. */
  updatedAt: number
  firstUserText: string
  messageCount: number
}

/** A stored session read without switching to it (SessionControl.readSession). */
export interface StoredSession {
  id: string
  cwd: string
  /** When it was created, in ms since the epoch. */
  createdAt: number
  /** Last write, in ms since the epoch. */
  updatedAt: number
  /**
   * Every message on its current branch, oldest first, including ones a compaction has since
   * replaced in what the model sees: the conversation as it happened, not the context.
   */
  messages: readonly Message[]
  /** Its sub-agents and theirs, each followed by its own (as SessionControl.subagents). */
  subagents: SubagentInfo[]
  /**
   * A sub-agent's conversation as it happened (compacted parts included, as `messages`);
   * undefined for an id not in `subagents`.
   */
  subagentMessages(id: string): readonly Message[] | undefined
}

export interface ToolInfo {
  name: string
  description: string
  source: string
  exposure: ToolExposure
  /** False when hidden from the model, by settings, --shell or this session. */
  enabled: boolean
}

export interface ProviderInfo {
  id: string
  dialect: string
  baseUrl: string
  apiKeyEnv?: string
  /** A key is available (or the provider needs none). */
  hasKey: boolean
}

/** What the next model call would send, after the system.build and context.build interceptors. */
export interface ContextPreview {
  systemPrompt: string
  tools: { name: string; description: string; parameters: JSONSchema }[]
  messages: Message[]
}

export interface SendOptions {
  /** Stored with the message and shown by frontends in its place; never sent to the model. */
  display?: MessageDisplay
}

/**
 * The session a command acts on, provided by the host. Methods that cannot run while a turn
 * is running (switching models or sessions, compacting) throw an Error saying so.
 */
export interface SessionControl {
  info(): SessionInfo
  /** The conversation the model sees. */
  messages(): readonly Message[]
  /** Every model reply of this session, including ones a compaction has since replaced. */
  replies(): readonly AssistantMessage[]
  /**
   * What this session's compactions cost, one entry each (server-side ones and summaries the
   * model wrote), earlier runs of a resumed session included. Not among `replies`.
   */
  compactions?(): readonly CompactionUsage[]
  /**
   * This session's sub-agents and theirs, each followed by its own: the ones running or
   * queued now and the finished ones, also from earlier runs of a resumed session.
   */
  subagents(): SubagentInfo[]
  /** A sub-agent's conversation so far (a snapshot while it runs); undefined for an unknown id. */
  subagentMessages(id: string): readonly Message[] | undefined
  /**
   * Stops a queued or running sub-agent of this session (its own sub-agents end with it); its
   * result says it was stopped by the user. False when it is unknown or already ended.
   */
  stopSubagent(id: string): boolean
  /**
   * Creates a spawn group whose sub-agents are children of this session, e.g. for a command
   * that runs a workflow. Unset where the host has no agent tree.
   */
  readonly createGroup?: (opts: SpawnGroupOptions) => SpawnGroup
  /** The agent tree's spawn groups, active and ended, oldest first; unset without a tree. */
  readonly groups?: () => SpawnGroupInfo[]
  /**
   * Announces a message the session gets later, as ToolSession.expectNotice does: e.g. the
   * result of work a command started in the background. Unset where the host cannot wake the
   * session.
   */
  readonly expectNotice?: () => PendingNotice
  /**
   * Records extensions keep in the session (see SessionData), e.g. to show what the tools of
   * a resumed session recorded. Follows the session commands switch to. Unset where the host
   * has none.
   */
  readonly data?: SessionData
  /** "provider/model" refs to offer, from providers that have a key. */
  models(): string[]
  /** Switches the model for later turns; throws for an unknown one. */
  setModel(ref: string): void
  /** Starts over with an empty conversation in a new session. */
  newSession(): Promise<void>
  /** Stored sessions of this directory, most recent first. */
  sessions(): StoredSessionInfo[]
  /**
   * Reads a stored session of this directory without switching to it, e.g. to export it; the
   * current one is read from memory, so it is up to date even before its file is. Undefined for an unknown id. Unset where the host keeps
   * no session files.
   */
  readonly readSession?: (sessionId: string) => StoredSession | undefined
  /** Switches to a stored session of this directory. */
  resume(sessionId: string): Promise<void>
  /**
   * Cuts the conversation back to just before `messages()[index]`, which must be a user
   * message: it and everything after it are gone from later turns, e.g. to go back to before a
   * turn that went wrong. The session stays the same (also when going back to before its first
   * message); the cut-off part stays in its file on a branch of its own.
   * Frontends show the shortened conversation as they show a resumed one. Throws while a turn
   * runs, for an index that is not a user message, and for a message a compaction has since
   * summarized. Unset where the host keeps no session file.
   */
  readonly rewind?: (index: number) => Promise<void>
  /** Summarizes older history now; `instructions` steer the summary. Resolves false when nothing was compacted. */
  compact(instructions?: string): Promise<boolean>
  /**
   * Sends a user message, or steers the running turn; resolves when the turn it joined ends.
   * `display` is what frontends show instead of `text` (the model still gets all of `text`),
   * e.g. the command as typed when a command sends a long prompt.
   */
  send(text: string, opts?: SendOptions): Promise<void>
  tools(): ToolInfo[]
  /** Enables or disables a tool for the rest of this session; throws for an unknown tool. */
  setToolEnabled(name: string, enabled: boolean): void
  setShell(mode: ShellMode): void
  /** The permission mode, rules and where they come from; unset where the host has no policy. */
  readonly permissions?: () => PermissionsReport
  /** The configured providers; Amira has none built in. */
  providers(): ProviderInfo[]
  /** Adding, editing and removing providers and their keys; unset where the host cannot. */
  readonly providerAdmin?: ProviderAdmin
  /** Installed extension packages and the official index; unset where the host cannot manage them. */
  readonly extensionAdmin?: ExtensionAdmin
  preview(): Promise<ContextPreview>
  /**
   * Unloads every extension and loads them again, with the packages as installed now. Says
   * what changed where the host can tell.
   */
  reloadExtensions(): Promise<ReloadReport | undefined>
}

/** What /reload changed: extensions (by source) that came or went, and ones that failed. */
export interface ReloadReport {
  loaded: string[]
  unloaded: string[]
  failed: string[]
  /** Extensions loaded now. */
  extensions: number
  skillsAdded: number
  skillsRemoved: number
}
