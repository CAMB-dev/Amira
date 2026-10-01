import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { usageCost, withCost } from "../src/cost.ts"
import { resolveModelInfo } from "../src/providers.ts"
import { defaultWebSearch, hasNativeWebSearch } from "../src/server-tools.ts"
import { addUsage, emptyUsage, type ModelInfo, type StreamEvent } from "../src/types.ts"

test("new dialects default only on their official hosts, and compat and model caps override them", () => {
  for (const [dialect, baseUrl, id] of [
    ["anthropic-messages", "https://api.anthropic.com/v1", "claude"],
    ["google-gemini", "https://generativelanguage.googleapis.com/v1beta", "gemini-3-flash-preview"],
  ]) {
    const p = { id: "p", dialect: dialect!, baseUrl: baseUrl! }
    expect(hasNativeWebSearch(resolveModelInfo(p, id!))).toBe(true)
    expect(hasNativeWebSearch(resolveModelInfo({ ...p, baseUrl: "https://proxy.test" }, id!))).toBe(false)
    expect(
      hasNativeWebSearch(
        resolveModelInfo({ ...p, baseUrl: "https://proxy.test", compat: { webSearch: true } }, id!),
      ),
    ).toBe(true)
    expect(hasNativeWebSearch(resolveModelInfo({ ...p, compat: { webSearch: false } }, id!))).toBe(false)
    expect(
      hasNativeWebSearch(
        resolveModelInfo(
          { ...p, compat: { webSearch: false }, models: [{ id, caps: { webSearch: true } }] },
          id!,
        ),
      ),
    ).toBe(true)
    expect(
      hasNativeWebSearch(resolveModelInfo({ ...p, models: [{ id, caps: { webSearch: false } }] }, id!)),
    ).toBe(false)
    const ai = createAi({ providers: [p], webSearch: false, env: {} })
    expect(hasNativeWebSearch(ai.model(`p/${id}`))).toBe(false)
    expect(defaultWebSearch(dialect!, `${baseUrl!.split("/v")[0]}.evil.test`)).toBe(false)
  }
  expect(defaultWebSearch("anthropic-messages", "https://api.deepseek.com/anthropic")).toBe(false)
  expect(defaultWebSearch("google-gemini", "https://us-central1-aiplatform.googleapis.com")).toBe(false)
  expect(defaultWebSearch("google-gemini", "invalid")).toBe(false)
})

test("Gemini function-tool eligibility matches real Gemini 3 ids, including models/ prefixes", () => {
  const p = {
    id: "p",
    dialect: "google-gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    compat: { webSearch: true },
  }
  for (const id of ["gemini-3-flash-preview", "models/gemini-3.1-pro-preview", "gemini-3.8-flash"])
    expect(hasNativeWebSearch(resolveModelInfo(p, id))).toBe(true)
  for (const id of ["gemini-2.5-pro", "gemini-30-pro", "unknown"]) {
    const model = resolveModelInfo(p, id)
    expect(hasNativeWebSearch(model)).toBe(false)
  }
  expect(hasNativeWebSearch(resolveModelInfo(p, "gemini-2.5-pro"), false)).toBe(true)
})

test("catalog search prices are resolved and costed per reported search, never assumed free", async () => {
  const p = { id: "p", dialect: "anthropic-messages", baseUrl: "https://api.anthropic.com" }
  const ai = createAi({
    env: {},
    providers: [p],
    catalog: { find: () => ({ cost: { input: 3, output: 15, webSearch: 0.01 } }) },
  })
  const model = ai.model("p/claude")
  const usage = { ...emptyUsage(), input: 1000, webSearchRequests: 2 }
  expect(usageCost(usage, model.cost!)).toBeCloseTo(0.023, 10)
  expect(usageCost(usage, { input: 3, output: 15 })).toBeUndefined()
  async function price(m: ModelInfo, counts = true) {
    const message = {
      role: "assistant" as const,
      model: { provider: "p", model: "claude" },
      content: [
        { type: "serverTool" as const, id: "s", name: "web_search", input: {}, status: "done" as const },
      ],
      usage: { ...emptyUsage(), input: 1000, ...(counts ? { webSearchRequests: 2 } : {}) },
    }
    async function* stream(): AsyncGenerator<StreamEvent> {
      yield { type: "done", message }
    }
    for await (const _ of withCost(stream(), m)) {
    }
    return message.usage as typeof usage & { cost?: number; webSearchCost?: number }
  }
  expect(await price(model)).toMatchObject({ cost: 0.023, webSearchCost: 0.02 })
  const unknown = await price({ ...model, cost: { input: 3, output: 15 } })
  expect(unknown.cost).toBeUndefined()
  expect(unknown.webSearchCost).toBeUndefined()
  expect((await price(model, false)).cost).toBeUndefined()
})

test("usage aggregation carries search counts and known prices without turning an unknown fee into zero", () => {
  const known = { ...emptyUsage(), webSearchRequests: 2, webSearchCost: 0.02, cost: 0.023 }
  expect(addUsage(known, known)).toMatchObject({ webSearchRequests: 4, webSearchCost: 0.04, cost: 0.046 })
  const total = addUsage(known, { ...emptyUsage(), webSearchRequests: 1 })
  expect(total.webSearchRequests).toBe(3)
  expect(total.webSearchCost).toBeUndefined()
  expect(total.cost).toBeUndefined()
  expect(addUsage(total, known).cost).toBeUndefined()
})
