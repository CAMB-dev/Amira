import type { Dialect, DialectContext, ProviderCompat } from "../dialect.ts"
import { parseSSE } from "../sse.ts"
import type { ModelRequest, StreamEvent } from "../types.ts"
import { ChatAccumulator } from "./openai-chat-accumulate.ts"
import { bodyError, isRetryableBodyError, isRetryableStatus } from "./openai-chat-errors.ts"
import { toChatMessages } from "./openai-chat-messages.ts"
import { withRetryAfter } from "./retry-after.ts"

export { toChatMessages }

export const openaiChat: Dialect = {
  id: "openai-chat",
  async *stream(req: ModelRequest, ctx: DialectContext): AsyncGenerator<StreamEvent> {
    const acc = new ChatAccumulator({ provider: req.model.provider, model: req.model.id })
    const aborted = () => acc.fail({ message: "aborted", code: "aborted" }, false)

    if (ctx.signal.aborted) {
      yield aborted()
      return
    }
    let res: Response
    try {
      res = await ctx.fetch(`${ctx.endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(ctx.endpoint.apiKey ? { authorization: `Bearer ${ctx.endpoint.apiKey}` } : {}),
          ...ctx.endpoint.headers,
        },
        body: JSON.stringify(requestBody(req, ctx.compat)),
        signal: ctx.signal,
      })
    } catch (e) {
      if (ctx.signal.aborted) yield aborted()
      else yield acc.fail({ message: `request failed: ${(e as Error).message}` }, true)
      return
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      const status = res.status
      const failed = acc.fail(
        { message: `HTTP ${status}: ${detail.slice(0, 500)}`, status },
        isRetryableStatus(status) || isRetryableBodyError({ message: detail, status }),
      )
      yield withRetryAfter(failed, res.headers)
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
      let sawDone = false
      for await (const sse of parseSSE(body, ctx.signal)) {
        if (sse.data === "[DONE]") {
          sawDone = true
          break
        }
        let chunk: any
        try {
          chunk = JSON.parse(sse.data)
        } catch {
          continue
        }
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
      yield acc.end()
    } catch (e) {
      if (ctx.signal.aborted) yield aborted()
      else yield acc.fail({ message: `stream failed: ${(e as Error).message}` }, true)
    } finally {
      // Covers consumers that stop before the body is read to the end.
      await body.cancel().catch(() => {})
    }
  },
}

function requestBody(req: ModelRequest, compat: ProviderCompat = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model.id,
    messages: toChatMessages(req.systemPrompt, req.messages, { images: req.model.caps.images }),
    stream: true,
  }
  if (compat.streamUsage !== false) body.stream_options = { include_usage: true }
  if (req.tools.length && req.model.caps.tools === "native") {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  if (req.maxTokens) body[compat.maxTokensField ?? "max_tokens"] = req.maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  return body
}

/** A 200 response that is not an event stream: an error body, a whole completion, or junk. */
async function* readPlain(res: Response, acc: ChatAccumulator): AsyncGenerator<StreamEvent> {
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {}
  if (json?.error) {
    const { error, retryable } = bodyError(json.error)
    yield acc.fail(error, retryable)
    return
  }
  const choice = json?.choices?.[0]
  if (!choice?.message) {
    const type = res.headers.get("content-type") || "no content-type"
    const message = `expected an event stream, got ${type}: ${text.slice(0, 500)}`
    yield acc.fail({ message }, isRetryableBodyError({ message }))
    return
  }
  yield { type: "start" }
  yield* acc.apply({
    usage: json.usage,
    choices: [{ delta: choice.message, finish_reason: choice.finish_reason }],
  })
  yield acc.end()
}
