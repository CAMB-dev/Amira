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

export function requestBody(req: ModelRequest): Record<string, unknown> {
  const messages = toAnthropicMessages(req.messages)
  const maxTokens = Math.max(
    1,
    Math.min(req.maxTokens ?? req.model.maxOutput, req.model.maxOutput, MAX_TOKENS_CAP),
  )
  const body: Record<string, unknown> = { model: req.model.id, max_tokens: maxTokens, stream: true }
  const cache = req.promptCache !== false
  let breakpoints = 0

  if (req.systemPrompt) {
    body.system = [{ type: "text", text: req.systemPrompt, ...(cache ? { cache_control: EPHEMERAL } : {}) }]
    if (cache) breakpoints++
  }
  if (req.tools.length && req.model.caps.tools === "native") {
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

  // With thinking on, the API rejects a tool loop whose assistant turn does not start with
  // thinking, as when the turn came from another provider. Servers that think by default
  // (DeepSeek) need thinking switched off explicitly then.
  const unsigned = unsignedToolTurn(messages)
  const budget = unsigned ? undefined : thinkingBudget(req, maxTokens)
  if (budget) body.thinking = { type: "enabled", budget_tokens: budget }
  else if (unsigned) body.thinking = { type: "disabled" }
  // Extended thinking rejects any temperature other than the default.
  if (!budget && req.temperature !== undefined) body.temperature = req.temperature
  return body
}

/** The budget to think with, or undefined when thinking is off or cannot fit. */
function thinkingBudget(req: ModelRequest, maxTokens: number): number | undefined {
  if (!req.reasoning || !req.model.caps.thinking) return undefined
  // Leave room for the answer below max_tokens.
  const budget = Math.min(THINKING_BUDGET[req.reasoning.effort], maxTokens - MIN_THINKING_BUDGET)
  return budget < MIN_THINKING_BUDGET ? undefined : budget
}

/** The request continues a tool loop whose assistant turn carries no signed thinking. */
function unsignedToolTurn(messages: AnthropicMessage[]): boolean {
  const last = messages.at(-1)
  if (last?.role !== "user" || !last.content.some((b) => b.type === "tool_result")) return false
  const first = messages.at(-2)?.content[0]
  return first?.type !== "thinking" && first?.type !== "redacted_thinking"
}
