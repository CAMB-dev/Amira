import type { Dialect, DialectContext } from "../dialect.ts"
import { hasNativeWebSearch, isGemini3 } from "../server-tools.ts"
import { parseSSE } from "../sse.ts"
import { adaptThinking } from "../thinking.ts"
import type { ModelRequest, ReasoningEffort, StreamEvent } from "../types.ts"
import { GeminiAccumulator } from "./google-gemini-accumulate.ts"
import { GEMINI_DIALECT, toGeminiContents } from "./google-gemini-contents.ts"
import { geminiError } from "./google-gemini-errors.ts"
import { toGeminiSchema } from "./google-gemini-schema.ts"
import { parseJSON, postStream } from "./http-stream.ts"
import { isRetryableBodyError } from "./openai-chat-errors.ts"

export { toGeminiContents, toGeminiSchema }

/** Thinking budgets in tokens; 24576 is the most every 2.5 model accepts, only Pro goes higher. */
const BUDGET: Record<ReasoningEffort, number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 24576,
  max: 24576,
}
const PRO_MAX_BUDGET = 32768

const LEVEL: Record<ReasoningEffort, string> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "HIGH",
  max: "HIGH",
}

/** Gemini 3 takes a thinking level and rejects budgets as a way to set it; older models take a budget. */
export function thinkingConfig(modelId: string, effort: ReasoningEffort): Record<string, unknown> {
  if (/gemini-3/.test(modelId)) return { thinkingLevel: LEVEL[effort], includeThoughts: true }
  const budget = effort === "max" && /2\.5-pro/.test(modelId) ? PRO_MAX_BUDGET : BUDGET[effort]
  return { thinkingBudget: budget, includeThoughts: true }
}

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
  const sendTools = req.tools.length > 0 && req.model.caps.tools === "native"
  const webSearch = hasNativeWebSearch(req.model, sendTools)
  const body: Record<string, unknown> = {
    contents: toGeminiContents(adaptThinking(req.messages, GEMINI_DIALECT), {
      images: req.model.caps.images,
      // Tool context circulation is documented only for Gemini 3, even in search-only requests.
      webSearch: webSearch && isGemini3(req.model.id),
    }),
  }
  if (req.systemPrompt) body.systemInstruction = { parts: [{ text: req.systemPrompt }] }
  if (sendTools) {
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
  if (webSearch) {
    body.tools = [...((body.tools as Record<string, unknown>[]) ?? []), { googleSearch: {} }]
    if (isGemini3(req.model.id)) body.toolConfig = { includeServerSideToolInvocations: true }
  }
  const config: Record<string, unknown> = {}
  if (req.maxTokens) config.maxOutputTokens = req.maxTokens
  if (req.temperature !== undefined) config.temperature = req.temperature
  if (req.reasoning) config.thinkingConfig = thinkingConfig(req.model.id, req.reasoning.effort)
  if (Object.keys(config).length) body.generationConfig = config
  return body
}

async function* readSSE(
  body: ReadableStream<Uint8Array>,
  acc: GeminiAccumulator,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  yield { type: "start" }
  let parsed = 0
  for await (const sse of parseSSE(body, signal)) {
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
    const message = `expected an event stream, got ${type}: ${text.slice(0, 500)}`
    yield acc.fail({ message }, isRetryableBodyError({ message }))
    return
  }
  yield { type: "start" }
  for (const chunk of chunks) yield* acc.apply(chunk)
  yield acc.end()
}
