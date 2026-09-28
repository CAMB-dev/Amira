import type { DialectContext } from "../dialect.ts"
import type { ModelError, StreamEvent } from "../types.ts"
import { bodyError, isRetryableStatus } from "./openai-chat-errors.ts"

export type ErrorEvent = Extract<StreamEvent, { type: "error" }>

/** The part of an accumulator the HTTP driver needs to report failures. */
export interface Failable {
  fail(error: ModelError, retryable: boolean): ErrorEvent
}

export interface StreamRequest<A extends Failable> {
  ctx: DialectContext
  acc: A
  url: string
  headers: Record<string, string>
  body: unknown
  /** Reads an event stream; must end with one done or error event. */
  readSSE(body: ReadableStream<Uint8Array>, acc: A): AsyncGenerator<StreamEvent>
  /** Reads a 200 response that is not an event stream. */
  readPlain(text: string, contentType: string, acc: A): AsyncGenerator<StreamEvent>
  /** Maps an HTTP error body's `error` field; defaults to the OpenAI shape. */
  errorOf?(raw: unknown): { error: ModelError; retryable: boolean }
}

/**
 * POSTs a streaming request and hands the body to the dialect. Owns the failure paths
 * shared by all dialects: aborts, network errors, HTTP errors, and cancelling the body
 * when the consumer stops early.
 */
export async function* postStream<A extends Failable>(r: StreamRequest<A>): AsyncGenerator<StreamEvent> {
  const { ctx, acc } = r
  const aborted = () => acc.fail({ message: "aborted", code: "aborted" }, false)
  if (ctx.signal.aborted) {
    yield aborted()
    return
  }
  let res: Response
  try {
    res = await ctx.fetch(r.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...r.headers, ...ctx.endpoint.headers },
      body: JSON.stringify(r.body),
      signal: ctx.signal,
    })
  } catch (e) {
    if (ctx.signal.aborted) yield aborted()
    else yield acc.fail({ message: `request failed: ${(e as Error).message}` }, true)
    return
  }
  if (!res.ok) {
    yield acc.fail(...httpError(res.status, await res.text().catch(() => ""), r.errorOf ?? bodyError))
    return
  }
  if (!res.body) {
    yield acc.fail({ message: `HTTP ${res.status} with an empty body`, status: res.status }, true)
    return
  }

  const body = res.body
  try {
    const type = res.headers.get("content-type") ?? ""
    const events = type.includes("text/event-stream")
      ? r.readSSE(body, acc)
      : r.readPlain(await res.text(), type || "no content-type", acc)
    // Exactly one terminal event, whatever the reader does.
    for await (const ev of events) {
      yield ev
      if (ev.type === "done" || ev.type === "error") return
    }
    yield acc.fail({ message: "the response ended without a result" }, true)
  } catch (e) {
    if (ctx.signal.aborted) yield aborted()
    else yield acc.fail({ message: `stream failed: ${(e as Error).message}` }, true)
  } finally {
    // Covers consumers that stop before the body is read to the end.
    await body.cancel().catch(() => {})
  }
}

/** Keeps the status and, when the body has one, the provider's error code. */
function httpError(
  status: number,
  detail: string,
  errorOf: NonNullable<StreamRequest<Failable>["errorOf"]>,
): [ModelError, boolean] {
  const error: ModelError = { message: `HTTP ${status}: ${detail.slice(0, 500)}`, status }
  try {
    const parsed = JSON.parse(detail)
    const raw = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error
    if (raw !== undefined) {
      const code = errorOf(raw).error.code
      if (code) error.code = code
    }
  } catch {}
  return [error, isRetryableStatus(status)]
}

/** Parses an SSE data field as JSON, or returns undefined for junk. */
export function parseJSON(data: string): any {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}
