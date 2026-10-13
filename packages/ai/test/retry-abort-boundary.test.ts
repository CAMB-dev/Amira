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
    expect(out.map((event) => event.type)).toEqual(
      boundary === "real"
        ? ["request.start", "start", "request.end", "retry", "request.start", "error"]
        : boundary === "end"
          ? ["start", "request.end", "retry", "request.end", "error"]
          : ["start", "request.end", "retry", "request.start", "error"],
    )
    const starts = out.filter((event) => event.type === "request.start")
    expect(starts).toEqual(
      boundary === "real"
        ? [
            { type: "request.start", thinkingDisplay: "omitted" },
            { type: "request.start", thinkingDisplay: "omitted" },
          ]
        : boundary === "end"
          ? []
          : [{ type: "request.start" }],
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
