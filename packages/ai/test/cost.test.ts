import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { usageCost } from "../src/cost.ts"
import { collect } from "../src/dialect.ts"
import { type AssistantMessage, addUsage, emptyUsage } from "../src/types.ts"
import { delta, fakeFetch, sseResponse } from "./helpers.ts"

test("prices each kind of token per million", () => {
  const usage = { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 100_000 }
  expect(usageCost(usage, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })).toBeCloseTo(
    3 + 7.5 + 0.6 + 0.375,
    10,
  )
  // Without cache prices, cached tokens cost as much as input.
  expect(usageCost(usage, { input: 1, output: 2 })).toBeCloseTo(1 + 1 + 2 + 0.1, 10)
  expect(usageCost(emptyUsage(), { input: 1, output: 2 })).toBe(0)
})

test("reasoning is included in output, not added to costs or token totals", () => {
  const usage = { ...emptyUsage(), output: 100, reasoning: 80 }
  expect(usageCost(usage, { input: 0, output: 10 })).toBe(0.001)
  expect(addUsage(usage, usage).output).toBe(200)
})

test("addUsage sums costs only when there are any", () => {
  expect(addUsage(emptyUsage(), emptyUsage()).cost).toBeUndefined()
  expect(addUsage({ ...emptyUsage(), cost: 0.5 }, emptyUsage()).cost).toBe(0.5)
  expect(addUsage({ ...emptyUsage(), cost: 0.5 }, { ...emptyUsage(), cost: 0.25 }).cost).toBe(0.75)
})

function priced(cost?: { input: number; output: number; cacheRead?: number }) {
  const ai = createAi({
    fetch: fakeFetch(() =>
      sseResponse([
        delta({ content: "hi" }),
        { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 400 } },
      ]),
    ),
    providers: [
      {
        id: "test",
        dialect: "openai-chat",
        baseUrl: "http://test/v1",
        ...(cost ? { defaultModel: { cost } } : {}),
      },
    ],
  })
  return collect(ai.stream({ model: ai.model("test/m"), systemPrompt: "", messages: [], tools: [] }))
}

test("the client puts the cost of each reply on its usage", async () => {
  const m: AssistantMessage = await priced({ input: 0.15, output: 0.6, cacheRead: 0.003 })
  expect(m.usage).toMatchObject({ input: 600, output: 200, cacheRead: 400 })
  expect(m.usage?.cost).toBeCloseTo((600 * 0.15 + 200 * 0.6 + 400 * 0.003) / 1e6, 12)
})

test("replies of models without prices have no cost", async () => {
  expect((await priced()).usage?.cost).toBeUndefined()
})
