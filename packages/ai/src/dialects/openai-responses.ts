import type { Dialect, DialectContext } from "../dialect.ts"
import { hasNativeWebSearch } from "../server-tools.ts"
import { parseSSE } from "../sse.ts"
import { adaptThinking } from "../thinking.ts"
import type { ModelRequest, ReasoningEffort, StreamEvent } from "../types.ts"
import { parseJSON, postStream } from "./http-stream.ts"
import { ResponsesAccumulator } from "./openai-responses-accumulate.ts"
import { responsesCompaction } from "./openai-responses-compact.ts"
import { responsesError } from "./openai-responses-errors.ts"
import { RESPONSES_DIALECT, toResponsesInput } from "./openai-responses-input.ts"

export { toResponsesInput }

/** OpenAI Responses API, used statelessly: `store: false`, reasoning replayed from encrypted content. */
export const openaiResponses: Dialect = {
  id: RESPONSES_DIALECT,
  stream(req: ModelRequest, ctx: DialectContext): AsyncGenerator<StreamEvent> {
    const { apiKey, baseUrl } = ctx.endpoint
    return postStream({
      ctx,
      acc: new ResponsesAccumulator({ provider: req.model.provider, model: req.model.id }),
      url: `${baseUrl.replace(/\/$/, "")}/responses`,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      body: responsesBody(req),
      readSSE,
      readPlain,
    })
  },
  // Function declarations below are hoisted, so they can be handed over here.
  compaction: responsesCompaction((req) => responsesBody(req), { readSSE, readPlain }),
}

export function responsesBody(req: ModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model.id,
    input: toResponsesInput(adaptThinking(req.messages, RESPONSES_DIALECT), {
      images: req.model.caps.images,
    }),
    stream: true,
    store: false,
  }
  if (req.systemPrompt) body.instructions = req.systemPrompt
  if (req.tools.length && req.model.caps.tools === "native") {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      // Responses makes function schemas strict unless told otherwise, which rejects most real schemas.
      strict: false,
    }))
  }
  if (req.maxTokens) body.max_output_tokens = req.maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.reasoning) {
    // Summaries are the only readable reasoning; the encrypted content lets it be replayed.
    body.reasoning = { effort: effortOf(req.reasoning.effort), summary: "auto" }
    body.include = ["reasoning.encrypted_content"]
  }
  addWebSearch(req, body)
  return body
}

/**
 * The hosted web search, as a server tool beside the functions (never as a function of that
 * name), when the model has it (hasNativeWebSearch); the model decides when to search. The
 * sources it looked at are asked for, where the server lists them.
 */
function addWebSearch(req: ModelRequest, body: Record<string, unknown>) {
  if (!hasNativeWebSearch(req.model)) return
  const tools = (body.tools as Record<string, unknown>[] | undefined) ?? []
  if (!tools.some((t) => t.type === "web_search")) tools.push({ type: "web_search" })
  body.tools = tools
  body.include = [...((body.include as string[] | undefined) ?? []), "web_search_call.action.sources"]
}

function effortOf(e: ReasoningEffort): "low" | "medium" | "high" {
  return e === "max" ? "high" : e
}

async function* readSSE(
  body: ReadableStream<Uint8Array>,
  acc: ResponsesAccumulator,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  yield { type: "start" }
  for await (const sse of parseSSE(body, signal)) {
    if (sse.data === "[DONE]") break
    const ev = parseJSON(sse.data)
    if (!ev) continue
    // Some servers name the event only in the SSE `event:` field.
    if (!ev.type && sse.event) ev.type = sse.event
    yield* acc.apply(ev)
    if (acc.terminal) {
      yield acc.terminal
      return
    }
  }
  yield acc.fail({ message: "the event stream ended before the response completed" }, true)
}

/** A 200 response that is not an event stream: an error body, a whole response, or junk. */
async function* readPlain(
  text: string,
  type: string,
  acc: ResponsesAccumulator,
): AsyncGenerator<StreamEvent> {
  const json = parseJSON(text)
  if (json?.error && !Array.isArray(json.output)) {
    const { error, retryable } = responsesError(json.error)
    yield acc.fail(error, retryable)
    return
  }
  if (!Array.isArray(json?.output)) {
    yield acc.fail({ message: `expected an event stream, got ${type}: ${text.slice(0, 500)}` }, false)
    return
  }
  yield { type: "start" }
  for (const [i, item] of json.output.entries()) {
    yield* acc.apply({ type: "response.output_item.done", output_index: i, item })
  }
  const status =
    json.status === "failed"
      ? "response.failed"
      : json.status === "incomplete"
        ? "response.incomplete"
        : "response.completed"
  yield* acc.apply({ type: status, response: json })
  yield acc.terminal ?? acc.end()
}
