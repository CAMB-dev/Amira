import type { AssistantMessage, ModelError, ModelRequest, StreamEvent, Usage } from "./types.ts"

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
  /** Whether to ask for usage in the stream. Defaults to true. */
  streamUsage?: boolean
  /**
   * How anthropic-messages asks for thinking. "adaptive" (the default) sends an effort, as
   * current Claude models require; "budget" sends budget_tokens, for Claude 4.5 and older
   * and for compatible servers such as DeepSeek.
   */
  thinking?: "adaptive" | "budget"
  /**
   * Server-side (native) compaction, where the dialect has it (openai-responses,
   * anthropic-messages). "auto" (the default) uses it only on the vendor's own endpoints
   * (api.openai.com and Azure OpenAI hosts, api.anthropic.com); "on" uses it on this
   * provider whatever its host, e.g. a local proxy that forwards it; "off" never uses it.
   * Automatic and plain /compact compactions try it first and fall back to a text summary;
   * ways that failed are remembered per provider, host and model and skipped for a while.
   */
  compaction?: "auto" | "on" | "off"
}

export interface DialectContext {
  endpoint: Endpoint
  signal: AbortSignal
  fetch: typeof fetch
  compat?: ProviderCompat
}

/**
 * Where a server's compaction checkpoint sits in the history after it:
 * - "tail": the checkpoint stands for the older history, followed by the most recent turns
 *   verbatim (Amira's text summary layout);
 * - "recent-user": the whole history is compacted, and the most recent user messages (up to a
 *   token budget) go before the checkpoint, which comes last (the layout Codex uses).
 */
export type CompactionLayout = "tail" | "recent-user"

/** One attempt at server-side compaction, as a dialect reports it. */
export type DialectCompactOutcome =
  | {
      ok: true
      /** The checkpoint as the dialect replays it (Signature.value). */
      value: string
      /** Readable text of the summary, when the server gives one (Anthropic does, OpenAI does not). */
      summary?: string
      usage?: Usage
    }
  | {
      ok: false
      error: ModelError
      /**
       * The endpoint does not do it this way (HTTP 404/405/501, a request rejected for the
       * compaction field, or a reply without exactly one checkpoint): remembered and skipped.
       */
      unsupported: boolean
      /** Worth trying again later (rate limits, server errors, network). */
      retryable: boolean
      /** Tokens the attempt still cost, e.g. a server that ignored the request and answered. */
      usage?: Usage
    }

/**
 * A dialect's server-side compaction. Having one does not mean it is used: that is up to the
 * provider (ProviderCompat.compaction), since a service speaking a dialect need not be the
 * vendor's own.
 */
export interface DialectCompaction {
  /** Ways of asking, tried in this order until one works, e.g. ["trigger", "endpoint"]. */
  readonly methods: readonly string[]
  /** Layouts the dialect can replay the checkpoint in; the first is used when another is asked for. */
  readonly layouts: readonly CompactionLayout[]
  /**
   * Whether a "tail" checkpoint may cover the first steps of a long turn, with the turn's
   * prompt sent again after it. False where the kept messages must follow exactly what was
   * compacted (Anthropic); such compactions are then text summaries.
   */
  readonly midTurn: boolean
  /** Whether `baseUrl` is the vendor's own endpoint, where compaction is on by default. */
  official(baseUrl: string): boolean
  /**
   * Compacts `req.messages` (with the request's system prompt and tools) one way. Resolves
   * with the outcome; never throws. `onProgress` is called when the server reports progress.
   */
  compact(
    method: string,
    req: ModelRequest,
    ctx: DialectContext,
    onProgress?: () => void,
  ): Promise<DialectCompactOutcome>
}

/** A wire protocol adapter. There are few dialects and many providers. */
export interface Dialect {
  id: string
  stream(req: ModelRequest, ctx: DialectContext): AsyncIterable<StreamEvent>
  /** Server-side compaction, when the dialect has one. */
  compaction?: DialectCompaction
}

/** Drains a stream and returns its final assistant message. */
export async function collect(stream: AsyncIterable<StreamEvent>): Promise<AssistantMessage> {
  for await (const ev of stream) {
    if (ev.type === "done" || ev.type === "error") return ev.message
  }
  throw new Error("stream ended without a done or error event")
}
