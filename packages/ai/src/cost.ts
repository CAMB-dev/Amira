import type { ModelInfo, StreamEvent, Usage } from "./types.ts"

/**
 * Cost in USD of the tokens in `usage` at the model's prices (per million tokens).
 * Cache reads and writes without a price of their own are charged as input.
 */
export function usageCost(usage: Usage, cost: NonNullable<ModelInfo["cost"]>): number {
  const tokens =
    usage.input * cost.input +
    usage.output * cost.output +
    usage.cacheRead * (cost.cacheRead ?? cost.input) +
    usage.cacheWrite * (cost.cacheWrite ?? cost.input)
  return tokens / 1_000_000
}

/** Fills in `usage.cost` on the final message when the model's prices are known. */
export async function* withCost(
  stream: AsyncIterable<StreamEvent>,
  model: ModelInfo,
): AsyncGenerator<StreamEvent> {
  for await (const ev of stream) {
    const usage = ev.type === "done" || ev.type === "error" ? ev.message.usage : undefined
    if (usage && model.cost) usage.cost = usageCost(usage, model.cost)
    yield ev
  }
}
