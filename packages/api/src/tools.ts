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
}

export type ToolExposure = "active" | "inactive" | "deferred"

export interface ToolDefinition<P = any> {
  name: string
  description: string
  parameters: JSONSchema
  /** Default "active": the model sees it on every call. */
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
