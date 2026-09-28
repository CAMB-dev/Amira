// Unified message model. Amira's own format is the source of truth;
// dialect adapters translate to and from the wire format at the edge.

export interface TextBlock {
  type: "text"
  text: string
}

export interface ImageBlock {
  type: "image"
  mimeType: string
  /** Base64-encoded image data. */
  data: string
}

export interface ThinkingBlock {
  type: "thinking"
  text: string
  /** Opaque signature that can only be sent back to the dialect that produced it. */
  signature?: { dialect: string; value: string }
}

export interface ToolCallBlock {
  type: "toolCall"
  id: string
  name: string
  args: Record<string, unknown>
}

export type UserContent = TextBlock | ImageBlock
export type AssistantContent = TextBlock | ThinkingBlock | ToolCallBlock
export type ToolResultContent = TextBlock | ImageBlock

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type StopReason = "end" | "toolUse" | "maxTokens" | "aborted" | "error"

export interface ModelRef {
  provider: string
  model: string
}

export interface UserMessage {
  role: "user"
  content: UserContent[]
}

export interface AssistantMessage {
  role: "assistant"
  content: AssistantContent[]
  model: ModelRef
  usage?: Usage
  stopReason?: StopReason
}

export interface ToolResultMessage {
  role: "toolResult"
  toolCallId: string
  toolName: string
  content: ToolResultContent[]
  isError: boolean
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

/** JSON Schema describing a tool's parameters. */
export type JSONSchema = Record<string, unknown>

export interface ToolSpec {
  name: string
  description: string
  parameters: JSONSchema
}

export interface ModelCaps {
  tools: "native" | "none"
  images: boolean
  thinking: boolean
  promptCache: boolean
  parallelToolCalls: boolean
}

export interface ModelInfo {
  id: string
  provider: string
  dialect: string
  contextWindow: number
  maxOutput: number
  caps: ModelCaps
  /** USD per million tokens. */
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

export interface ModelRequest {
  model: ModelInfo
  systemPrompt: string
  messages: Message[]
  tools: ToolSpec[]
  maxTokens?: number
  temperature?: number
}

export interface ModelError {
  message: string
  status?: number
  code?: string
}

export type StreamEvent =
  | { type: "start" }
  | { type: "text.delta"; text: string }
  | { type: "thinking.delta"; text: string }
  | {
      type: "toolCall.delta"
      /** May change once while streaming (placeholder, then the real id); key on index instead. */
      id: string
      /** Position of the call among the message's tool calls. Stable for the whole stream. */
      index?: number
      name?: string
      argsDelta: string
    }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; error: ModelError; retryable: boolean; message: AssistantMessage }

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

export function text(t: string): TextBlock {
  return { type: "text", text: t }
}

export function userMessage(t: string): UserMessage {
  return { role: "user", content: [text(t)] }
}
