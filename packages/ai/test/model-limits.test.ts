import { describe, expect, test } from "bun:test"
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

test("direct ids beat vendor-stripped ids; ambiguous case-insensitive ids take the smaller limit", () => {
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
  // No exact match: the fuzzy index holds both spellings, and borrows the safer window.
  expect(findCatalogModel(catalog, proxy, "dupe")).toEqual({ contextWindow: 8000 })
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

describe("fuzzy catalog matching for borrowed limits", () => {
  const catalog = createCatalog({
    anthropic: {
      models: {
        "claude-sonnet-4-5": { limit: { context: 200_000, output: 64_000 }, cost: { input: 3, output: 15 } },
        "claude-sonnet-4-5-20250929": { limit: { context: 1_000_000, output: 64_000 } },
        "claude-opus-4-1": { limit: { context: 200_000, output: 32_000 }, tool_call: false },
      },
    },
    openai: {
      models: {
        "gpt-5": { limit: { context: 400_000, output: 128_000 } },
        "gpt-5-mini": { limit: { context: 272_000, output: 64_000 } },
        "gpt-4.1": { limit: { context: 1_047_576, output: 32_768 } },
      },
    },
    meta: { models: { llama3: { limit: { context: 8192, output: 2048 } } } },
    alibaba: { models: { "qwen-max": { limit: { context: 32_768, output: 8192 } } } },
    microsoft: { models: { phi3: { limit: { context: 4096, output: 4096 } } } },
  })

  test.each([
    ["Claude-Sonnet-4.5", 200_000],
    ["anthropic/claude-sonnet-4.5", 200_000],
    ["openrouter/anthropic/claude-sonnet-4-5:thinking", 200_000],
    ["claude-sonnet-4-5@20250929", 200_000],
    ["claude-sonnet-4-5-2025-09-29", 200_000],
    ["claude-opus-4.1:beta", 200_000],
    ["GPT-4-1", 1_047_576],
    ["openai/gpt-5:free", 400_000],
    ["gpt-5:online", 400_000],
    ["gpt-5:exacto", 400_000],
    ["qwen-max:nitro", 32_768],
    ["phi3:floor", 4096],
  ])("%s borrows %d", (id, contextWindow) => {
    expect(findCatalogModel(catalog, proxy, id)?.contextWindow).toBe(contextWindow)
  })

  test("exact ids win over fuzzy ones", () => {
    // The dated id is in the catalog itself, so its own window is used, not the family's minimum.
    expect(findCatalogModel(catalog, proxy, "claude-sonnet-4-5-20250929")?.contextWindow).toBe(1_000_000)
    expect(findCatalogModel(catalog, proxy, "gpt-5-mini")?.contextWindow).toBe(272_000)
  })

  test("only the listed decorations are cut, never a different model's suffix", () => {
    for (const id of [
      "gpt-5-nano",
      "gpt-5-pro:free",
      "claude-sonnet-4",
      "llama3:70b",
      "gpt-5-0613",
      "latest",
      "claude-sonnet-4-5-latest",
      "qwen-max-latest",
      "phi3:mini",
      "phi3:instruct",
      "gpt-5:preview",
    ]) {
      expect(findCatalogModel(catalog, proxy, id)).toBeUndefined()
    }
    expect(findCatalogModel(catalog, proxy, "gpt-5")?.contextWindow).toBe(400_000)
  })

  test("fuzzy matches borrow only token limits", () => {
    const model = createAi({ providers: [proxy], catalog }).model("local-test/claude-opus-4.1")
    expect(model).toMatchObject({ contextWindow: 200_000, maxOutput: 32_000, contextWindowSource: "catalog" })
    expect(model.caps).toEqual(DEFAULT_CAPS)
    expect(
      createAi({ providers: [proxy], catalog }).model("local-test/claude-sonnet-4.5").cost,
    ).toBeUndefined()
  })

  test("the normalized index is built once per catalog", () => {
    let lists = 0
    const counted: ModelCatalog = {
      find: catalog.find,
      providers: catalog.providers!,
      list: (vendor) => {
        lists++
        return catalog.list!(vendor)
      },
    }
    findCatalogModel(counted, proxy, "claude-sonnet-4.5")
    const built = lists
    expect(built).toBeGreaterThan(0)
    findCatalogModel(counted, proxy, "gpt-4-1")
    findCatalogModel(counted, proxy, "nothing-like-it")
    expect(lists).toBe(built)
  })
})

test("learned limits only lower what models resolve to, and reach the host's learner", () => {
  const kept: unknown[] = []
  const ai = createAi({
    providers: [proxy, { ...proxy, id: "other" }],
    catalog: createCatalog(data),
    modelLimits: () => ({ maxOutput: 24_000 }),
    learnModelLimits: (provider, modelId, limits) => void kept.push([provider.id, modelId, limits]),
  })
  const model = ai.model("local-test/gpt-test")
  expect(model).toMatchObject({ contextWindow: 400_000, contextWindowSource: "catalog" })
  ai.learnModelLimits?.(model, { contextWindow: 500_000 })
  ai.learnModelLimits?.(model, { contextWindow: 0 })
  expect(kept).toEqual([])
  ai.learnModelLimits?.(model, { contextWindow: 65_536 })
  expect(ai.model("local-test/gpt-test")).toMatchObject({
    contextWindow: 65_536,
    maxOutput: 24_000,
    contextWindowSource: "provider",
  })
  ai.learnModelLimits?.(ai.model("local-test/gpt-test"), { contextWindow: 100_000 })
  expect(ai.model("local-test/gpt-test").contextWindow).toBe(65_536)
  expect(kept).toEqual([["local-test", "gpt-test", { contextWindow: 65_536 }]])
  // Per provider and model: the same id elsewhere keeps its own window.
  expect(ai.model("other/gpt-test").contextWindow).toBe(400_000)
  expect(ai.model("local-test/claude-test").contextWindow).toBe(200_000)
  // Settings still win; setModelLimits swaps the learner too.
  ai.setModelLimits?.(undefined, (_p, id, limits) => void kept.push(["swapped", id, limits]))
  ai.learnModelLimits?.(ai.model("local-test/claude-test"), { contextWindow: 32_000 })
  expect(kept.at(-1)).toEqual(["swapped", "claude-test", { contextWindow: 32_000 }])
  ai.registerProvider({ ...proxy, models: [{ id: "gpt-test", contextWindow: 250_000 }] })
  expect(ai.model("local-test/gpt-test")).toMatchObject({
    contextWindow: 250_000,
    contextWindowSource: "settings",
  })
})
