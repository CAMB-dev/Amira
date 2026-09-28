import { createAi } from "../src/client.ts"
import type { ModelRequest, StreamEvent } from "../src/types.ts"

export const SSE_HEADERS = { "content-type": "text/event-stream" }

export function sseBody(chunks: unknown[], done = true): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}${done ? "data: [DONE]\n\n" : ""}`
}

export function sseResponse(chunks: unknown[], done = true): Response {
  return new Response(sseBody(chunks, done), { headers: SSE_HEADERS })
}

export interface Seen {
  url?: string
  body?: any
  headers?: any
}

export function fakeFetch(res: Response | (() => Response), seen: Seen = {}) {
  return (async (url: string, init: RequestInit) => {
    seen.url = url
    seen.body = JSON.parse(init.body as string)
    seen.headers = init.headers
    return typeof res === "function" ? res() : res
  }) as unknown as typeof fetch
}

export const delta = (d: unknown, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
})

/** A client whose "test" provider speaks openai-chat through the given fetch. */
export function testAi(fetchImpl: typeof fetch) {
  return createAi({
    fetch: fetchImpl,
    // Dialect tests look at single attempts; retrying has its own tests.
    retry: { retries: 0 },
    providers: [{ id: "test", dialect: "openai-chat", baseUrl: "http://test/v1" }],
  })
}

export function request(ai: ReturnType<typeof createAi>, extra: Partial<ModelRequest> = {}): ModelRequest {
  return { model: ai.model("test/m"), systemPrompt: "", messages: [], tools: [], ...extra }
}

export async function events(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

export type ErrorEvent = Extract<StreamEvent, { type: "error" }>
export type DoneEvent = Extract<StreamEvent, { type: "done" }>

/** A real HTTP server that streams text deltas forever and records when the client goes away. */
export function endlessServer(intervalMs = 10) {
  const state = { cancelled: false, sent: 0 }
  const server = Bun.serve({
    port: 0,
    fetch() {
      const enc = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          state.sent++
          c.enqueue(enc.encode(sseBody([delta({ content: "x" })], false)))
          await Bun.sleep(intervalMs)
        },
        cancel() {
          state.cancelled = true
        },
      })
      return new Response(body, { headers: SSE_HEADERS })
    },
  })
  const ai = createAi({
    providers: [{ id: "test", dialect: "openai-chat", baseUrl: `http://localhost:${server.port}/v1` }],
  })
  return { ai, state, stop: () => server.stop(true) }
}

export async function waitFor(cond: () => boolean, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs
  while (!cond() && Date.now() < end) await Bun.sleep(5)
  return cond()
}
