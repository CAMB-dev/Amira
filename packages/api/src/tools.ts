import type { ImageBlock, JSONSchema, ModelRef, TextBlock } from "@amira/ai"
import type { ChildSession, SpawnOptions } from "./subagents.ts"

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

export interface ToolSession {
  readonly sessionId: string
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
  execute(params: P, ctx: ToolContext): Promise<ToolResult>
}

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] }
}
