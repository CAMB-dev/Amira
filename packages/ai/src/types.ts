// Unified message model. Amira's own format is the source of truth;
// dialect adapters translate to and from the wire format at the edge.

export interface TextBlock {
  type: "text"
  text: string
  /** Opaque provider data about the text, such as its output item id; only its own dialect reads it. */
  signature?: { dialect: string; value: string }
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
  /** The provider hid the reasoning; `signature.value` holds its encrypted form and `text` is empty. */
  redacted?: boolean
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
  /** Cost of these tokens in USD, when the model's prices are known. */
  cost?: number
}

export type StopReason = "end" | "toolUse" | "maxTokens" | "aborted" | "error"

export interface ModelRef {
  provider: string
  model: string
}

/**
 * How frontends show a user message instead of its content: a slash command that sends a long
 * prompt shows the command as typed. It is stored with the message and seen in events, but
 * never sent to the model.
 */
export interface MessageDisplay {
  /** Shown in place of the message's content, e.g. "/review-pr 123". */
  text: string
  /** A short line frontends may show under `text`, e.g. "Loaded skill review-pr (120 lines)". */
  note?: string
}

export interface UserMessage {
  role: "user"
  content: UserContent[]
  /** For frontends only; the model never sees it (see MessageDisplay). */
  display?: MessageDisplay
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
  /** How hard a reasoning model should think; dialects map it to their own setting. Omit for the default. */
  reasoning?: { effort: ReasoningEffort }
  /** Mark stable prefixes for prompt caching where the dialect needs explicit markers. Default true. */
  promptCache?: boolean
}

export type ReasoningEffort = "low" | "medium" | "high" | "max"

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
  | {
      type: "error"
      error: ModelError
      retryable: boolean
      message: AssistantMessage
      /** How long the server asked to wait before retrying (from Retry-After). */
      retryAfterMs?: number
    }
  /** A retryable failure before any content streamed; the request is sent again after delayMs. */
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number; error: ModelError }

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addUsage(a: Usage, b: Usage): Usage {
  const sum: Usage = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
  if (a.cost !== undefined || b.cost !== undefined) sum.cost = (a.cost ?? 0) + (b.cost ?? 0)
  return sum
}

export function text(t: string): TextBlock {
  return { type: "text", text: t }
}

export function userMessage(t: string, display?: MessageDisplay): UserMessage {
  return { role: "user", content: [text(t)], ...(display ? { display } : {}) }
}

/** The request without what only frontends read, such as user messages' `display`. */
export function withoutDisplay(req: ModelRequest): ModelRequest {
  if (!req.messages.some((m) => m.role === "user" && m.display)) return req
  const messages = req.messages.map((m): Message => {
    if (m.role !== "user" || !m.display) return m
    const { display: _, ...rest } = m
    return rest
  })
  return { ...req, messages }
}
