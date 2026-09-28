import type { ImageBlock, JSONSchema, TextBlock } from "@amira/ai"

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
  /** Read-only tools declare "parallel" and may run concurrently. Default "serial". */
  concurrency?: "parallel" | "serial"
  /** Must be true to replace a tool of the same name registered earlier. */
  override?: boolean
  execute(params: P, ctx: ToolContext): Promise<ToolResult>
}

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] }
}
