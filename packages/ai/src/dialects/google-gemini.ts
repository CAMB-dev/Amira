import type { Dialect, DialectContext } from "../dialect.ts"
import { parseSSE } from "../sse.ts"
import { adaptThinking } from "../thinking.ts"
import type { ModelRequest, ReasoningEffort, StreamEvent } from "../types.ts"
import { GeminiAccumulator } from "./google-gemini-accumulate.ts"
import { GEMINI_DIALECT, toGeminiContents } from "./google-gemini-contents.ts"
import { geminiError } from "./google-gemini-errors.ts"
import { toGeminiSchema } from "./google-gemini-schema.ts"
import { parseJSON, postStream } from "./http-stream.ts"

export { toGeminiContents, toGeminiSchema }

/** Thinking budgets in tokens for each effort. */
const BUDGET: Record<ReasoningEffort, number> = { low: 1024, medium: 8192, high: 24576, max: 32768 }

/** Google's Gemini API (generativelanguage.googleapis.com/v1beta), streamed as SSE. */
export const googleGemini: Dialect = {
  id: GEMINI_DIALECT,
  stream(req: ModelRequest, ctx: DialectContext): AsyncGenerator<StreamEvent> {
    const { apiKey, baseUrl } = ctx.endpoint
    const model = req.model.id.replace(/^models\//, "")
    return postStream({
      ctx,
      acc: new GeminiAccumulator({ provider: req.model.provider, model: req.model.id }),
      url: `${baseUrl.replace(/\/$/, "")}/models/${model}:streamGenerateContent?alt=sse`,
      headers: apiKey ? { "x-goog-api-key": apiKey } : {},
      body: geminiBody(req),
      readSSE,
      readPlain,
      errorOf: geminiError,
    })
  },
}

export function geminiBody(req: ModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: toGeminiContents(adaptThinking(req.messages, GEMINI_DIALECT), {
      images: req.model.caps.images,
    }),
  }
  if (req.systemPrompt) body.systemInstruction = { parts: [{ text: req.systemPrompt }] }
  if (req.tools.length && req.model.caps.tools === "native") {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => {
          const parameters = toGeminiSchema(t.parameters)
          // An object without properties is rejected; a tool without parameters leaves them out.
          const empty = !parameters || (parameters.type === "object" && !parameters.properties)
          return { name: t.name, description: t.description, ...(empty ? {} : { parameters }) }
        }),
      },
    ]
  }
  const config: Record<string, unknown> = {}
  if (req.maxTokens) config.maxOutputTokens = req.maxTokens
  if (req.temperature !== undefined) config.temperature = req.temperature
  if (req.reasoning)
    config.thinkingConfig = { thinkingBudget: BUDGET[req.reasoning.effort], includeThoughts: true }
  if (Object.keys(config).length) body.generationConfig = config
  return body
}

async function* readSSE(
  body: ReadableStream<Uint8Array>,
  acc: GeminiAccumulator,
): AsyncGenerator<StreamEvent> {
  yield { type: "start" }
  let parsed = 0
  for await (const sse of parseSSE(body)) {
    const chunk = parseJSON(sse.data)
    if (!chunk) continue
    parsed++
    if (chunk.error) {
      const { error, retryable } = geminiError(chunk.error)
      yield acc.fail(error, retryable)
      return
    }
    yield* acc.apply(chunk)
  }
  if (parsed === 0) {
    yield acc.fail({ message: "the event stream ended without any events" }, true)
    return
  }
  yield acc.end()
}

/** A 200 response that is not an event stream: a chunk array, one whole response, an error, or junk. */
async function* readPlain(text: string, type: string, acc: GeminiAccumulator): AsyncGenerator<StreamEvent> {
  const json = parseJSON(text)
  const chunks: any[] = Array.isArray(json) ? json : json && typeof json === "object" ? [json] : []
  const failed = chunks.find((c) => c?.error)
  if (failed) {
    const { error, retryable } = geminiError(failed.error)
    yield acc.fail(error, retryable)
    return
  }
  if (!chunks.some((c) => c?.candidates || c?.promptFeedback)) {
    yield acc.fail({ message: `expected an event stream, got ${type}: ${text.slice(0, 500)}` }, false)
    return
  }
  yield { type: "start" }
  for (const chunk of chunks) yield* acc.apply(chunk)
  yield acc.end()
}
