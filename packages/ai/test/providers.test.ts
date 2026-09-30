import { expect, test } from "bun:test"
import { DEFAULT_CAPS, type ProviderConfig, resolveModelInfo } from "../src/providers.ts"

const provider: ProviderConfig = {
  id: "p",
  dialect: "openai-chat",
  baseUrl: "http://p",
  defaultModel: { contextWindow: 64_000, caps: { thinking: true }, cost: { input: 1, output: 2 } },
  models: [
    { id: "vision", caps: { images: true }, maxOutput: 4096 },
    { id: "cached", cost: { input: 3, output: 4, cacheRead: 0.3 } },
  ],
}

test("merges per-model caps over provider defaults and DEFAULT_CAPS", () => {
  const info = resolveModelInfo(provider, "vision")
  expect(info.caps).toEqual({ ...DEFAULT_CAPS, thinking: true, images: true })
  expect(info.contextWindow).toBe(64_000)
  expect(info.maxOutput).toBe(4096)
})

test("unlisted models get the provider defaults", () => {
  const info = resolveModelInfo(provider, "other")
  expect(info).toEqual({
    id: "other",
    provider: "p",
    dialect: "openai-chat",
    contextWindow: 64_000,
    contextWindowSource: "settings",
    maxOutput: 8_192,
    caps: { ...DEFAULT_CAPS, thinking: true },
    cost: { input: 1, output: 2 },
  })
})

test("passes cost through, preferring the model's own", () => {
  expect(resolveModelInfo(provider, "cached").cost).toEqual({ input: 3, output: 4, cacheRead: 0.3 })
  expect(resolveModelInfo({ ...provider, defaultModel: {} }, "vision").cost).toBeUndefined()
})

test("says where the context window came from", () => {
  const bare: ProviderConfig = { id: "b", dialect: "openai-chat", baseUrl: "http://b" }
  const listed: ProviderConfig = { ...bare, models: [{ id: "m", contextWindow: 256_000 }] }
  const guessed = resolveModelInfo(bare, "m")
  expect([guessed.contextWindow, guessed.contextWindowSource]).toEqual([128_000, "default"])
  const fromCatalog = resolveModelInfo(bare, "m", { contextWindow: 1_050_000 })
  expect([fromCatalog.contextWindow, fromCatalog.contextWindowSource]).toEqual([1_050_000, "catalog"])
  // The user's own entry for the model wins over the catalog; their defaultModel does not.
  const mine = resolveModelInfo(listed, "m", { contextWindow: 1_050_000 })
  expect([mine.contextWindow, mine.contextWindowSource]).toEqual([256_000, "settings"])
  const byDefault = resolveModelInfo(provider, "other", { contextWindow: 1_050_000 })
  expect(byDefault.contextWindowSource).toBe("catalog")
  expect(resolveModelInfo(provider, "other").contextWindowSource).toBe("settings")
})
