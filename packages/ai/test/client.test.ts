import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { DEFAULT_CAPS, isNoModel, NO_MODEL } from "../src/providers.ts"
import type { ModelRequest } from "../src/types.ts"
import { type ErrorEvent, events, fakeFetch, type Seen, sseResponse } from "./helpers.ts"

const req = (provider: string, dialect = "openai-chat"): ModelRequest => ({
  model: { id: "m", provider, dialect, contextWindow: 1000, maxOutput: 100, caps: DEFAULT_CAPS },
  systemPrompt: "",
  messages: [],
  tools: [],
})

test("yields an error event for an unknown provider instead of throwing", async () => {
  const ai = createAi({ providers: [{ id: "a", dialect: "openai-chat", baseUrl: "http://a" }] })
  const stream = ai.stream(req("nope"))
  const evs = await events(stream)
  expect(evs).toHaveLength(1)
  const e = evs[0] as ErrorEvent
  expect(e.type).toBe("error")
  expect(e.error.message).toBe('unknown provider "nope" (configured: a)')
  expect(e.error.code).toBe("unknown_provider")
  expect(e.message.stopReason).toBe("error")
})

test("yields an error event for an unknown dialect instead of throwing", async () => {
  const ai = createAi({ providers: [{ id: "weird", dialect: "nope", baseUrl: "http://x" }] })
  const evs = await events(ai.stream({ ...req("weird"), model: ai.model("weird/m") }))
  expect(evs).toHaveLength(1)
  expect((evs[0] as ErrorEvent).error.message).toMatch(/unknown dialect "nope"/)
})

test("refuses to send an unauthenticated request when the key variable is missing", async () => {
  let called = false
  const ai = createAi({
    env: {},
    providers: [
      { id: "openrouter", dialect: "openai-chat", baseUrl: "http://or", apiKeyEnv: "OPENROUTER_API_KEY" },
    ],
    fetch: (async () => {
      called = true
      return sseResponse([])
    }) as unknown as typeof fetch,
  })
  const evs = await events(ai.stream({ ...req("openrouter"), model: ai.model("openrouter/x") }))
  expect(called).toBe(false)
  expect(evs).toHaveLength(1)
  const e = evs[0] as ErrorEvent
  expect(e.error.message).toBe("OPENROUTER_API_KEY is not set; export it to use provider openrouter")
  expect(e.retryable).toBe(false)
})

test("keyless providers and explicit keys need no environment variable", async () => {
  const seen: Seen = {}
  const ai = createAi({
    env: {},
    fetch: fakeFetch(() => sseResponse([]), seen),
    providers: [
      { id: "ollama", dialect: "openai-chat", baseUrl: "http://localhost:11434/v1" },
      { id: "keyed", dialect: "openai-chat", baseUrl: "http://k", apiKeyEnv: "KEYED", apiKey: "inline" },
    ],
  })
  expect((await events(ai.stream({ ...req("ollama"), model: ai.model("ollama/q") }))).at(-1)?.type).toBe(
    "done",
  )
  expect(seen.headers.authorization).toBeUndefined()
  expect((await events(ai.stream({ ...req("keyed"), model: ai.model("keyed/m") }))).at(-1)?.type).toBe("done")
  expect(seen.headers.authorization).toBe("Bearer inline")
})

test("the key comes from the variable, then its fallbacks, then the stored keys", async () => {
  const seen: Seen = {}
  const providers = [
    { id: "p", dialect: "openai-chat", baseUrl: "http://p", apiKeyEnv: "MAIN", apiKeyEnvFallbacks: ["ALT"] },
  ]
  const auth = async (env: Record<string, string>, apiKeys?: Record<string, string>) => {
    seen.headers = undefined
    const ai = createAi({ env, providers, fetch: fakeFetch(() => sseResponse([]), seen), apiKeys })
    const evs = await events(ai.stream({ ...req("p"), model: ai.model("p/m") }))
    const last = evs.at(-1)
    return last?.type === "error" ? (last as ErrorEvent).error.message : seen.headers?.authorization
  }
  expect(await auth({ MAIN: "a", ALT: "b" }, { p: "c" })).toBe("Bearer a")
  expect(await auth({ ALT: "b" }, { p: "c" })).toBe("Bearer b")
  expect(await auth({}, { p: "c" })).toBe("Bearer c")
  expect(await auth({})).toBe("MAIN or ALT is not set; export it to use provider p")
})

test("no provider is built in: only the configured ones exist", () => {
  const empty = createAi()
  expect(empty.providers()).toEqual([])
  for (const id of ["anthropic", "openai", "openai-chat", "google"]) {
    expect(() => empty.model(`${id}/x`)).toThrow(`unknown provider "${id}" (no providers are configured)`)
  }
  expect(empty.knownModels()).toEqual([])
  const ai = createAi({
    providers: [
      { id: "a", dialect: "anthropic-messages", baseUrl: "http://a" },
      { id: "b", dialect: "google-gemini", baseUrl: "http://b" },
    ],
  })
  expect(ai.providers().map((p) => p.id)).toEqual(["a", "b"])
  expect(ai.model("b/gemini-x").dialect).toBe("google-gemini")
  expect(() => ai.model("openai/gpt-5")).toThrow('unknown provider "openai" (configured: a, b)')
})

test("ids that are Object members find no stored key or catalog alias", async () => {
  const ai = createAi({
    env: {},
    providers: [{ id: "constructor", dialect: "openai-chat", baseUrl: "http://c", apiKeyEnv: "C_KEY" }],
  })
  expect(ai.hasKey("constructor")).toBe(false)
  const evs = await events(ai.stream({ ...req("constructor"), model: ai.model("constructor/m") }))
  expect((evs[0] as ErrorEvent).error.code).toBe("missing_api_key")
})

test("removing a provider forgets it", () => {
  const ai = createAi({
    providers: [{ id: "anthropic", dialect: "anthropic-messages", baseUrl: "http://a" }],
  })
  ai.removeProvider?.("anthropic")
  expect(ai.providers()).toEqual([])
  expect(() => ai.model("anthropic/x")).toThrow(/unknown provider "anthropic"/)
})

test("streaming with NO_MODEL explains how to add a provider or pick a model", async () => {
  expect(isNoModel(NO_MODEL)).toBe(true)
  const request = { ...req(""), model: NO_MODEL }
  const none = (await events(createAi().stream(request)))[0] as ErrorEvent
  expect(none.error).toEqual({
    code: "no_model",
    message: "no providers configured; add one with /provider add, then pick a model with /model",
  })
  const some = createAi({ providers: [{ id: "a", dialect: "openai-chat", baseUrl: "http://a" }] })
  const unpicked = (await events(some.stream(request))) as ErrorEvent[]
  expect(unpicked).toHaveLength(1)
  expect(unpicked[0]?.error).toEqual({ code: "no_model", message: "no model selected; pick one with /model" })
  expect(unpicked[0]?.retryable).toBe(false)
})
