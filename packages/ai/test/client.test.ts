import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { DEFAULT_CAPS } from "../src/providers.ts"
import type { ModelRequest } from "../src/types.ts"
import { type ErrorEvent, events, fakeFetch, type Seen, sseResponse } from "./helpers.ts"

const req = (provider: string, dialect = "openai-chat"): ModelRequest => ({
  model: { id: "m", provider, dialect, contextWindow: 1000, maxOutput: 100, caps: DEFAULT_CAPS },
  systemPrompt: "",
  messages: [],
  tools: [],
})

test("yields an error event for an unknown provider instead of throwing", async () => {
  const ai = createAi()
  const stream = ai.stream(req("nope"))
  const evs = await events(stream)
  expect(evs).toHaveLength(1)
  const e = evs[0] as ErrorEvent
  expect(e.type).toBe("error")
  expect(e.error.message).toMatch(/unknown provider "nope"/)
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

test("the built-in providers are anthropic, openai, openai-chat and google", () => {
  const ai = createAi()
  expect(ai.providers().map((p) => p.id)).toEqual(["anthropic", "openai", "openai-chat", "google"])
  expect(ai.model("anthropic/claude-x").caps).toMatchObject({ thinking: true, promptCache: true })
  expect(ai.model("openai/gpt-5").dialect).toBe("openai-responses")
  expect(ai.model("google/gemini-x").dialect).toBe("google-gemini")
  expect(() => ai.model("deepseek/x")).toThrow(/unknown provider "deepseek"/)
})
