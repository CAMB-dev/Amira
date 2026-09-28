import type { AssistantMessage, JSONSchema, Message, ModelRef } from "@amira/ai"
import type { ShellMode } from "./settings.ts"
import type { ToolExposure } from "./tools.ts"
import type { UiApi } from "./ui.ts"

/** A suggestion for a command's argument text. */
export interface CommandCandidate {
  /** Replaces the whole argument text when chosen. */
  value: string
  description?: string
}

/** A slash command (D55). Built-in commands are registered the same way (D27). */
export interface CommandDefinition {
  /** Typed after the slash: letters, digits and `- _ : .`, starting with a letter or digit. */
  name: string
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

/** A registered command, as frontends list it. */
export interface CommandInfo {
  name: string
  description: string
  hint?: string
  /** The extension that registered it. */
  source: string
}

export type CommandFrontend = "tui" | "rpc" | "print"

export type CommandOutputLevel = "info" | "warning" | "error"

export interface CommandCompleteContext {
  readonly cwd: string
  readonly session: SessionControl
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
  /** Leaves the interactive UI; frontends with nothing to leave ignore it. */
  quit(): void
}

export interface SessionInfo {
  id: string
  cwd: string
  model: ModelRef
  contextWindow: number
  /** Tokens the context held at the last reply; unknown before one and right after a compaction. */
  contextTokens?: number
  /** Where the session is stored, once it has been written. */
  file?: string
  /** A turn is running. */
  busy: boolean
  /** Which shell tools the model gets (D68). */
  shell: ShellMode
}

export interface StoredSessionInfo {
  id: string
  /** Last write, in ms since the epoch. */
  updatedAt: number
  firstUserText: string
  messageCount: number
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
  /** "provider/model" refs to offer, from providers that have a key. */
  models(): string[]
  /** Switches the model for later turns; throws for an unknown one. */
  setModel(ref: string): void
  /** Starts over with an empty conversation in a new session. */
  newSession(): Promise<void>
  /** Stored sessions of this directory, most recent first. */
  sessions(): StoredSessionInfo[]
  /** Switches to a stored session of this directory. */
  resume(sessionId: string): Promise<void>
  /** Summarizes older history now; `instructions` steer the summary. Resolves false when nothing was compacted. */
  compact(instructions?: string): Promise<boolean>
  /** Sends a user message, or steers the running turn; resolves when the turn it joined ends. */
  send(text: string): Promise<void>
  tools(): ToolInfo[]
  /** Enables or disables a tool for the rest of this session; throws for an unknown tool. */
  setToolEnabled(name: string, enabled: boolean): void
  setShell(mode: ShellMode): void
  providers(): ProviderInfo[]
  /** Ids of the ready-made provider configurations. */
  providerPresets(): string[]
  /** Adds a preset to the user settings and makes it usable at once; resolves with what was done. */
  addProvider(presetId: string): Promise<string>
  preview(): Promise<ContextPreview>
  /** Unloads every extension and loads them again. */
  reloadExtensions(): Promise<void>
}
