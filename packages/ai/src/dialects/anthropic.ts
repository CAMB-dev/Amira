import type { Dialect, DialectContext } from "../dialect.ts"
import { FAST_MODE_BETA, fastBody } from "../fast-mode.ts"
import { parseSSE } from "../sse.ts"
import type { ModelRequest, StreamEvent } from "../types.ts"
import { MessagesAccumulator } from "./anthropic-accumulate.ts"
import { anthropicCompaction, COMPACT_BETA, carriesCompaction, withBeta } from "./anthropic-compact.ts"
import { anthropicError, isRetryableStatus } from "./anthropic-errors.ts"
import { ANTHROPIC_DIALECT, toAnthropicMessages } from "./anthropic-messages.ts"
import { requestBody } from "./anthropic-request.ts"
import { parseJSON, postStream } from "./http-stream.ts"
import { isRetryableBodyError } from "./openai-chat-errors.ts"

export { toAnthropicMessages }

export const ANTHROPIC_VERSION = "2023-06-01"

export const anthropicMessages: Dialect = {
  id: ANTHROPIC_DIALECT,
  stream: streamAttempt,
  compaction: anthropicCompaction,
}

function streamAttempt(req: ModelRequest, ctx: DialectContext): AsyncGenerator<StreamEvent> {
  const payload = requestBody(req, ctx.compat, ctx.endpoint.baseUrl)
  Object.assign(payload, fastBody(req))
  const thinking = payload.thinking as { type: string; display?: "summarized" | "omitted" } | undefined
  const official =
    URL.canParse(ctx.endpoint.baseUrl) && new URL(ctx.endpoint.baseUrl).hostname === "api.anthropic.com"
  const thinkingDisplay = thinking?.display ?? (official || thinking?.type === "disabled" ? undefined : "raw")
  return postStream({
    ctx,
    acc: new MessagesAccumulator({ provider: req.model.provider, model: req.model.id }),
    url: messagesUrl(ctx.endpoint.baseUrl),
    headers: {
      "anthropic-version": ANTHROPIC_VERSION,
      ...(ctx.endpoint.apiKey ? { "x-api-key": ctx.endpoint.apiKey } : {}),
    },
    transformHeaders: (headers) => {
      // Each feature adds its beta to the provider's existing list, regardless of header case.
      let next = headers
      if (carriesCompaction(payload.messages)) next = withBeta(next, COMPACT_BETA)
      if (payload.speed === "fast") next = withBeta(next, FAST_MODE_BETA)
      return next
    },
    body: payload,
    thinkingDisplay,
    readSSE,
    readPlain,
    errorOf: anthropicError,
    retryableStatus: isRetryableStatus,
  })
}

/** `{baseUrl}/v1/messages`, tolerating a base URL that already ends in /v1. */
export function messagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "")
  return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`
}

async function* readSSE(
  body: ReadableStream<Uint8Array>,
  acc: MessagesAccumulator,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  yield { type: "start" }
  let parsed = 0
  for await (const sse of parseSSE(body, signal)) {
    const ev = parseJSON(sse.data)
    if (!ev) continue
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
}

/** A 200 response that is not an event stream: an error body, a whole message, or junk. */
async function* readPlain(text: string, type: string, acc: MessagesAccumulator): AsyncGenerator<StreamEvent> {
  const json = parseJSON(text)
  if (json?.type === "error" || json?.error) {
    const { error, retryable } = anthropicError(json)
    yield acc.fail(error, retryable)
    return
  }
  if (json?.type !== "message" || !Array.isArray(json.content)) {
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
