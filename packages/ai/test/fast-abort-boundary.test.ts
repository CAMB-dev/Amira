import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { createMockDialect } from "../src/dialects/mock.ts"
import type { StreamEvent } from "../src/types.ts"
import { events } from "./helpers.ts"

for (const boundary of ["missing", "real", "end", "logical-start"] as const) {
  test(`an immediately aborted fast fallback preserves the ${boundary} boundary`, async () => {
    const abort = new AbortController()
    const mock = createMockDialect([
      {
        error: { message: "Fast capacity exhausted", status: 429 },
        usage: { input: 20, cost: 0.2, speed: "fast" },
      },
      () => {
        abort.abort()
        return { usage: { input: 30, cost: 0.3, speed: "standard" } }
      },
    ])
    const ai = createAi({
      dialects: [
        {
          ...mock,
          id: "anthropic-messages",
          async *stream(request, context) {
            if (boundary === "real") yield { type: "request.start", thinkingDisplay: "omitted" }
            for await (const event of mock.stream(request, context)) {
              if (event.type === "error" && event.error.code === "aborted") {
                if (boundary === "end") yield { type: "request.end", message: event.message }
                if (boundary === "logical-start") yield { type: "start" }
              }
              yield event
            }
          },
        },
      ],
      providers: [
        {
          id: "mock",
          dialect: "anthropic-messages",
          baseUrl: "",
          defaultModel: {
            fast: { kind: "anthropic-speed" },
            cost: { input: 10_000, output: 0, fast: { input: 10_000, output: 0 } },
          },
        },
      ],
      retry: { retries: 0 },
    })
    const out = await events(
      ai.stream(
        {
          model: ai.model("mock/m"),
          systemPrompt: "",
          messages: [],
          tools: [],
          fastMode: true,
        },
        abort.signal,
      ),
    )
    expect(mock.requests.map((request) => [request.fastMode, request.forceStandard])).toEqual([
      [true, undefined],
      [false, true],
    ])
    const attempts = out.filter((event) => event.type === "request.attempt")
    expect(attempts).toHaveLength(2)
    expect(new Set(attempts.map((event) => event.id)).size).toBe(2)
    const fallback = out.findIndex((event) => event.type === "fast.fallback")
    expect(out.slice(fallback + 1).map((event) => event.type)).toEqual(
      boundary === "real"
        ? ["request.attempt", "request.start", "error"]
        : boundary === "end"
          ? ["request.attempt", "request.end", "error"]
          : ["request.attempt", "error"],
    )
    expect(out.filter((event) => event.type === "request.start")).toEqual(
      boundary === "real"
        ? [
            { type: "request.start", thinkingDisplay: "omitted" },
            { type: "request.start", thinkingDisplay: "omitted" },
          ]
        : [],
    )
    expect(
      out
        .filter(
          (event): event is Extract<StreamEvent, { type: "error" | "request.end" }> =>
            event.type === "error" || event.type === "request.end",
        )
        .map((event) => event.message.usage?.cost),
    ).toEqual(boundary === "end" ? [0.2, 0.3, 0.3] : [0.2, 0.3])
  })
}

for (const at of ["pre-dispatch", "request.end", "fast.fallback", "cleanup"] as const) {
  test(`abort at ${at} never dispatches another physical request`, async () => {
    const abort = new AbortController()
    const mock = createMockDialect([
      { error: { message: "Fast capacity exhausted", status: 429 }, usage: { cost: 0.2 } },
      { text: "must not run" },
    ])
    const ai = createAi({
      dialects: [
        {
          ...mock,
          id: "anthropic-messages",
          async *stream(request, context) {
            try {
              yield* mock.stream(request, context)
            } finally {
              if (at === "cleanup") {
                await Promise.resolve()
                abort.abort()
              }
            }
          },
        },
      ],
      providers: [
        {
          id: "mock",
          dialect: "anthropic-messages",
          baseUrl: "",
          defaultModel: { fast: { kind: "anthropic-speed" } },
        },
      ],
      retry: { retries: 0 },
    })
    if (at === "pre-dispatch") abort.abort()
    const out: StreamEvent[] = []
    for await (const event of ai.stream(
      { model: ai.model("mock/m"), systemPrompt: "", messages: [], tools: [], fastMode: true },
      abort.signal,
    )) {
      out.push(event)
      if (event.type === at) abort.abort()
    }
    const count = at === "pre-dispatch" ? 0 : 1
    expect(mock.requests).toHaveLength(count)
    const attempts = out.filter((event) => event.type === "request.attempt")
    expect(attempts).toHaveLength(count)
    expect(new Set(attempts.map((event) => event.id)).size).toBe(count)
    expect(out.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } })
    expect(out.filter((event) => event.type === "request.start")).toEqual([])
  })
}
