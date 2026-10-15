import type { FastOption, ModelInfo, ModelRequest, StreamEvent } from "./types.ts"

/** The fast-mode beta is independent of other Messages API betas (e.g. compaction). */
export const FAST_MODE_BETA = "fast-mode-2026-02-01"

export function isAnthropicEndpoint(baseUrl: string): boolean {
  return URL.canParse(baseUrl) && new URL(baseUrl).hostname === "api.anthropic.com"
}

/** Confirmed Claude API fast prices (USD/MTok), including 5-minute cache writes.
 * https://platform.claude.com/docs/en/build-with-claude/fast-mode
 */
export function anthropicFastCost(modelId: string): NonNullable<ModelInfo["cost"]>["fast"] {
  const version = /^claude-opus-(5-5|5|4-8)(?:-\d{8})?$/.exec(modelId)?.[1]
  if (!version) return undefined
  const input = version === "5-5" ? 8 : 10
  return { input, output: input * 5, cacheRead: input * 0.1, cacheWrite: input * 1.25 }
}

// Request support is independent of pricing: account eligibility and premium rates can differ.
const OPENAI_FAST_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "o3",
  "o4-mini",
])
const openaiModel = (id: string) => OPENAI_FAST_MODELS.has(id)
const geminiModel = (id: string) =>
  /^gemini-(?:3\.8-flash|3\.6-flash|3\.5-flash-lite|3\.1-flash-lite|3\.1-pro-preview|3-flash-preview|2\.5-pro|2\.5-flash(?:-lite)?)(?:-\d{2}-\d{2}|-\d{3})?$/.test(
    id.replace(/^models\//, ""),
  )
const textGrok = (id: string) => id === "grok-4.7"

/** Best-effort presets express an option, not an account entitlement or guaranteed serving tier. */
export function builtinFastOption(vendor: string, id: string): FastOption | undefined {
  if (vendor === "anthropic" && anthropicFastCost(id)) return { kind: "anthropic-speed" }
  if (vendor === "openai" && openaiModel(id)) return { kind: "service-tier", value: "priority" }
  if ((vendor === "xai" || vendor === "x-ai") && textGrok(id))
    return { kind: "service-tier", value: "priority", textOnly: true }
  if ((vendor === "google" || vendor === "google-vertex") && geminiModel(id))
    return { kind: "service-tier", value: "priority", responseHeader: "x-gemini-service-tier" }
  if (vendor === "deepinfra" && id === "deepseek-ai/DeepSeek-V4-Flash-0731")
    return { kind: "service-tier", value: "priority" }
  if (vendor === "openrouter") {
    const [owner, ...parts] = id.split("/")
    const model = parts.join("/")
    if (
      (owner === "openai" && openaiModel(model)) ||
      (owner === "anthropic" && anthropicFastCost(model)) ||
      (owner === "google" && geminiModel(model)) ||
      ((owner === "x-ai" || owner === "xai") && textGrok(model))
    )
      return { kind: "service-tier", value: "priority" }
  }
  return undefined
}

export function sameFastTier(a: string, b: string): boolean {
  return a === b || (["fast", "priority"].includes(a) && ["fast", "priority"].includes(b))
}

/** Confirmed premiums only; gateways never inherit a direct vendor's rates. */
export function builtinFastCost(vendor: string, id: string): NonNullable<ModelInfo["cost"]>["fast"] {
  return vendor === "anthropic" ? anthropicFastCost(id) : undefined
}

/** Endpoint ownership, not the configured provider name or a borrowed catalog, selects a preset. */
export function fastVendor(baseUrl: string): string | undefined {
  if (!URL.canParse(baseUrl)) return undefined
  switch (new URL(baseUrl).hostname.toLowerCase()) {
    case "api.anthropic.com":
      return "anthropic"
    case "api.openai.com":
      return "openai"
    case "api.x.ai":
      return "xai"
    case "generativelanguage.googleapis.com":
      return "google"
    case "openrouter.ai":
      return "openrouter"
    case "api.deepinfra.com":
      return "deepinfra"
  }
}

export function compatibleFast(
  option: FastOption | false | undefined,
  dialect: string,
): FastOption | undefined {
  if (!option) return undefined
  if (option.kind === "anthropic-speed") return dialect === "anthropic-messages" ? option : undefined
  return ["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"].includes(dialect)
    ? option
    : undefined
}

/** Whether this model declares a fast option supported by its dialect. */
export function hasFastMode(model: ModelInfo): boolean {
  return compatibleFast(model.fast, model.dialect) !== undefined
}

/** The active request option; xAI priority is text-only even when its model also accepts images. */
export function fastOption(req: ModelRequest): FastOption | undefined {
  if (!req.fastMode || req.forceStandard) return undefined
  const option = compatibleFast(req.model.fast, req.model.dialect)
  if (
    option?.kind === "service-tier" &&
    option.textOnly &&
    req.messages.some((m) => m.content.some((b) => b.type === "image"))
  )
    return undefined
  return option
}

export function fastBody(req: ModelRequest): Record<string, string> {
  const configured = compatibleFast(req.model.fast, req.model.dialect)
  if (req.forceStandard && configured?.kind === "service-tier")
    return { service_tier: req.model.dialect === "google-gemini" ? "standard" : "default" }
  const option = fastOption(req)
  if (option?.kind === "anthropic-speed") return { speed: "fast" }
  if (option?.kind === "service-tier") return { service_tier: option.value }
  return {}
}

/** Only known tier-specific codes imply a status when the server sends an HTTP-200 error. */
export function fastErrorStatus(code: string | undefined): number | undefined {
  const kind =
    /^(?:fast|priority)(?:_(?:mode|speed|tier))?_(rate_limit(?:_exceeded|_error)?|capacity(?:_exceeded|_exhausted|_unavailable|_error)?|overloaded(?:_error)?)$/.exec(
      code ?? "",
    )?.[1]
  return kind ? (kind.startsWith("rate_limit") ? 429 : 529) : undefined
}

/** Inspect the provider's error, never a serialized response's request/serving metadata. */
function isFastCapacityError(error: { code?: string; message: string }): boolean {
  if (fastErrorStatus(error.code) !== undefined) return true
  const message = error.message.replace(/^HTTP \d{3}:\s*/, "").trim()
  // Unstructured HTTP bodies (and parsers without a provider message) may contain arbitrary JSON.
  if (/^[{[]/.test(message)) return false
  const text = message.replace(/[_-]+/g, " ")
  return /\b(?:fast|priority)(?:\s+(?:mode|speed|tier|processing))?\s+(?:(?:rate|requests?|tokens?)\s+limits?|capacity|overload(?:ed)?|quota)\b/i.test(
    text,
  )
}

/** Retry only tier-specific rate/capacity errors; ordinary account limits retain normal backoff. */
export async function* withFastFallback(
  req: ModelRequest,
  open: (req: ModelRequest) => AsyncIterable<StreamEvent>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  let standard = false
  for (;;) {
    let fallback = false
    let content = false
    for await (const ev of open(standard ? { ...req, fastMode: false, forceStandard: true } : req)) {
      if (
        !standard &&
        fastOption(req) &&
        ev.type === "error" &&
        !content &&
        (ev.error.status === 429 || ev.error.status === 529) &&
        isFastCapacityError(ev.error) &&
        !signal.aborted
      ) {
        yield { type: "request.end", message: ev.message }
        yield { type: "fast.fallback" }
        fallback = true
        break
      }
      if (
        ((ev.type === "text.delta" || ev.type === "thinking.delta") && ev.text.length > 0) ||
        (ev.type === "toolCall.delta" && Boolean(ev.name || ev.argsDelta)) ||
        ev.type === "serverTool"
      )
        content = true
      yield ev
    }
    if (!fallback) return
    standard = true
  }
}
