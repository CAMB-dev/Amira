import { expect, test } from "bun:test"
import { createCatalog, findCatalogModel, type ModelCatalog } from "../src/catalog.ts"
import { createAi } from "../src/client.ts"
import { DEFAULT_CAPS } from "../src/providers.ts"

const proxy = { id: "local-test", dialect: "openai-chat", baseUrl: "http://localhost:8317/v1" }
const data = {
  openai: { models: { "gpt-test": { limit: { context: 400_000, output: 32_000 } } } },
  anthropic: { models: { "claude-test": { limit: { context: 200_000, output: 16_000 } } } },
  google: { models: { "gemini-test": { limit: { context: 1_000_000, output: 64_000 } } } },
}

test("a mixed-vendor proxy borrows each model's limits", () => {
  const ai = createAi({ providers: [proxy], catalog: createCatalog(data) })
  for (const [id, contextWindow, maxOutput] of [
    ["gpt-test", 400_000, 32_000],
    ["claude-test", 200_000, 16_000],
    ["models/gemini-test", 1_000_000, 64_000],
    ["anthropic/CLAUDE-TEST", 200_000, 16_000],
  ] as const) {
    expect(ai.model(`${proxy.id}/${id}`)).toMatchObject({
      contextWindow,
      maxOutput,
      contextWindowSource: "catalog",
    })
  }
})

test("ambiguous vendor limits take independent minima, never prices, fast or caps", () => {
  const catalog = createCatalog({
    one: {
      models: {
        m: {
          limit: { context: 900_000, output: 8000 },
          cost: { input: 1, output: 2 },
          tool_call: false,
          reasoning: true,
          fast: { kind: "service-tier", value: "priority" },
        },
      },
    },
    two: { models: { m: { limit: { context: 200_000, output: 32_000 }, modalities: { input: ["image"] } } } },
  })
  const ai = createAi({ providers: [proxy], catalog })
  const model = ai.model("local-test/m")
  expect(model.contextWindow).toBe(200_000)
  expect(model.maxOutput).toBe(8000)
  expect(model.contextWindowSource).toBe("catalog")
  expect(model.caps).toEqual(DEFAULT_CAPS)
  expect(model.cost).toBeUndefined()
  expect(model.fast).toBeUndefined()
  expect(ai.knownModels()).toEqual([])
})

test("own catalog fields win independently and keep their metadata", () => {
  const catalog = createCatalog({
    ...data,
    "local-test": {
      models: {
        "gpt-test": { limit: { context: 100_000 }, tool_call: false, cost: { input: 3, output: 4 } },
      },
    },
  })
  expect(createAi({ providers: [proxy], catalog }).model("local-test/gpt-test")).toMatchObject({
    contextWindow: 100_000,
    maxOutput: 32_000,
    caps: { tools: "none" },
    cost: { input: 3, output: 4 },
  })
  const outputOnly = createCatalog({
    ...data,
    "local-test": { models: { "gpt-test": { limit: { output: 1000 } } } },
  })
  expect(findCatalogModel(outputOnly, proxy, "gpt-test")).toEqual({ contextWindow: 400_000, maxOutput: 1000 })
})

test("disabled and local catalogs do not borrow limits", () => {
  const catalog = createCatalog(data)
  for (const provider of [
    { ...proxy, catalogId: false as const },
    { ...proxy, id: "ollama" },
    { ...proxy, id: "lmstudio" },
  ]) {
    expect(createAi({ providers: [provider], catalog }).model(`${provider.id}/gpt-test`)).toMatchObject({
      contextWindow: 128_000,
      maxOutput: 8192,
      contextWindowSource: "default",
    })
  }
})

test("direct ids beat vendor-stripped ids; ambiguous case-insensitive ids do not match", () => {
  const catalog = createCatalog({
    one: {
      models: {
        "vendor/m": { limit: { context: 500_000 } },
        m: { limit: { context: 100_000 } },
        Dupe: { limit: { context: 9000 } },
        DUPE: { limit: { context: 8000 } },
      },
    },
  })
  expect(findCatalogModel(catalog, proxy, "vendor/m")).toEqual({ contextWindow: 500_000 })
  expect(findCatalogModel(catalog, proxy, "models/vendor/m")).toEqual({ contextWindow: 500_000 })
  expect(findCatalogModel(catalog, proxy, "dupe")).toBeUndefined()
  expect(findCatalogModel(catalog, proxy, "Dupe")).toEqual({ contextWindow: 9000 })
})

test("borrowing is memoized per model id and discarded with a replaced catalog", () => {
  const source = createCatalog(data)
  let scans = 0
  const catalog: ModelCatalog = {
    find: source.find,
    providers: () => {
      scans++
      return source.providers!()
    },
  }
  const ai = createAi({ providers: [proxy], catalog })
  ai.model("local-test/gpt-test")
  ai.model("local-test/gpt-test")
  expect(scans).toBe(1)
  ai.model("local-test/missing")
  const misses = scans
  ai.model("local-test/missing")
  expect(scans).toBe(misses)
  ai.setCatalog?.(createCatalog({ changed: { models: { "gpt-test": { limit: { context: 999_000 } } } } }))
  expect(ai.model("local-test/gpt-test").contextWindow).toBe(999_000)
})

test("settings > endpoint > own catalog > borrowed catalog > defaults, per field", () => {
  const provider = {
    ...proxy,
    defaultModel: { contextWindow: 50_000, maxOutput: 1000 },
    models: [{ id: "gpt-test", maxOutput: 4000 }],
  }
  const ai = createAi({
    providers: [provider],
    catalog: createCatalog(data),
    modelLimits: () => ({ contextWindow: 300_000, maxOutput: 24_000 }),
  })
  expect(ai.model("local-test/gpt-test")).toMatchObject({
    contextWindow: 300_000,
    maxOutput: 4000,
    contextWindowSource: "provider",
  })
  ai.registerProvider({ ...provider, models: [{ id: "gpt-test", contextWindow: 250_000 }] })
  expect(ai.model("local-test/gpt-test")).toMatchObject({
    contextWindow: 250_000,
    maxOutput: 24_000,
    contextWindowSource: "settings",
  })
  ai.setModelLimits?.(() => ({ maxOutput: 12_000 }))
  expect(ai.model("local-test/gpt-test")).toMatchObject({ contextWindow: 250_000, maxOutput: 12_000 })
  ai.setModelLimits?.(undefined)
  ai.registerProvider({ ...provider, models: [] })
  expect(ai.model("local-test/gpt-test")).toMatchObject({
    contextWindow: 400_000,
    maxOutput: 32_000,
    contextWindowSource: "catalog",
  })
  expect(ai.model("local-test/unknown")).toMatchObject({
    contextWindow: 50_000,
    maxOutput: 1000,
    contextWindowSource: "settings",
  })
})
