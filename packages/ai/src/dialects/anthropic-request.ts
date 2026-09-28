import type { ProviderCompat } from "../dialect.ts"
import type { ModelRequest, ReasoningEffort } from "../types.ts"
import {
  type AnthropicMessage,
  type CacheControl,
  markCacheBreakpoints,
  toAnthropicMessages,
} from "./anthropic-messages.ts"

/** The API allows at most this many cache_control markers per request. */
const MAX_BREAKPOINTS = 4
const MAX_TOKENS_CAP = 128_000
const MIN_THINKING_BUDGET = 1_024

export const THINKING_BUDGET: Record<ReasoningEffort, number> = {
  low: 2_048,
  medium: 8_192,
  high: 24_576,
  max: 64_000,
}

const EPHEMERAL: CacheControl = { type: "ephemeral" }

export function requestBody(req: ModelRequest, compat: ProviderCompat = {}): Record<string, unknown> {
  const sendTools = req.tools.length > 0 && req.model.caps.tools === "native"
  const messages = toAnthropicMessages(req.messages, { tools: sendTools })
  const maxTokens = Math.max(
    1,
    Math.min(req.maxTokens ?? req.model.maxOutput, req.model.maxOutput, MAX_TOKENS_CAP),
  )
  const body: Record<string, unknown> = { model: req.model.id, max_tokens: maxTokens, stream: true }
  // Caps default to promptCache: false, so an Anthropic provider turns it on in its model caps.
  const cache = req.promptCache !== false && req.model.caps.promptCache
  let breakpoints = 0

  if (req.systemPrompt) {
    body.system = [{ type: "text", text: req.systemPrompt, ...(cache ? { cache_control: EPHEMERAL } : {}) }]
    if (cache) breakpoints++
  }
  if (sendTools) {
    const tools: Record<string, unknown>[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
    if (cache) {
      tools[tools.length - 1]!.cache_control = EPHEMERAL
      breakpoints++
    }
    body.tools = tools
  }
  if (cache) markCacheBreakpoints(messages, MAX_BREAKPOINTS - breakpoints)
  body.messages = messages

  if (compat.thinking === "budget") budgetThinking(body, req, maxTokens, messages)
  else adaptiveThinking(body, req)
  return body
}

/** Current Claude models: an effort level, and no temperature, budget or `disabled` at all. */
function adaptiveThinking(body: Record<string, unknown>, req: ModelRequest) {
  if (!req.reasoning || !req.model.caps.thinking) return
  body.thinking = { type: "adaptive" }
  body.output_config = { effort: req.reasoning.effort }
}

/** Claude 4.5 and older, and DeepSeek: a token budget below max_tokens. */
function budgetThinking(
  body: Record<string, unknown>,
  req: ModelRequest,
  maxTokens: number,
  messages: AnthropicMessage[],
) {
  // With thinking on, these servers reject a tool loop whose assistant turn does not start
  // with thinking, as when the turn came from another provider. DeepSeek thinks unless
  // told otherwise, so thinking is switched off explicitly then.
  const unsigned = req.reasoning !== undefined && unsignedToolLoop(messages)
  const budget = unsigned ? undefined : thinkingBudget(req, maxTokens)
  if (budget) body.thinking = { type: "enabled", budget_tokens: budget }
  else if (unsigned) body.thinking = { type: "disabled" }
  // Extended thinking rejects any temperature other than the default.
  if (!budget && req.temperature !== undefined) body.temperature = req.temperature
}

/** The budget to think with, or undefined when thinking is off or cannot fit. */
function thinkingBudget(req: ModelRequest, maxTokens: number): number | undefined {
  if (!req.reasoning || !req.model.caps.thinking) return undefined
  // Leave room for the answer below max_tokens.
  const budget = Math.min(THINKING_BUDGET[req.reasoning.effort], maxTokens - MIN_THINKING_BUDGET)
  return budget < MIN_THINKING_BUDGET ? undefined : budget
}

/**
 * The request continues a tool loop, and the loop's first assistant turn (the one after the
 * last user turn that is not only tool results) does not start with signed thinking.
 */
export function unsignedToolLoop(messages: AnthropicMessage[]): boolean {
  const last = messages.at(-1)
  if (last?.role !== "user" || !last.content.some((b) => b.type === "tool_result")) return false
  let start = 0
  for (let i = messages.length - 2; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === "user" && m.content.some((b) => b.type !== "tool_result")) {
      start = i + 1
      break
    }
  }
  const first = messages.slice(start).find((m) => m.role === "assistant")?.content[0]
  return first?.type !== "thinking" && first?.type !== "redacted_thinking"
}
