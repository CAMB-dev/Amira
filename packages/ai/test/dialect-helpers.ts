import type { Dialect, DialectContext } from "../src/dialect.ts"
import { DEFAULT_CAPS } from "../src/providers.ts"
import type { ModelCaps, ModelRequest, StreamEvent } from "../src/types.ts"
import { events, type Seen, SSE_HEADERS } from "./helpers.ts"

/** A request for a dialect under test, called directly without a client. */
export function req(
  dialect: string,
  extra: Partial<ModelRequest> = {},
  caps: Partial<ModelCaps> = {},
): ModelRequest {
  return {
    model: {
      id: "m",
      provider: "test",
      dialect,
      contextWindow: 100_000,
      maxOutput: 8_000,
      caps: { ...DEFAULT_CAPS, ...caps },
    },
    systemPrompt: "",
    messages: [],
    tools: [],
    ...extra,
  }
}

/** SSE with a named event per chunk, as the Responses API sends it. */
export function namedSSE(chunks: { type: string; [key: string]: unknown }[]): string {
  return chunks.map((c) => `event: ${c.type}\ndata: ${JSON.stringify(c)}\n\n`).join("")
}

/** SSE with data lines only, as Gemini sends it. */
export function dataSSE(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")
}

export function sse(text: string): Response {
  return new Response(text, { headers: SSE_HEADERS })
}

export function ctx(res: Response | (() => Response), seen: Seen = {}, signal?: AbortSignal): DialectContext {
  return {
    endpoint: { baseUrl: "http://test/v1/", apiKey: "k" },
    signal: signal ?? new AbortController().signal,
    fetch: (async (url: string, init: RequestInit) => {
      seen.url = url
      seen.body = JSON.parse(init.body as string)
      seen.headers = init.headers
      return typeof res === "function" ? res() : res
    }) as unknown as typeof fetch,
  }
}

export async function run(dialect: Dialect, r: ModelRequest, res: Response | (() => Response)) {
  const seen: Seen = {}
  const evs = await events(dialect.stream(r, ctx(res, seen)))
  return { evs, seen, last: evs.at(-1) as StreamEvent }
}

export const terminal = (evs: StreamEvent[]) => evs.filter((e) => e.type === "done" || e.type === "error")

/** A real HTTP server streaming `chunk()` forever; records when the client goes away. */
export function endless(chunk: () => string, intervalMs = 10) {
  const state = { cancelled: false, sent: 0 }
  const server = Bun.serve({
    port: 0,
    fetch() {
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          c.enqueue(enc.encode(chunk()))
          state.sent++
          await Bun.sleep(intervalMs)
        },
        cancel() {
          state.cancelled = true
        },
      })
      return new Response(body, { headers: SSE_HEADERS })
    },
  })
  const context = (signal?: AbortSignal): DialectContext => ({
    endpoint: { baseUrl: `http://localhost:${server.port}/v1`, apiKey: "k" },
    signal: signal ?? new AbortController().signal,
    fetch,
  })
  return { context, state, stop: () => server.stop(true) }
}
