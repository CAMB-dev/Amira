import type { Dialect, DialectContext } from "../dialect.ts"
import { requestHeaders } from "../request-headers.ts"
import { parseSSE } from "../sse.ts"
import type { ModelRequest, StreamEvent } from "../types.ts"
import { MessagesAccumulator } from "./anthropic-accumulate.ts"
import { anthropicCompaction, COMPACT_BETA, carriesCompaction, withBeta } from "./anthropic-compact.ts"
import { anthropicError, isRetryableStatus } from "./anthropic-errors.ts"
import { ANTHROPIC_DIALECT, toAnthropicMessages } from "./anthropic-messages.ts"
import { requestBody } from "./anthropic-request.ts"
import { isRetryableBodyError } from "./openai-chat-errors.ts"
import { withRetryAfter } from "./retry-after.ts"

export { toAnthropicMessages }

export const ANTHROPIC_VERSION = "2023-06-01"

export const anthropicMessages: Dialect = {
  id: ANTHROPIC_DIALECT,
  async *stream(req: ModelRequest, ctx: DialectContext): AsyncGenerator<StreamEvent> {
    const acc = new MessagesAccumulator({ provider: req.model.provider, model: req.model.id })
    const aborted = () => acc.fail({ message: "aborted", code: "aborted" }, false)

    if (ctx.signal.aborted) {
      yield aborted()
      return
    }
    let res: Response
    try {
      const payload = requestBody(req, ctx.compat, ctx.endpoint.baseUrl)
      const headers = requestHeaders(
        {
          "content-type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
          ...(ctx.endpoint.apiKey ? { "x-api-key": ctx.endpoint.apiKey } : {}),
        },
        ctx.endpoint.headers,
        ctx.userAgent,
      )
      const init = {
        method: "POST",
        // Every request that carries a compaction block needs the beta that made it.
        headers: carriesCompaction(payload.messages) ? withBeta(headers, COMPACT_BETA) : headers,
        body: JSON.stringify(payload),
        signal: ctx.signal,
      }
      const thinking = payload.thinking as { type: string; display?: "summarized" | "omitted" } | undefined
      const official =
        URL.canParse(ctx.endpoint.baseUrl) && new URL(ctx.endpoint.baseUrl).hostname === "api.anthropic.com"
      const thinkingDisplay =
        thinking?.display ?? (official || thinking?.type === "disabled" ? undefined : "raw")
      if (ctx.signal.aborted) {
        yield aborted()
        return
      }
      yield { type: "request.start", ...(thinkingDisplay ? { thinkingDisplay } : {}) }
      res = await ctx.fetch(messagesUrl(ctx.endpoint.baseUrl), init)
    } catch (e) {
      if (ctx.signal.aborted) yield aborted()
      else yield acc.fail({ message: `request failed: ${(e as Error).message}` }, true)
      return
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      yield withRetryAfter(httpError(acc, res.status, detail), res.headers)
      return
    }
    if (!res.body) {
      yield acc.fail({ message: `HTTP ${res.status} with an empty body`, status: res.status }, true)
      return
    }

    const body = res.body
    try {
      if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        yield* readPlain(res, acc)
        return
      }
      yield { type: "start" }
      let parsed = 0
      for await (const sse of parseSSE(body, ctx.signal)) {
        let ev: any
        try {
          ev = JSON.parse(sse.data)
        } catch {
          continue
        }
        parsed++
        for (const out of acc.apply(ev)) {
          yield out
          if (out.type === "error") return
        }
        if (ev?.type === "message_stop") break
      }
      if (parsed === 0) {
        yield acc.fail({ message: "the event stream ended without any events" }, true)
        return
      }
      if (!acc.finished) {
        yield acc.fail({ message: "the event stream ended before the message was complete" }, true)
        return
      }
      yield acc.end()
    } catch (e) {
      if (ctx.signal.aborted) yield aborted()
      else yield acc.fail({ message: `stream failed: ${(e as Error).message}` }, true)
    } finally {
      // Covers consumers that stop before the body is read to the end.
      await body.cancel().catch(() => {})
    }
  },
  compaction: anthropicCompaction,
}

/** `{baseUrl}/v1/messages`, tolerating a base URL that already ends in /v1. */
export function messagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "")
  return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`
}

function httpError(acc: MessagesAccumulator, status: number, detail: string): StreamEvent {
  let json: unknown
  try {
    json = JSON.parse(detail)
  } catch {}
  const parsed =
    json && typeof json === "object" && "error" in json ? anthropicError(json, status) : undefined
  const message = `HTTP ${status}: ${parsed ? parsed.error.message : detail.slice(0, 500)}`
  return acc.fail(
    { ...parsed?.error, message, status },
    isRetryableStatus(status) || (parsed ? parsed.retryable : isRetryableBodyError({ message, status })),
  )
}

/** A 200 response that is not an event stream: an error body, a whole message, or junk. */
async function* readPlain(res: Response, acc: MessagesAccumulator): AsyncGenerator<StreamEvent> {
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {}
  if (json?.type === "error" || json?.error) {
    const { error, retryable } = anthropicError(json)
    yield acc.fail(error, retryable)
    return
  }
  if (json?.type !== "message" || !Array.isArray(json.content)) {
    const type = res.headers.get("content-type") || "no content-type"
    const message = `expected an event stream, got ${type}: ${text.slice(0, 500)}`
    yield acc.fail({ message }, isRetryableBodyError({ message }))
    return
  }
  yield { type: "start" }
  for (const ev of replayMessage(json)) yield* acc.apply(ev)
  yield acc.end()
}

/** The stream events a whole message would have arrived as. */
function* replayMessage(msg: any): Generator<unknown> {
  yield { type: "message_start", message: { usage: msg.usage } }
  for (const [index, block] of (msg.content as any[]).entries()) {
    if (block?.type === "tool_use") {
      yield { type: "content_block_start", index, content_block: { ...block, input: {} } }
      const json = JSON.stringify(block.input ?? {})
      yield { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } }
    } else {
      yield { type: "content_block_start", index, content_block: block }
    }
    yield { type: "content_block_stop", index }
  }
  yield {
    type: "message_delta",
    delta: { stop_reason: msg.stop_reason, stop_details: msg.stop_details },
    usage: msg.usage,
  }
  yield { type: "message_stop" }
}
