import { hasUnpricedSearch as sharedHasUnpricedSearch } from "@amira/ai-shared"
import { sameFastTier } from "./fast-mode.ts"
import { NATIVE_WEB_SEARCH } from "./server-tools.ts"
import type { AssistantMessage, ModelInfo, StreamEvent, Usage } from "./types.ts"

/** A reported search or server search block whose total cost could not be priced. */
export const hasUnpricedSearch: (message: Pick<AssistantMessage, "content" | "usage">) => boolean =
  sharedHasUnpricedSearch

function fastUsage(usage: Usage): boolean {
  // Tier interpretation belongs to withCost, which knows the model's request option.
  return usage.speed === "fast"
}

function premiumRates(usage: Usage, cost: ModelInfo["cost"]) {
  const fast = cost?.fast
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  return fast && (fast.maxInputTokens === undefined || prompt <= fast.maxInputTokens) ? fast : undefined
}

/**
 * Cost in USD of the tokens in `usage` at the model's prices (per million tokens).
 * Fast cache prices inherit standard cache/input multipliers when unspecified.
 * Cache reads and writes without a price or multiplier of their own are charged as input.
 */
export function usageCost(usage: Usage, cost: NonNullable<ModelInfo["cost"]>): number | undefined {
  if (usage.outputReported === false) return undefined
  if ((usage.webSearchRequests ?? 0) > 0 && cost.webSearch === undefined) return undefined
  // Unknown premium prices retain a standard-rate estimate, explicitly marked by withCost.
  const rates = fastUsage(usage) && !usage.pricingUnknown ? (premiumRates(usage, cost) ?? cost) : cost
  const cacheRate = (price: number | undefined, standard: number | undefined) =>
    price ??
    (fastUsage(usage) && standard !== undefined && cost.input > 0
      ? (standard / cost.input) * rates.input
      : rates.input)
  const tokens =
    usage.input * rates.input +
    usage.output * rates.output +
    usage.cacheRead * cacheRate(rates.cacheRead, cost.cacheRead) +
    usage.cacheWrite * cacheRate(rates.cacheWrite, cost.cacheWrite)
  return tokens / 1_000_000 + (usage.webSearchRequests ?? 0) * (cost.webSearch ?? 0)
}

/** Fills in `usage.cost` on the final message when the model's prices are known. */
export async function* withCost(
  stream: AsyncIterable<StreamEvent>,
  model: ModelInfo,
  requestedFast = false,
): AsyncGenerator<StreamEvent> {
  let fastRequested = requestedFast
  for await (const ev of stream) {
    if (ev.type === "fast.fallback") fastRequested = false
    const usage =
      ev.type === "done" || ev.type === "error" || ev.type === "request.end" ? ev.message.usage : undefined
    if (usage) {
      // Claude's independent service_tier never confirms speed. Messages gateways must
      // explicitly declare a service-tier option to interpret that field as fast serving.
      const usesServiceTier =
        model.dialect !== "anthropic-messages" || (model.fast && model.fast.kind === "service-tier")
      if (usage.serviceTier && usesServiceTier) {
        const configured = model.fast && model.fast.kind === "service-tier" ? model.fast.value : undefined
        usage.speed =
          ["priority", "fast", "ultrafast"].includes(usage.serviceTier) || usage.serviceTier === configured
            ? "fast"
            : "standard"
      }
      const missingEcho =
        fastRequested && usage.speed === undefined && (!usesServiceTier || usage.serviceTier === undefined)
      const expectedTier = model.fast && model.fast.kind === "service-tier" ? model.fast.value : "priority"
      const differentTier =
        usesServiceTier && usage.serviceTier !== undefined && !sameFastTier(usage.serviceTier, expectedTier)
      if ((fastUsage(usage) && (!premiumRates(usage, model.cost) || differentTier)) || missingEcho)
        usage.pricingUnknown = true
      else delete usage.pricingUnknown
    }
    if (usage && model.cost) {
      if (usage.webSearchRequests !== undefined && model.cost.webSearch !== undefined)
        usage.webSearchCost = usage.webSearchRequests * model.cost.webSearch
      const searched =
        (ev.type === "done" || ev.type === "error" || ev.type === "request.end") &&
        ev.message.content.some((b) => b.type === "serverTool" && b.name === NATIVE_WEB_SEARCH)
      const cost =
        searched && usage.webSearchRequests === undefined ? undefined : usageCost(usage, model.cost)
      if (cost !== undefined) usage.cost = cost
      else delete usage.cost
    }
    yield ev
  }
}
