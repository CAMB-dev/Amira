import type { Dialect, DialectContext, ProviderCompat } from "../dialect.ts"
import { fastBody } from "../fast-mode.ts"
import { DEFAULT_MAX_TOKENS_FIELD, DEFAULT_STREAM_USAGE } from "../settings-defaults.ts"
import { parseSSE } from "../sse.ts"
import type { ModelRequest, StreamEvent } from "../types.ts"
import { parseJSON, postStream } from "./http-stream.ts"
import { ChatAccumulator } from "./openai-chat-accumulate.ts"
import { bodyError, isRetryableBodyError } from "./openai-chat-errors.ts"
import { toChatMessages } from "./openai-chat-messages.ts"

export { toChatMessages }

export const openaiChat: Dialect = {
  id: "openai-chat",
  stream(req: ModelRequest, ctx: DialectContext): AsyncGenerator<StreamEvent> {
    const { apiKey, baseUrl } = ctx.endpoint
    return postStream({
      ctx,
      acc: new ChatAccumulator({ provider: req.model.provider, model: req.model.id }),
      url: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      body: requestBody(req, ctx.compat),
      thinkingDisplay: "raw",
      readSSE,
      readPlain,
    })
  },
}

function requestBody(req: ModelRequest, compat: ProviderCompat = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model.id,
    messages: toChatMessages(req.systemPrompt, req.messages, { images: req.model.caps.images }),
    stream: true,
    ...fastBody(req),
  }
  if ((compat.streamUsage ?? DEFAULT_STREAM_USAGE) !== false) body.stream_options = { include_usage: true }
  if (req.tools.length && req.model.caps.tools === "native") {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  if (req.toolChoice === "none") body.tool_choice = "none"
  if (req.maxTokens) body[compat.maxTokensField ?? DEFAULT_MAX_TOKENS_FIELD] = req.maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  return body
}

async function* readSSE(
  body: ReadableStream<Uint8Array>,
  acc: ChatAccumulator,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  yield { type: "start" }
  let parsed = 0
  let sawDone = false
  for await (const sse of parseSSE(body, signal)) {
    if (sse.data === "[DONE]") {
      sawDone = true
      break
    }
    const chunk = parseJSON(sse.data)
    if (!chunk) continue
    parsed++
    if (chunk.error) {
      const { error, retryable } = bodyError(chunk.error)
      yield acc.fail(error, retryable)
      return
    }
    yield* acc.apply(chunk)
  }
  if (parsed === 0 && !sawDone) {
    yield acc.fail({ message: "the event stream ended without any events" }, true)
    return
  }
  // Some servers never send [DONE] but do send a finish_reason; with neither, the
  // connection dropped mid-reply.
  if (!sawDone && !acc.finished) {
    yield acc.fail({ message: "the event stream ended before the reply was complete" }, true)
    return
  }
  yield* acc.finishThinking()
  yield acc.end()
}

/** A 200 response that is not an event stream: an error body, a whole completion, or junk. */
async function* readPlain(text: string, type: string, acc: ChatAccumulator): AsyncGenerator<StreamEvent> {
  const json = parseJSON(text)
  if (json?.error) {
    const { error, retryable } = bodyError(json.error)
    yield acc.fail(error, retryable)
    return
  }
  const choice = json?.choices?.[0]
  if (!choice?.message) {
    const message = `expected an event stream, got ${type}: ${text.slice(0, 500)}`
    yield acc.fail({ message }, isRetryableBodyError({ message }))
    return
  }
  yield { type: "start" }
  yield* acc.apply({
    usage: json.usage,
    service_tier: json.service_tier,
    choices: [{ delta: choice.message, finish_reason: choice.finish_reason }],
  })
  yield* acc.finishThinking()
  yield acc.end()
}
