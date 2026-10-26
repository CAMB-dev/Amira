import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createCatalog, type ProviderConfig } from "@amira/ai"
import type { ProviderDraft } from "@amira/api"
import { createProviderAdmin } from "../src/provider-admin.ts"
import { createSession } from "../src/session-factory.ts"

let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "amira-endpoint-limits-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const provider: ProviderConfig = {
  id: "local",
  dialect: "openai-chat",
  baseUrl: "https://local.example/v1",
  models: [{ id: "shared" }],
}
const draft: ProviderDraft = {
  ...provider,
  models: ["shared"],
  keySource: "none",
}
const catalog = createCatalog({
  local: { models: { shared: { limit: { context: 128000, output: 8192 } } } },
})
const fetchModels = (async () =>
  Response.json({
    data: [{ id: "shared", context_window: 32768, max_output_tokens: 4096 }],
  })) as unknown as typeof fetch

test("listed endpoint limits survive admin recreation and beat catalog limits at runtime", async () => {
  const ai = createAi({ providers: [provider], catalog, env: {} })
  const admin = createProviderAdmin({ ai, home, fetch: fetchModels })
  await admin.listModels(draft)
  expect(ai.model("local/shared")).toMatchObject({ contextWindow: 32768, maxOutput: 4096 })

  const restarted = createAi({ providers: [provider], catalog, env: {} })
  const reopened = createProviderAdmin({ ai: restarted, home })
  expect(reopened.describeModels(draft, ["shared"])[0]).toMatchObject({
    contextWindow: 32768,
    maxOutput: 4096,
  })
  expect(restarted.model("local/shared")).toMatchObject({ contextWindow: 32768, maxOutput: 4096 })
})

test("changing the base URL or provider id does not reuse another endpoint's limits", async () => {
  const ai = createAi({ providers: [provider], catalog, env: {} })
  const admin = createProviderAdmin({ ai, home, fetch: fetchModels })
  await admin.listModels(draft)
  const changed = { ...provider, baseUrl: "https://different.example/v1" }
  ai.registerProvider(changed)
  expect(ai.model("local/shared").contextWindow).toBe(128000)
  expect(admin.describeModels({ ...draft, baseUrl: changed.baseUrl }, ["shared"])[0]?.contextWindow).toBe(
    128000,
  )
  ai.registerProvider({ ...provider, id: "another", catalogId: "local" })
  expect(ai.model("another/shared").contextWindow).toBe(128000)
  ai.registerProvider(provider)
  expect(ai.model("local/shared").contextWindow).toBe(32768)
})

test("per-model settings beat endpoint limits, which beat catalog and provider defaults", async () => {
  const configured: ProviderConfig = {
    ...provider,
    models: [{ id: "shared", contextWindow: 24000 }],
    defaultModel: { contextWindow: 16000, maxOutput: 1000 },
  }
  const ai = createAi({ providers: [configured], catalog, env: {} })
  const admin = createProviderAdmin({ ai, home, fetch: fetchModels })
  const d = admin.draft("local")!
  expect((await admin.listModels(d))[0]).toMatchObject({ contextWindow: 24000, maxOutput: 4096 })
  expect(admin.describeModels(d, ["shared"])[0]).toMatchObject({ contextWindow: 24000, maxOutput: 4096 })
  expect(ai.model("local/shared")).toMatchObject({ contextWindow: 24000, maxOutput: 4096 })

  const edited: ProviderDraft = {
    ...d,
    modelOverrides: { shared: { contextWindow: 20000, maxOutput: 2000 } },
  }
  const preview = admin.describeModels(edited, ["shared"])[0]!
  expect(preview).toMatchObject({ contextWindow: 20000, maxOutput: 2000 })
  await admin.save(edited)
  expect(ai.model("local/shared")).toMatchObject({
    contextWindow: preview.contextWindow,
    maxOutput: preview.maxOutput,
  })
})

test("describe and runtime fill each missing limit without borrowing another vendor's prices", async () => {
  const partialCatalog = createCatalog({
    local: { models: { shared: { limit: { output: 7000 }, cost: { input: 1, output: 2 } } } },
    other: {
      models: { shared: { limit: { context: 128000, output: 9000 }, cost: { input: 10, output: 20 } } },
    },
  })
  const ai = createAi({ providers: [provider], catalog: partialCatalog, env: {} })
  const admin = createProviderAdmin({
    ai,
    home,
    fetch: (async () =>
      Response.json({ data: [{ id: "shared", context_window: 32000 }] })) as unknown as typeof fetch,
  })
  expect(admin.describeModels(draft, ["shared"])[0]).toMatchObject({ contextWindow: 128000, maxOutput: 7000 })
  const described = (await admin.listModels(draft))[0]!
  expect(described).toMatchObject({ contextWindow: 32000, maxOutput: 7000, cost: { input: 1, output: 2 } })
  expect(ai.model("local/shared")).toMatchObject({
    contextWindow: described.contextWindow,
    maxOutput: described.maxOutput,
    cost: described.cost,
  })
})

test("draft defaults are resolved when neither endpoint nor catalog describes a model", async () => {
  const ai = createAi({ providers: [provider], catalog, env: {} })
  const admin = createProviderAdmin({ ai, home })
  const edited: ProviderDraft = {
    ...draft,
    models: ["unknown"],
    defaults: { contextWindow: 48000, maxOutput: 3000 },
  }
  const described = admin.describeModels(edited, ["unknown"])[0]!
  expect(described).toMatchObject({ contextWindow: 48000, maxOutput: 3000, inCatalog: false })
  await admin.save(edited)
  expect(ai.model("local/unknown")).toMatchObject({
    contextWindow: described.contextWindow,
    maxOutput: described.maxOutput,
  })
})

test("disabled catalogs still use persisted endpoint limits and never borrow global limits", async () => {
  const disabled = { ...provider, catalogId: false as const }
  const ai = createAi({ providers: [disabled], catalog, env: {} })
  const admin = createProviderAdmin({ ai, home, fetch: fetchModels })
  const d = { ...draft, catalogId: false as const, defaults: { contextWindow: 12000, maxOutput: 1000 } }
  expect(admin.describeModels(d, ["shared"])[0]).toMatchObject({
    contextWindow: 12000,
    maxOutput: 1000,
    inCatalog: false,
  })
  await admin.listModels(d)
  expect(admin.describeModels(d, ["shared"])[0]).toMatchObject({
    contextWindow: 32768,
    maxOutput: 4096,
    inCatalog: false,
  })
  const restarted = createAi({ providers: [disabled], catalog, env: {} })
  createProviderAdmin({ ai: restarted, home })
  expect(restarted.model("local/shared")).toMatchObject({ contextWindow: 32768, maxOutput: 4096 })
})

test.each(["ollama", "lmstudio"])(
  "%s's default disabled catalog still accepts endpoint limits",
  async (id) => {
    const configured = { ...provider, id }
    const ai = createAi({ providers: [configured], catalog, env: {} })
    const admin = createProviderAdmin({ ai, home, fetch: fetchModels })
    const d = { ...draft, id, defaults: { contextWindow: 12000, maxOutput: 1000 } }
    expect(admin.describeModels(d, ["shared"])[0]).toMatchObject({ contextWindow: 12000, inCatalog: false })
    await admin.listModels(d)
    await admin.save(d)
    expect(ai.model(`${id}/shared`)).toMatchObject({ contextWindow: 32768, maxOutput: 4096 })
    expect(admin.describeModels(d, ["shared"])[0]).toMatchObject({
      contextWindow: 32768,
      maxOutput: 4096,
      inCatalog: false,
    })
  },
)

test("a session loads endpoint limits before selecting its model, even without a catalog", async () => {
  const ai = createAi({ providers: [provider], env: {} })
  const admin = createProviderAdmin({ ai, home, fetch: fetchModels })
  await admin.listModels(draft)
  const session = await createSession({
    cwd: home,
    extensions: [],
    noBuiltins: true,
    catalog: false,
    providerModelsFile: path.join(home, "cache", "provider-models.json"),
    providers: [provider],
    model: "local/shared",
  })
  try {
    expect(session.agent.model).toMatchObject({ contextWindow: 32768, maxOutput: 4096 })
    expect(session.ai.model("local/shared")).toMatchObject({ contextWindow: 32768, maxOutput: 4096 })
  } finally {
    await session.agent.dispose()
    session.host.unloadAll()
  }
})

test("a failed model list preserves the last successful endpoint limits", async () => {
  const ai = createAi({ providers: [provider], catalog, env: {} })
  await createProviderAdmin({ ai, home, fetch: fetchModels }).listModels(draft)
  const failed = createProviderAdmin({
    ai,
    home,
    fetch: (async () => Response.json({ error: "offline" }, { status: 500 })) as unknown as typeof fetch,
  })
  await expect(failed.listModels(draft)).rejects.toThrow()
  expect(ai.model("local/shared")).toMatchObject({ contextWindow: 32768, maxOutput: 4096 })
})

test("description uses the inferred vendor that saving the unchanged draft persists", async () => {
  const p = { ...provider, id: "proxy", models: [{ id: "m" }, { id: "n" }] }
  const catalog = createCatalog({
    one: {
      models: { m: { limit: { context: 200_000, output: 4000 }, cost: { input: 1, output: 2 } } },
    },
    two: {
      models: {
        m: { limit: { context: 400_000, output: 8000 }, cost: { input: 3, output: 4 } },
        n: { limit: { context: 100_000 } },
      },
    },
  })
  const ai = createAi({ providers: [p], catalog, env: {} })
  const admin = createProviderAdmin({ ai, home })
  const d = admin.draft("proxy")!
  // The selected n disambiguates the mapping even when only m is being described.
  const described = admin.describeModels(d, ["m"])[0]!
  expect(admin.preview!(d).catalogId).toBe("two")
  await admin.save(d)
  expect(ai.providers().find((p) => p.id === "proxy")?.catalogId).toBe("two")
  expect(ai.model("proxy/m")).toMatchObject({
    contextWindow: described.contextWindow,
    maxOutput: described.maxOutput,
    cost: described.cost,
  })
  expect(described).toEqual({
    id: "m",
    contextWindow: 400_000,
    contextWindowSource: "catalog",
    maxOutput: 8000,
    cost: { input: 3, output: 4 },
    inCatalog: true,
  })
})

test.each([
  { baseUrl: "https://proxy.example", catalogId: undefined, contextWindow: 200_000, cost: undefined },
  {
    baseUrl: "https://api.two.example",
    catalogId: "two",
    contextWindow: 400_000,
    cost: { input: 3, output: 4 },
  },
])("description preserves tied-model inference for $baseUrl", async (expected) => {
  const p = { ...provider, id: "proxy", baseUrl: expected.baseUrl, models: [{ id: "m" }] }
  const ai = createAi({
    providers: [p],
    catalog: createCatalog({
      one: { models: { m: { limit: { context: 200_000 }, cost: { input: 1, output: 2 } } } },
      two: { models: { m: { limit: { context: 400_000 }, cost: { input: 3, output: 4 } } } },
    }),
    env: {},
  })
  const admin = createProviderAdmin({ ai, home })
  const d = admin.draft("proxy")!
  const described = admin.describeModels(d, ["m"])[0]!
  expect(admin.preview!(d).catalogId).toBe(expected.catalogId)
  expect(described.contextWindow).toBe(expected.contextWindow)
  expect(described.cost).toEqual(expected.cost)
  await admin.save(d)
  const model = ai.model("proxy/m")
  expect(model).toMatchObject({
    contextWindow: described.contextWindow,
    maxOutput: described.maxOutput,
  })
  expect(model.cost).toEqual(described.cost)
})

test.each(["ollama", "lmstudio"])("description respects %s's implicit catalog opt-out", (id) => {
  const p = { ...provider, id, defaultModel: { contextWindow: 64_000 } }
  const ai = createAi({
    providers: [p],
    catalog: createCatalog({ vendor: { models: { shared: { limit: { context: 400_000 } } } } }),
    env: {},
  })
  const admin = createProviderAdmin({ ai, home })
  expect(admin.describeModels(admin.draft(id)!, ["shared"])[0]?.contextWindow).toBe(
    ai.model(`${id}/shared`).contextWindow,
  )
})
