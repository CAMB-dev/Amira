import { expect, test } from "bun:test"
import { catalogProviderId, createCatalog, trimModelsDev } from "../src/catalog.ts"
import { createAi } from "../src/client.ts"
import type { ProviderConfig } from "../src/providers.ts"
import fixture from "./fixtures/models-dev.json" with { type: "json" }

const deepseek: ProviderConfig = {
  id: "deepseek",
  dialect: "openai-chat",
  baseUrl: "http://ds",
  apiKeyEnv: "DEEPSEEK_API_KEY",
}
const ollama: ProviderConfig = { id: "ollama", dialect: "openai-chat", baseUrl: "http://localhost:11434/v1" }

test("maps a models.dev entry to limits, caps and prices", () => {
  const c = createCatalog(fixture)
  expect(c.find("deepseek", "deepseek-flash")).toEqual({
    contextWindow: 1_000_000,
    maxOutput: 393_216,
    caps: { tools: "native", images: true, thinking: true },
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003 },
  })
  expect(c.find("anthropic", "claude-sonnet-4-5")?.caps?.promptCache).toBe(true)
  expect(c.find("anthropic", "claude-sonnet-4-5")?.cost).toEqual({
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  })
  expect(c.find("openai", "gpt-5")?.caps?.promptCache).toBeUndefined()
  const llama = c.find("deepinfra", "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8")
  expect(llama?.caps?.tools).toBe("none")
})

test("finds Gemini ids with the models/ prefix and ids that differ only in case", () => {
  const c = createCatalog(fixture)
  expect(c.find("google", "models/gemini-2.5-flash")?.contextWindow).toBe(1_048_576)
  expect(c.find("deepseek", "DeepSeek-Flash")?.contextWindow).toBe(1_000_000)
  expect(c.find("deepseek", "nope")).toBeUndefined()
  expect(c.find("nope", "deepseek-flash")).toBeUndefined()
})

test("tolerates junk data", () => {
  for (const junk of [null, 1, "x", [], { deepseek: 1 }, { deepseek: { models: [] } }]) {
    expect(createCatalog(junk).find("deepseek", "deepseek-flash")).toBeUndefined()
  }
  const c = createCatalog({
    p: { models: { m: { limit: { context: -1, output: "x" }, cost: { input: 1 } } } },
  })
  expect(c.find("p", "m")).toBeUndefined()
})

test("the trimmed form reads the same and is much smaller", () => {
  const trimmed = trimModelsDev(fixture)!
  const a = createCatalog(fixture)
  const b = createCatalog(JSON.parse(JSON.stringify(trimmed)))
  for (const [p, m] of [
    ["deepseek", "deepseek-flash"],
    ["anthropic", "claude-sonnet-4-5"],
    ["google", "gemini-2.5-flash"],
  ] as const) {
    expect(b.find(p, m)).toEqual(a.find(p, m)!)
  }
  expect(JSON.stringify(trimmed).length).toBeLessThan(JSON.stringify(fixture).length / 3)
  expect(trimModelsDev("junk")).toBeUndefined()
})

test("provider ids map through config, then the table, then themselves", () => {
  expect(catalogProviderId({ id: "deepseek" })).toBe("deepseek")
  expect(catalogProviderId({ id: "gemini" })).toBe("google")
  expect(catalogProviderId({ id: "ollama" })).toBeUndefined()
  expect(catalogProviderId({ id: "deepseek-anthropic" })).toBe("deepseek")
  expect(catalogProviderId({ id: "ds-anthropic", catalogId: "deepseek" })).toBe("deepseek")
  expect(catalogProviderId({ id: "openai", catalogId: false })).toBeUndefined()
})

test("provider config wins over the catalog, which wins over defaults", () => {
  const ai = createAi({
    catalog: createCatalog(fixture),
    providers: [
      {
        id: "deepseek",
        dialect: "openai-chat",
        baseUrl: "https://api.deepseek.com",
        defaultModel: { contextWindow: 64_000, caps: { parallelToolCalls: false } },
        models: [{ id: "deepseek-flash", maxOutput: 8000, caps: { images: false } }],
      },
      {
        id: "ds-anthropic",
        dialect: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/anthropic",
        catalogId: "deepseek",
      },
    ],
  })
  const m = ai.model("deepseek/deepseek-flash")
  expect(m.contextWindow).toBe(1_000_000)
  expect(m.maxOutput).toBe(8000)
  expect(m.caps).toEqual({
    tools: "native",
    images: false,
    thinking: true,
    promptCache: false,
    parallelToolCalls: false,
  })
  expect(m.cost).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003 })
  // Models the catalog does not know keep the provider defaults.
  expect(ai.model("deepseek/unknown").contextWindow).toBe(64_000)
  expect(ai.model("ds-anthropic/deepseek-flash").contextWindow).toBe(1_000_000)
})

test("without a catalog, or after replacing it, models resolve as before", () => {
  const ai = createAi({ providers: [deepseek, ollama] })
  expect(ai.model("deepseek/deepseek-flash").contextWindow).toBe(128_000)
  ai.setCatalog?.(createCatalog(fixture))
  expect(ai.model("deepseek/deepseek-flash").contextWindow).toBe(1_000_000)
  expect(ai.model("ollama/deepseek-flash").contextWindow).toBe(128_000)
})

test("lists a provider's models, and the ai offers them only for providers with a key", () => {
  const catalog = createCatalog(fixture)
  expect(catalog.list?.("deepseek")).toContain("deepseek-flash")
  expect(catalog.list?.("nope")).toEqual([])
  const ai = createAi({
    catalog,
    env: { DEEPSEEK_API_KEY: "k" },
    providers: [
      deepseek,
      { id: "keyed", dialect: "anthropic-messages", baseUrl: "http://k", apiKeyEnv: "KEYED_API_KEY" },
      { id: "local", dialect: "openai-chat", baseUrl: "http://x", models: [{ id: "tiny" }] },
    ],
  })
  const known = ai.knownModels()
  expect(known).toContain("deepseek/deepseek-flash")
  expect(known).toContain("local/tiny")
  // No KEYED_API_KEY here, so its models are not offered.
  expect(known.some((m) => m.startsWith("keyed/"))).toBe(false)
  expect(ai.hasKey("deepseek")).toBe(true)
  expect(ai.hasKey("keyed")).toBe(false)
  expect(ai.hasKey("local")).toBe(true)
  expect(ai.hasKey("missing")).toBe(false)
})
