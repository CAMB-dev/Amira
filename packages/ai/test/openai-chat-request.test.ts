import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { collect } from "../src/dialect.ts"
import type { ProviderConfig } from "../src/providers.ts"
import { fakeFetch, type Seen, sseResponse } from "./helpers.ts"

async function sentBody(ref: string, providers: ProviderConfig[] = []) {
  const seen: Seen = {}
  const ai = createAi({
    fetch: fakeFetch(() => sseResponse([]), seen),
    env: { OPENAI_API_KEY: "k", DEEPSEEK_API_KEY: "k" },
    providers: [
      { id: "deepseek", dialect: "openai-chat", baseUrl: "http://ds", apiKeyEnv: "DEEPSEEK_API_KEY" },
      ...providers,
    ],
  })
  await collect(
    ai.stream({ model: ai.model(ref), systemPrompt: "", messages: [], tools: [], maxTokens: 100 }),
  )
  return seen.body
}

test("a provider with compat.maxTokensField sends max_completion_tokens", async () => {
  const body = await sentBody("oa/gpt-5", [
    {
      id: "oa",
      dialect: "openai-chat",
      baseUrl: "http://oa",
      apiKeyEnv: "OPENAI_API_KEY",
      compat: { maxTokensField: "max_completion_tokens" },
    },
  ])
  expect(body.max_completion_tokens).toBe(100)
  expect(body.max_tokens).toBeUndefined()
})

test("other providers send max_tokens by default", async () => {
  const body = await sentBody("deepseek/chat")
  expect(body.max_tokens).toBe(100)
  expect(body.max_completion_tokens).toBeUndefined()
})

test("asks for stream usage unless the provider opts out", async () => {
  expect((await sentBody("deepseek/chat")).stream_options).toEqual({ include_usage: true })
  const body = await sentBody("old/m", [
    {
      id: "old",
      dialect: "openai-chat",
      baseUrl: "http://old",
      compat: { streamUsage: false, maxTokensField: "max_completion_tokens" },
    },
  ])
  expect(body.stream_options).toBeUndefined()
  expect(body.max_completion_tokens).toBe(100)
})
