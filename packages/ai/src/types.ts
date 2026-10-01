import * as shared from "@amira/ai-shared"
import type { ModelErrorKind } from "./errors.ts"
// Unified message model. Amira's own format is the source of truth;
// dialect adapters translate to and from the wire format at the edge.

/**
 * Opaque provider data carried with a block: signed or encrypted reasoning, an output item's id,
 * or a server's compaction checkpoint. Only its own dialect reads `value`, and it is sent back
 * only where it came from (canReplay): the same dialect, provider and host, and for a
 * checkpoint the same model too. Anywhere else the block goes as plain text.
 */
export interface Signature {
  dialect: string
  value: string
  /**
   * Host of the endpoint that produced it, set by the ai client. Data stored before hosts were
   * kept has none; it is then sent back by provider alone.
   */
  host?: string
  /**
   * Provider that produced it, where the message has no model to tell (the summary messages of
   * a compaction checkpoint); otherwise the message's model says.
   */
  provider?: string
  /** The only model it can be sent back to (compaction checkpoints). */
  model?: string
  /**
   * "checkpoint": a server's compaction of earlier history (native compaction), carried by
   * both messages of the summary pair; a dialect that can replay it sends it in their place.
   * "webSearch": a cited text block whose encrypted citation data also requires native search.
   */
  kind?: "checkpoint" | "webSearch"
}

export interface TextBlock {
  type: "text"
  /** Sources the provider cited for spans of the text (e.g. after a hosted web search). */
  citations?: Citation[]
  text: string
  /** Opaque provider data about the text, such as its output item id; only its own dialect reads it. */
  signature?: Signature
}

export interface ImageBlock {
  type: "image"
  /** Original attachment name, for frontends and session restore; not sent to the provider. */
  name?: string
  mimeType: string
  /** Base64-encoded image data. */
  data: string
}

export interface ThinkingBlock {
  type: "thinking"
  text: string
  /** Opaque signature that can only be sent back where it came from (Signature). */
  signature?: Signature
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
export type AssistantContent = TextBlock | ThinkingBlock | ToolCallBlock | ServerToolBlock
export type ToolResultContent = TextBlock | ImageBlock

export interface Usage {
  input: number
  output: number
  /** Reasoning tokens included in output, when reported by the provider. */
  reasoning?: number
  cacheRead: number
  cacheWrite: number
  /** Search requests reported by the provider (Gemini 3: unique nonempty queries). */
  webSearchRequests?: number
  /** USD for those searches, only when their count and per-search price are known. */
  webSearchCost?: number
  /** Cost of tokens and searches in USD, when their prices are known. */
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
  /**
   * Set when the user did not write the message: "subagent" for the results of background
   * sub-agents delivered to their commander. Frontends show it as a notice, not as the user's.
   */
  origin?: string
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

/** Why a tool call produced an error result without its tool running to completion. */
export type ToolRejection = "blocked" | "unknownTool" | "invalidArgs" | "aborted"

export interface ToolResultMessage {
  role: "toolResult"
  toolCallId: string
  toolName: string
  content: ToolResultContent[]
  isError: boolean
  /**
   * Why the call did not run to completion, when it did not. For frontends only — dialects
   * never send it — so a resumed session renders the call as the live one did. Messages
   * stored before this was kept have none.
   */
  rejected?: ToolRejection
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
  /**
   * Offer the provider's own hosted web search (hasNativeWebSearch); resolved per provider
   * and model from ProviderCompat.webSearch.
   */
  webSearch?: boolean
}

/** Where a model's context window came from (ModelInfo.contextWindowSource). */
export type ContextWindowSource = "settings" | "catalog" | "default"

export interface ModelInfo {
  id: string
  provider: string
  dialect: string
  contextWindow: number
  /**
   * Where `contextWindow` came from: the user's settings, the model catalog, or the built-in
   * default (a guess). Unset for models not resolved from a provider.
   */
  contextWindowSource?: ContextWindowSource
  maxOutput: number
  caps: ModelCaps
  /** USD per million tokens; webSearch is USD per search request. */
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; webSearch?: number }
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
  /** What kind of failure it is (errors.ts); the ai client sets it on the errors it hands out. */
  kind?: ModelErrorKind
  /** The host the request went to, set by the ai client, for messages ("Cannot reach api.x.com"). */
  host?: string
  /** Retries made before giving up, set by the ai client when there were any. */
  retries?: number
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
  /**
   * A server-hosted tool (a web search the provider runs) started or changed state: the block
   * as it is now. It is not a tool call: nothing runs locally and no result is sent back.
   */
  | { type: "serverTool"; block: ServerToolBlock }
  /** A retryable failure before any content streamed; the request is sent again after delayMs. */
  | { type: "retry"; attempt: number; maxRetries: number; delayMs: number; error: ModelError }

/** A usage value with all token counters at zero. */
export const emptyUsage: () => Usage = shared.emptyUsage

/** Adds token and search usage, keeping cost unknown when an included search was not priced. */
export const addUsage: (a: Usage, b: Usage) => Usage = shared.addUsage

export function text(t: string): TextBlock {
  return { type: "text", text: t }
}

export function userMessage(t: string, display?: MessageDisplay): UserMessage {
  return { role: "user", content: [text(t)], ...(display ? { display } : {}) }
}

/** The messages as the model sees them: without user messages' `display`. Unchanged ones are kept. */
export function modelMessages(messages: Message[]): Message[] {
  if (!messages.some((m) => m.role === "user" && m.display)) return messages
  return messages.map((m): Message => {
    if (m.role !== "user" || !m.display) return m
    const { display: _, ...rest } = m
    return rest
  })
}

/** The request without what only frontends read, such as user messages' `display`. */
export function withoutDisplay(req: ModelRequest): ModelRequest {
  const messages = modelMessages(req.messages)
  return messages === req.messages ? req : { ...req, messages }
}

/** A source a reply cites, such as an OpenAI url_citation annotation. */
export interface Citation {
  url: string
  title?: string
  /** The cited span of the block's text, as the provider counts it (start inclusive). */
  start?: number
  end?: number
}

/**
 * A tool the provider ran on its own servers during the reply, e.g. OpenAI's hosted web
 * search: shown like a tool call, but never executed locally and never answered with a
 * result. Its raw item goes back only to the dialect, provider and host that produced it;
 * anywhere else it is sent as a short text note (server-tools.ts).
 */
export interface ServerToolBlock {
  type: "serverTool"
  /** The provider's item id. */
  id: string
  /** What ran, e.g. "web_search". */
  name: string
  /**
   * What it was asked, as the provider reported it, e.g. `{ type: "search", query }`,
   * `{ type: "open_page", url }` or `{ type: "find_in_page", url, pattern }`.
   */
  input: Record<string, unknown>
  status: "running" | "done" | "failed"
  /** Sources it looked at, when the provider lists them. */
  sources?: { url: string; title?: string }[]
  /** Google's search suggestions, retained for consumers that can display a webview. */
  searchEntryPoint?: { renderedContent?: string; sdkBlob?: string }
  /**
   * The provider's item as it came (`value`), and the host it came from, set by the ai client.
   * Replayed only there, and only while the request offers the tool (canReplayServerTool).
   */
  signature?: Signature
}
