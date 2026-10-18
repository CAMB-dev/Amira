import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { createMockDialect } from "../src/dialects/mock.ts"
import type { StreamEvent } from "../src/types.ts"
import { events } from "./helpers.ts"

for (const boundary of ["missing", "real", "end"] as const) {
  test(`an aborted retry preserves the ${boundary} dialect request boundary`, async () => {
    const controller = new AbortController()
    const mock = createMockDialect([
      { error: { message: "temporary failure", retryable: true }, usage: { cost: 2 } },
      () => {
        controller.abort()
        return { usage: { cost: 3 } }
      },
    ])
    const ai = createAi({
      dialects: [
        {
          ...mock,
          async *stream(request, context) {
            if (boundary === "real") yield { type: "request.start", thinkingDisplay: "omitted" }
            for await (const event of mock.stream(request, context)) {
              if (boundary === "end" && event.type === "error" && event.error.code === "aborted") {
                yield { type: "request.end", message: event.message }
              }
              yield event
            }
          },
        },
      ],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      retry: { retries: 1, baseDelayMs: 0 },
    })
    const out = await events(
      ai.stream({ model: ai.model("mock/m"), systemPrompt: "", messages: [], tools: [] }, controller.signal),
    )
    expect(mock.requests).toHaveLength(2)
    const attempts = out.filter((event) => event.type === "request.attempt")
    expect(attempts).toHaveLength(2)
    expect(new Set(attempts.map((event) => event.id)).size).toBe(2)
    expect(out.map((event) => event.type)).toEqual(
      boundary === "real"
        ? [
            "request.attempt",
            "request.start",
            "start",
            "request.end",
            "retry",
            "request.attempt",
            "request.start",
            "error",
          ]
        : boundary === "end"
          ? ["request.attempt", "start", "request.end", "retry", "request.attempt", "request.end", "error"]
          : ["request.attempt", "start", "request.end", "retry", "request.attempt", "error"],
    )
    const starts = out.filter((event) => event.type === "request.start")
    expect(starts).toEqual(
      boundary === "real"
        ? [
            { type: "request.start", thinkingDisplay: "omitted" },
            { type: "request.start", thinkingDisplay: "omitted" },
          ]
        : [],
    )
    const costs = out
      .filter(
        (event): event is Extract<StreamEvent, { type: "request.end" | "error" }> =>
          event.type === "request.end" || event.type === "error",
      )
      .map((event) => event.message.usage?.cost)
    expect(costs).toEqual(boundary === "end" ? [2, 3, 3] : [2, 3])
  })
}
