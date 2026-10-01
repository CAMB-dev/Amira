import type { ImageBlock, JSONSchema, ModelRef, TextBlock, UserMessage } from "@amira/ai"
import type { BackgroundJobSession } from "./background-jobs.ts"
import type { MutateFiles } from "./file-rewind.ts"
import type { OutputStore } from "./outputs.ts"
import type {
  ChildSession,
  SpawnGroup,
  SpawnGroupInfo,
  SpawnGroupOptions,
  SpawnOptions,
} from "./subagents.ts"
import type { AskOutcome, AskQuestion } from "./ui.ts"

export interface ToolResult {
  content: (TextBlock | ImageBlock)[]
  isError?: boolean
  /** Structured data for renderers; never sent to the model. */
  details?: unknown
}

export interface ToolContext {
  /** Background jobs visible to this caller; top-level sessions see their sub-agents too. */
  backgroundJobs?: BackgroundJobSession
  /** Shared mutation boundary for built-in file tools; absent outside an agent. */
  mutateFiles?: MutateFiles
  cwd: string
  toolCallId: string
  signal: AbortSignal
  /** Aborted when a user steering message arrives; waiting tools may return partial output. */
  steerSignal?: AbortSignal
  /** Reports progress; emitted as tool.execute.update. */
  update(partial: ToolResult): void
  /** The calling session's tool state; absent when a tool runs outside an agent (e.g. in tests). */
  session?: ToolSession
}

export interface DeferredToolInfo {
  name: string
  description: string
  parameters: JSONSchema
  /** This session already offers the tool to the model. */
  loaded: boolean
}

/**
 * Records an extension keeps in a session's file (as custom entries), e.g. a swarm's
 * blackboard, so they are still there when the session is resumed. Each goes under a key of
 * the extension's choosing (use its name) and must survive JSON. A session without a file
 * keeps them in memory. Writing never throws: a failing disk is reported as extension.error.
 */
export interface SessionData {
  append(key: string, data: unknown): void
  /** The records under `key` on the session's current branch, oldest first, as copies. */
  read(key: string): unknown[]
}

export interface ToolSession {
  readonly sessionId: string
  /**
   * A directory for files that belong to this session, e.g. the logs of background jobs: next
   * to its session file, named after it. Not created until something is written there; absent
   * when the session has no file.
   */
  readonly dir?: string
  /** Records extensions keep in this session (see SessionData). */
  readonly data?: SessionData
  /**
   * Where large tool outputs are saved as artifacts, and the sizes that count as large
   * (OutputStore). Absent when the host keeps none: tools then cut their output themselves.
   */
  readonly outputs?: OutputStore
  /** Deferred tools registered right now, in registration order. */
  deferredTools(): DeferredToolInfo[]
  /** Whether this text is present in the messages currently carried as context. */
  contextHas?(text: string): boolean
  /**
   * Offers these deferred tools to the model from its next call on. Names not registered yet are
   * kept and offered once they register as deferred. Returns the names newly loaded.
   */
  loadTools(names: string[]): string[]
  /** 0 for a top-level session, 1 for its sub-agents, and so on. */
  readonly depth: number
  /** The deepest a sub-agent may be (D15); spawn fails beyond it. */
  readonly maxDepth: number
  /** The model this session uses right now. */
  readonly model: ModelRef
  /**
   * Starts a sub-agent under this session (D12). Throws when it would nest too deep, the
   * tree's budget is spent or the model is unknown. Absent when the host has no agent tree.
   */
  spawn?(opts: SpawnOptions): ChildSession
  /**
   * Creates a spawn group under this session: sub-agents started through it share limits of
   * their own (see SpawnGroup). Throws when the tree's budget is spent. Absent when the host
   * has no agent tree.
   */
  createGroup?(opts: SpawnGroupOptions): SpawnGroup
  /** The agent tree's spawn groups, active and ended, oldest first. Absent without a tree. */
  groups?(): SpawnGroupInfo[]
  /**
   * Puts questions to whoever answers for this session: the user in a top-level session, the
   * commander (the parent's model, which may pass them on up) in a sub-agent. The session shows
   * as blocked meanwhile. Absent when the host cannot ask anyone.
   */
  askUser?(questions: AskQuestion[], signal?: AbortSignal): Promise<AskOutcome>
  /**
   * Announces a message this session will get later, from outside its turns: e.g. the
   * result of a sub-agent running in the background. Until the handle is delivered or
   * cancelled the session counts as expecting it (print mode waits for it). Absent when
   * the host cannot wake the session, as for sub-agents.
   */
  expectNotice?(): PendingNotice
}

/**
 * A message a session was told to expect (ToolSession.expectNotice). Delivered while a turn
 * runs, it joins that turn before its next model call; delivered while the session is idle,
 * it starts a turn. Several waiting at once go to the model together, as one message. It is
 * never dropped: one the turn did not reach because it was interrupted or failed waits for
 * the next turn. Only the first deliver or cancel counts.
 */
export interface PendingNotice {
  /**
   * Hands the message over. Give it a `display` with origin so frontends show it as a notice.
   * `wake: false` starts no turn when the session is idle: the message waits for the next one
   * (the user's next message), e.g. for news the user caused and already knows.
   */
  deliver(message: UserMessage, opts?: { wake?: boolean }): void
  /** Nothing will come after all. */
  cancel(): void
}

export type ToolExposure = "active" | "inactive" | "deferred"

/** The shell a shell tool runs its commands in. */
export type ShellKind = "bash" | "powershell"

/**
 * Static capabilities a tool exposes to the host. Omitted capabilities remain unknown. They are
 * trusted for the tool's own name, but a tool registered under a built-in name (write, edit,
 * apply_patch, bash, powershell, ask_user) keeps the capabilities that name implies whatever it
 * declares here.
 */
export interface ToolTraits {
  /** The tool is safe to run in plan mode when it does not also write files or run a shell. */
  readOnly?: boolean
  /** Whether the tool can write files; "paths" promises a complete getWrittenPaths report. */
  writesFiles?: boolean | "paths"
  /** The shell used by the tool's command argument, when it has one. */
  shell?: ShellKind
  /** The kind of built-in editing tool this tool replaces, when provider settings select one. */
  editor?: "edit" | "apply_patch"
  /** The tool calls mutateFiles itself; the host must not add a second path capture boundary. */
  usesMutationHook?: boolean
  /** The tool reads saved artifacts rather than producing a new artifact worth saving. */
  artifactReader?: boolean
  /** The tool loads deferred tool definitions and is omitted when none remain. */
  toolSearch?: boolean
  /** The tool requires an interactive UI and is hidden in print or headless mode. */
  interactive?: boolean
}

export interface ToolCallPathContext {
  cwd: string
}

export interface ToolDefinition<P = any> {
  name: string
  description: string
  parameters: JSONSchema
  /** The tool's known host-visible capabilities; omitted fields are deliberately unknown. */
  traits?: ToolTraits
  /**
   * Default "active": the model sees it on every call. "deferred" tools are only named in the
   * system prompt until the model loads them with tool_search. "inactive" tools are hidden.
   */
  exposure?: ToolExposure
  /**
   * "parallel" calls may run at the same time as other calls; "serial" (the default) waits for
   * earlier calls and runs alone.
   */
  concurrency?: "parallel" | "serial"
  /**
   * For parallel tools: calls returning the same key run one after another, in call order
   * (e.g. edits to the same file). Undefined means no ordering constraint.
   */
  concurrencyKey?(params: P, ctx: { cwd: string }): string | undefined
  /** Must be true to replace a tool of the same name registered earlier. */
  override?: boolean
  /**
   * Only top-level sessions get it: sub-agents, at any depth, never see or call it, whatever
   * tools they were given. For tools that start work only the user's own session should
   * start, such as a workflow or a swarm (D81).
   */
  mainOnly?: boolean
  /**
   * "webSearch": hidden from models that search the web on the provider's side (the hosted
   * web search, settings compat.webSearch), for a tool that would do the same.
   */
  supersededBy?: "webSearch"
  /**
   * Reports the paths this call may write, relative to `ctx.cwd` or absolute. A valid report is
   * required for host-side protected-path checks and rewind capture of a writer; `"paths"` says
   * the report is complete for every call.
   */
  getWrittenPaths?(
    params: P,
    ctx: ToolCallPathContext,
  ): readonly string[] | undefined | Promise<readonly string[] | undefined>
  /**
   * Identifies a repeatable direct file read for context deduplication. A tool without this
   * callback is never treated as a repeatable file read, even when it is read-only.
   */
  readKey?(params: P, ctx: ToolCallPathContext): string | undefined
  /**
   * For a tool that runs its `command` argument (a string) in a shell: which shell runs it, so
   * the core permission policy reads the command the way that shell will. A tool with this is
   * checked as a shell tool whatever its name. The static `traits.shell` is used when this
   * runtime answer is unavailable.
   */
  shellKind?(): ShellKind | Promise<ShellKind>
  execute(params: P, ctx: ToolContext): Promise<ToolResult>
}

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] }
}
