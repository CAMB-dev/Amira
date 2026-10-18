import { expect, test } from "bun:test"
import { createAi, createMockDialect, type StreamEvent } from "../src/index.ts"

for (const fast of [false, true]) {
  for (const startOnly of [false, true]) {
    test(`SDK emits distinct dispatch identities for a receipt-less ${fast ? "standard fallback" : "retry"} (${startOnly ? "start only" : "empty"})`, async () => {
      let dispatches = 0
      const mock = createMockDialect([
        {
          error: {
            message: fast ? "priority capacity unavailable" : "retry",
            retryable: true,
            status: fast ? 429 : 503,
          },
          usage: { input: 2, output: 1, cost: 0.2 },
        },
      ])
      const ai = createAi({
        dialects: [
          {
            ...mock,
            id: "openai-chat",
            async *stream(request, context) {
              dispatches++
              if (dispatches === 1) yield* mock.stream(request, context)
              else if (startOnly) yield { type: "start" }
            },
          },
        ],
        providers: [
          {
            id: "mock",
            dialect: "openai-chat",
            baseUrl: "https://provider.invalid",
            defaultModel: { fast: { kind: "service-tier", value: "priority" } },
          },
        ],
        retry: { retries: 1, baseDelayMs: 0 },
      })
      const events: StreamEvent[] = []
      for await (const event of ai.stream({
        model: ai.model("mock/test"),
        systemPrompt: "",
        messages: [],
        tools: [],
        fastMode: fast,
      }))
        events.push(event)
      const attempts = events.filter((event) => event.type === "request.attempt")
      expect(dispatches).toBe(2)
      expect(attempts).toHaveLength(2)
      expect(new Set(attempts.map((event) => event.id)).size).toBe(2)
    })
  }
}

test("pre-dispatch cancellation emits no physical attempt identity", async () => {
  const mock = createMockDialect([{ text: "must not run" }])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const controller = new AbortController()
  controller.abort()
  const events: StreamEvent[] = []
  for await (const event of ai.stream(
    { model: ai.model("mock/test"), systemPrompt: "", messages: [], tools: [] },
    controller.signal,
  ))
    events.push(event)
  expect(mock.requests).toHaveLength(0)
  expect(events.filter((event) => event.type === "request.attempt")).toHaveLength(0)
})
