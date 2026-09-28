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
    maxOutput: 8_192,
    caps: { ...DEFAULT_CAPS, thinking: true },
    cost: { input: 1, output: 2 },
  })
})

test("passes cost through, preferring the model's own", () => {
  expect(resolveModelInfo(provider, "cached").cost).toEqual({ input: 3, output: 4, cacheRead: 0.3 })
  expect(resolveModelInfo({ ...provider, defaultModel: {} }, "vision").cost).toBeUndefined()
})
