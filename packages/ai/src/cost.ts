import { NATIVE_WEB_SEARCH } from "./server-tools.ts"
import type { AssistantMessage, ModelInfo, StreamEvent, Usage } from "./types.ts"

/** A reported search or server search block whose total cost could not be priced. */
export function hasUnpricedSearch(message: Pick<AssistantMessage, "content" | "usage">): boolean {
  return (
    message.usage?.cost === undefined &&
    ((message.usage?.webSearchRequests ?? 0) > 0 ||
      message.content.some((b) => b.type === "serverTool" && b.name === NATIVE_WEB_SEARCH))
  )
}

/**
 * Cost in USD of the tokens in `usage` at the model's prices (per million tokens).
 * Cache reads and writes without a price of their own are charged as input.
 */
export function usageCost(usage: Usage, cost: NonNullable<ModelInfo["cost"]>): number | undefined {
  if ((usage.webSearchRequests ?? 0) > 0 && cost.webSearch === undefined) return undefined
  const tokens =
    usage.input * cost.input +
    usage.output * cost.output +
    usage.cacheRead * (cost.cacheRead ?? cost.input) +
    usage.cacheWrite * (cost.cacheWrite ?? cost.input)
  return tokens / 1_000_000 + (usage.webSearchRequests ?? 0) * (cost.webSearch ?? 0)
}

/** Fills in `usage.cost` on the final message when the model's prices are known. */
export async function* withCost(
  stream: AsyncIterable<StreamEvent>,
  model: ModelInfo,
): AsyncGenerator<StreamEvent> {
  for await (const ev of stream) {
    const usage = ev.type === "done" || ev.type === "error" ? ev.message.usage : undefined
    if (usage && model.cost) {
      if (usage.webSearchRequests !== undefined && model.cost.webSearch !== undefined)
        usage.webSearchCost = usage.webSearchRequests * model.cost.webSearch
      const searched =
        (ev.type === "done" || ev.type === "error") &&
        ev.message.content.some((b) => b.type === "serverTool" && b.name === NATIVE_WEB_SEARCH)
      const cost =
        searched && usage.webSearchRequests === undefined ? undefined : usageCost(usage, model.cost)
      if (cost !== undefined) usage.cost = cost
      else delete usage.cost
    }
    yield ev
  }
}
