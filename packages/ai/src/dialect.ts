import type { AssistantMessage, ModelRequest, StreamEvent } from "./types.ts"

/** Credentials and endpoint a dialect talks to, resolved from a provider config. */
export interface Endpoint {
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
}

/** Wire-format differences between services that speak the same dialect. */
export interface ProviderCompat {
  /** Field carrying the output token limit. Defaults to "max_tokens". */
  maxTokensField?: "max_tokens" | "max_completion_tokens"
  /**
   * Offer the provider's hosted web search (openai-responses: the `web_search` tool) to this
   * provider's models; a model's `caps.webSearch` wins. By default only on the vendor's own
   * endpoints (api.openai.com and Azure OpenAI hosts). The client web_search tool is then
   * hidden from that model; web_fetch stays.
   */
  webSearch?: boolean
  /** Whether to ask for usage in the stream. Defaults to true. */
  streamUsage?: boolean
  /**
   * How anthropic-messages asks for thinking. "adaptive" (the default) sends an effort, as
   * current Claude models require; "budget" sends budget_tokens, for Claude 4.5 and older
   * and for compatible servers such as DeepSeek.
   */
  thinking?: "adaptive" | "budget"
}

export interface DialectContext {
  endpoint: Endpoint
  signal: AbortSignal
  fetch: typeof fetch
  compat?: ProviderCompat
}

/** A wire protocol adapter. There are few dialects and many providers. */
export interface Dialect {
  id: string
  stream(req: ModelRequest, ctx: DialectContext): AsyncIterable<StreamEvent>
}

/** Drains a stream and returns its final assistant message. */
export async function collect(stream: AsyncIterable<StreamEvent>): Promise<AssistantMessage> {
  for await (const ev of stream) {
    if (ev.type === "done" || ev.type === "error") return ev.message
  }
  throw new Error("stream ended without a done or error event")
}
