import type { AssistantMessage, ModelRequest, StreamEvent } from "./types.ts"

/** Credentials and endpoint a dialect talks to, resolved from a provider config. */
export interface Endpoint {
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
}

export interface DialectContext {
  endpoint: Endpoint
  signal: AbortSignal
  fetch: typeof fetch
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
