import type { ImageBlock, JSONSchema, ModelRef, TextBlock, UserMessage } from "@amira/ai"
import type {
  ChildSession,
  SpawnGroup,
  SpawnGroupInfo,
  SpawnGroupOptions,
  SpawnOptions,
} from "./subagents.ts"

export interface ToolResult {
  content: (TextBlock | ImageBlock)[]
  isError?: boolean
  /** Structured data for renderers; never sent to the model. */
  details?: unknown
}

export interface ToolContext {
  cwd: string
  toolCallId: string
  signal: AbortSignal
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
  /** Records extensions keep in this session (see SessionData). */
  readonly data?: SessionData
  /** Deferred tools registered right now, in registration order. */
  deferredTools(): DeferredToolInfo[]
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
  /** Hands the message over. Give it a `display` with origin so frontends show it as a notice. */
  deliver(message: UserMessage): void
  /** Nothing will come after all. */
  cancel(): void
}

export type ToolExposure = "active" | "inactive" | "deferred"

export interface ToolDefinition<P = any> {
  name: string
  description: string
  parameters: JSONSchema
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
  execute(params: P, ctx: ToolContext): Promise<ToolResult>
}

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] }
}
