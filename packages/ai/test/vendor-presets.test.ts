// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Catalog URL placeholders are literal fixtures.
import { expect, test } from "bun:test"
import { type CatalogVendor, createCatalog, vendorPreset } from "../src/index.ts"
import { listModels, testConnection } from "../src/probe.ts"

function vendor(npm: string, api?: string): CatalogVendor {
  return { id: "synthetic", name: "Synthetic vendor", env: [], npm, ...(api !== undefined ? { api } : {}) }
}

test.each([
  ["@ai-sdk/openai", "openai-responses", "https://api.openai.com/v1"],
  ["@ai-sdk/anthropic", "anthropic-messages", "https://api.anthropic.com"],
  ["@ai-sdk/google", "google-gemini", "https://generativelanguage.googleapis.com/v1beta"],
])("%s has a protocol default", (npm, dialect, baseUrl) => {
  expect(vendorPreset(vendor(npm!))).toEqual({ dialect, baseUrl })
})

test("compatible SDKs require an API URL; other SDKs are not guessed from the id", () => {
  expect(vendorPreset(vendor("@ai-sdk/openai-compatible"))).toBeUndefined()
  expect(vendorPreset(vendor("@ai-sdk/openai-compatible", " "))).toBeUndefined()
  expect(vendorPreset(vendor("@openrouter/ai-sdk-provider"))).toBeUndefined()
  for (const npm of [
    "@ai-sdk/azure",
    "@ai-sdk/amazon-bedrock",
    "@ai-sdk/mistral",
    "constructor",
    "unknown",
  ]) {
    expect(vendorPreset({ ...vendor(npm, "https://api.example/v1"), id: "openai" })).toBeUndefined()
  }
})

test.each([
  ["@ai-sdk/openai", "https://api.example/", "https://api.example/v1"],
  ["@ai-sdk/openai", "https://api.example/v1///", "https://api.example/v1"],
  ["@ai-sdk/openai", "https://api.example/custom/", "https://api.example/custom"],
  ["@ai-sdk/openai-compatible", "https://api.example", "https://api.example"],
  ["@ai-sdk/openai-compatible", "https://api.deepseek.com", "https://api.deepseek.com"],
  ["@ai-sdk/openai-compatible", "https://api.moonshot.ai/v1", "https://api.moonshot.ai/v1"],
  ["@openrouter/ai-sdk-provider", "https://openrouter.ai/api/v1/", "https://openrouter.ai/api/v1"],
  ["@ai-sdk/openai-compatible", "https://api.example/v1/", "https://api.example/v1"],
  ["@ai-sdk/openai-compatible", " https://api.example/api/v2/ ", "https://api.example/api/v2"],
  ["@ai-sdk/openai-compatible", "http://localhost:1234/", "http://localhost:1234"],
  ["@ai-sdk/anthropic", "https://api.example/", "https://api.example"],
  ["@ai-sdk/anthropic", "https://api.example/v1///", "https://api.example/v1"],
  ["@ai-sdk/anthropic", "https://api.example/anthropic/", "https://api.example/anthropic"],
  ["@ai-sdk/anthropic", "https://api.example/anthropic/v1/", "https://api.example/anthropic/v1"],
  ["@ai-sdk/google", "https://api.example/", "https://api.example/v1beta"],
  ["@ai-sdk/google", "https://api.example/v1beta///", "https://api.example/v1beta"],
  ["@ai-sdk/google", "https://api.example/v1/", "https://api.example/v1"],
  ["@ai-sdk/google", "https://api.example/custom/gemini/", "https://api.example/custom/gemini"],
])("%s normalizes %s to %s", (npm, api, expected) => {
  expect(vendorPreset(vendor(npm!, api))?.baseUrl).toBe(expected)
})

test.each([
  ["@ai-sdk/openai-compatible", "${NEON_AI_GATEWAY_BASE_URL}/v1", "openai-chat"],
  [
    "@ai-sdk/openai-compatible",
    "https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}/compat",
    "openai-chat",
  ],
  ["@ai-sdk/openai", "${OPENAI_BASE_URL}", "openai-responses"],
  ["@ai-sdk/anthropic", "${ANTHROPIC_BASE_URL}", "anthropic-messages"],
  ["@ai-sdk/google", "${GOOGLE_BASE_URL}", "google-gemini"],
])("%s preserves placeholders in %s without expanding them", (npm, api, dialect) => {
  expect(vendorPreset(vendor(npm!, api))).toEqual({ dialect, baseUrl: api })
  expect(vendorPreset(vendor(npm!, ` ${api}/// `))).toEqual({ dialect, baseUrl: api })
})

test.each([
  "not a URL",
  "/relative/v1",
  "ftp://api.example/v1",
  "https://api.example?key=x",
  "https://api.example#v1",
])("does not suggest an unusable endpoint: %s", (api) => {
  expect(vendorPreset(vendor("@ai-sdk/openai-compatible", api))).toBeUndefined()
})

test.each([
  {
    npm: "@ai-sdk/openai",
    api: "https://api.example/v1/",
    list: "https://api.example/v1/models",
    request: "https://api.example/v1/responses",
  },
  {
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.example/custom/v1/",
    list: "https://api.example/custom/v1/models",
    request: "https://api.example/custom/v1/chat/completions",
  },
  {
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.deepseek.com",
    list: "https://api.deepseek.com/models",
    request: "https://api.deepseek.com/chat/completions",
  },
  {
    npm: "@openrouter/ai-sdk-provider",
    api: "https://openrouter.ai/api/v1",
    list: "https://openrouter.ai/api/v1/models",
    request: "https://openrouter.ai/api/v1/chat/completions",
  },
  {
    npm: "@ai-sdk/anthropic",
    api: "https://api.example/anthropic/v1/",
    list: "https://api.example/anthropic/v1/models?limit=1000",
    request: "https://api.example/anthropic/v1/messages",
  },
  {
    npm: "@ai-sdk/anthropic",
    api: "https://api.example/anthropic/",
    list: "https://api.example/anthropic/v1/models?limit=1000",
    request: "https://api.example/anthropic/v1/messages",
  },
  {
    npm: "@ai-sdk/google",
    api: "https://api.example/",
    list: "https://api.example/v1beta/models?pageSize=1000",
    request: "https://api.example/v1beta/models/tiny:streamGenerateContent?alt=sse",
  },
])("a synthetic $npm vendor uses the real probe and dialect routes", async ({ npm, api, list, request }) => {
  const catalog = createCatalog({ synthetic: { ...vendor(npm, api), models: { tiny: {} } } })
  const preset = vendorPreset(catalog.vendor!("synthetic")!)!
  const calls: string[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push(url)
    return init?.method === "POST"
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify({ data: [], models: [] }), {
          headers: { "content-type": "application/json" },
        })
  }) as unknown as typeof globalThis.fetch
  expect(await listModels(preset, { fetch })).toEqual([])
  expect(await testConnection(preset, "tiny", { fetch })).toMatchObject({ ok: false, failure: "not_found" })
  expect(calls).toEqual([list, request])
})
