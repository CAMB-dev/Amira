import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { collect, type Dialect } from "../src/dialect.ts"
import { googleGemini } from "../src/dialects/google-gemini.ts"
import { openaiChat } from "../src/dialects/openai-chat.ts"
import { openaiResponses } from "../src/dialects/openai-responses.ts"
import type { FastOption, ModelRequest, StreamEvent } from "../src/types.ts"
import { dataSSE, req, run } from "./dialect-helpers.ts"

const dialects = [openaiChat, openaiResponses, googleGemini]
const tokens = { input: 70, output: 8, cacheRead: 30, cacheWrite: 0 }
const chatUsage = { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 30 } }
const responsesUsage = { input_tokens: 100, output_tokens: 8, input_tokens_details: { cached_tokens: 30 } }
const geminiUsage = { promptTokenCount: 100, candidatesTokenCount: 8, cachedContentTokenCount: 30 }

function request(
  dialect: Dialect,
  fastMode?: boolean,
  fast: FastOption | false = { kind: "service-tier", value: "priority" },
) {
  const r = req(dialect.id, { fastMode }, { images: true })
  // These are explicit per-model transport options, not inferred from the dialect or model id.
  const model = { ...r.model, fast }
  return { ...r, model }
}

function terminal(evs: StreamEvent[]) {
  const result = evs.at(-1)
  if (result?.type !== "done" && result?.type !== "error") throw new Error("missing terminal event")
  return result
}

function response(dialect: Dialect, streaming: boolean, tier?: unknown, header?: string) {
  const meta = tier === undefined ? {} : { service_tier: tier }
  let plain: unknown
  let chunks: unknown[]
  if (dialect === openaiChat) {
    plain = { ...meta, usage: chatUsage, choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }
    chunks = [
      { ...meta, choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      { usage: chatUsage, choices: [] },
    ]
  } else if (dialect === openaiResponses) {
    plain = { ...meta, usage: responsesUsage, status: "completed", output: [] }
    chunks = [
      { type: "response.created", response: meta },
      { type: "response.completed", response: { usage: responsesUsage } },
    ]
  } else {
    plain = {
      ...meta,
      usageMetadata: geminiUsage,
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    }
    chunks = [plain]
  }
  const headers: Record<string, string> = {
    "content-type": streaming ? "text/event-stream" : "application/json",
  }
  if (header !== undefined) headers["x-gemini-service-tier"] = header
  const body = streaming
    ? dataSSE(chunks) + (dialect === openaiChat ? "data: [DONE]\n\n" : "")
    : JSON.stringify(plain)
  return new Response(body, { headers })
}

for (const dialect of dialects) {
  test(`${dialect.id}: sends configured service_tier only when fast mode is on and supported`, async () => {
    for (const fastMode of [true, false, undefined]) {
      for (const fast of [{ kind: "service-tier", value: "priority" }, false] as const) {
        const { seen } = await run(dialect, request(dialect, fastMode, fast), response(dialect, false))
        if (fastMode && fast) expect(seen.body.service_tier).toBe("priority")
        else expect(seen.body).not.toHaveProperty("service_tier")
        expect(seen.body).not.toHaveProperty("speed")
      }
    }
  })

  test(`${dialect.id}: sends the configured value without hard-coding priority`, async () => {
    const { seen } = await run(
      dialect,
      request(dialect, true, { kind: "service-tier", value: "ultrafast" }),
      response(dialect, false),
    )
    expect(seen.body.service_tier).toBe("ultrafast")
  })

  test(`${dialect.id}: text-only tier does not accompany image input`, async () => {
    const r: ModelRequest = request(dialect, true, {
      kind: "service-tier",
      value: "priority",
      textOnly: true,
    })
    r.messages = [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] }]
    const { seen } = await run(dialect, r, response(dialect, false))
    expect(seen.body).not.toHaveProperty("service_tier")
  })

  for (const streaming of [false, true]) {
    test(`${dialect.id}: ${streaming ? "streaming" : "plain"} never assumes the requested tier was served`, async () => {
      const { evs } = await run(dialect, request(dialect, true), response(dialect, streaming))
      const result = terminal(evs)
      expect(result.type).toBe("done")
      expect(result.message.usage).toEqual(tokens)
    })
  }
}

for (const dialect of [openaiChat, openaiResponses]) {
  for (const streaming of [false, true]) {
    for (const tier of ["priority", "default", "future-vendor-tier"]) {
      test(`${dialect.id}: ${streaming ? "streaming" : "plain"} preserves actual ${tier} echo and token counts`, async () => {
        const { evs } = await run(dialect, request(dialect, true), response(dialect, streaming, tier))
        const result = terminal(evs)
        expect(result.type).toBe("done")
        expect(result.message.usage).toEqual({ ...tokens, serviceTier: tier })
      })
    }

    test(`${dialect.id}: ${streaming ? "streaming" : "plain"} ignores non-string service tiers`, async () => {
      for (const tier of [null, 123, { value: "priority" }]) {
        const { evs } = await run(dialect, request(dialect, true), response(dialect, streaming, tier))
        expect(terminal(evs).message.usage).toEqual(tokens)
      }
    })
  }
}

test("Chat keeps token counts when the actual tier arrives later, including on a partial error", async () => {
  const { evs } = await run(
    openaiChat,
    request(openaiChat, true),
    new Response(
      dataSSE([
        { usage: chatUsage, choices: [] },
        { service_tier: "default", choices: [{ delta: { content: "partial" } }] },
        { service_tier: null, choices: [] },
        { error: { message: "failed" } },
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ),
  )
  const result = terminal(evs)
  expect(result.type).toBe("error")
  expect(result.message.usage).toEqual({ ...tokens, serviceTier: "default" })
})

test("Responses retains tier-only metadata without claiming a reported output count", async () => {
  const { evs } = await run(
    openaiResponses,
    request(openaiResponses, true),
    new Response(
      dataSSE([
        { type: "response.created", response: { service_tier: "default" } },
        { type: "response.completed", response: {} },
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ),
  )
  expect(terminal(evs).message.usage).toEqual({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    outputReported: false,
    serviceTier: "default",
  })
})

for (const event of ["response.created", "response.in_progress", "response.completed"]) {
  test(`Responses retains ${event} tier when usage arrives separately`, async () => {
    const tier = { type: event, response: { service_tier: "default" } }
    const chunks =
      event === "response.completed"
        ? [{ type: "response.in_progress", response: { usage: responsesUsage } }, tier]
        : [tier, { type: "response.completed", response: { usage: responsesUsage } }]
    const { evs } = await run(
      openaiResponses,
      request(openaiResponses, true),
      new Response(dataSSE(chunks), { headers: { "content-type": "text/event-stream" } }),
    )
    expect(terminal(evs).message.usage).toEqual({ ...tokens, serviceTier: "default" })
  })
}

test("Responses keeps an early tier on a later stream failure and lets a later actual echo override it", async () => {
  const { evs } = await run(
    openaiResponses,
    request(openaiResponses, true),
    new Response(
      dataSSE([
        { type: "response.created", response: { service_tier: "priority" } },
        { type: "response.in_progress", response: { service_tier: "default" } },
        { type: "response.failed", response: { usage: responsesUsage, error: { message: "failed" } } },
      ]),
      { headers: { "content-type": "text/event-stream" } },
    ),
  )
  const result = terminal(evs)
  expect(result.type).toBe("error")
  expect(result.message.usage).toEqual({ ...tokens, serviceTier: "default" })
})

for (const streaming of [false, true]) {
  for (const tier of ["priority", "default", "future-vendor-tier"]) {
    test(`Gemini ${streaming ? "streaming" : "plain"} reads actual ${tier} header, not body`, async () => {
      const { evs } = await run(
        googleGemini,
        request(googleGemini, true),
        response(googleGemini, streaming, "body-must-be-ignored", tier),
      )
      expect(terminal(evs).message.usage).toEqual({ ...tokens, serviceTier: tier })
    })
  }

  test(`Gemini ${streaming ? "streaming" : "plain"} ignores body tier without the header`, async () => {
    const { evs } = await run(
      googleGemini,
      request(googleGemini, true),
      response(googleGemini, streaming, "priority"),
    )
    expect(terminal(evs).message.usage).toEqual(tokens)
  })

  test(`Gemini ${streaming ? "streaming" : "plain"} preserves header and usage on provider errors`, async () => {
    const chunk = {
      usageMetadata: geminiUsage,
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "busy" },
    }
    const { evs } = await run(
      googleGemini,
      request(googleGemini, true),
      new Response(streaming ? dataSSE([chunk]) : JSON.stringify(chunk), {
        headers: {
          "content-type": streaming ? "text/event-stream" : "application/json",
          "x-gemini-service-tier": "default",
        },
      }),
    )
    const result = terminal(evs)
    expect(result.type).toBe("error")
    expect(result.message.usage).toEqual({ ...tokens, serviceTier: "default" })
  })
}

test.each([false, true])(
  "Gemini ignores nested body tier metadata (streaming=%s); only the header establishes the tier",
  async (streaming) => {
    const body = {
      usageMetadata: { ...geminiUsage, serviceTier: "priority" },
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    }
    for (const header of ["standard", "priority", undefined]) {
      const { evs } = await run(
        googleGemini,
        request(googleGemini, true),
        new Response(streaming ? dataSSE([body]) : JSON.stringify(body), {
          headers: {
            "content-type": streaming ? "text/event-stream" : "application/json",
            ...(header ? { "x-gemini-service-tier": header } : {}),
          },
        }),
      )
      expect(terminal(evs).message.usage).toEqual({ ...tokens, ...(header ? { serviceTier: header } : {}) })
    }
  },
)

test.each([false, true])(
  "Gemini body-only priority cannot select configured premium prices (streaming=%s)",
  async (streaming) => {
    const body = {
      usageMetadata: { ...geminiUsage, serviceTier: "priority" },
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    }
    const ai = createAi({
      providers: [
        {
          id: "gemini",
          dialect: "google-gemini",
          baseUrl: "https://generativelanguage.googleapis.com",
          defaultModel: {
            fast: { kind: "service-tier", value: "priority" },
            cost: { input: 2, output: 4, cacheRead: 1, fast: { input: 20, output: 40, cacheRead: 10 } },
          },
        },
      ],
      fetch: Object.assign(
        async () =>
          new Response(streaming ? dataSSE([body]) : JSON.stringify(body), {
            headers: { "content-type": streaming ? "text/event-stream" : "application/json" },
          }),
        { preconnect: () => {} },
      ),
      retry: { retries: 0 },
    })
    const model = ai.model("gemini/gemini-test")
    expect(model.cost?.fast).toEqual({ input: 20, output: 40, cacheRead: 10 })
    const message = await collect(ai.stream({ ...req("google-gemini"), model, fastMode: true }))
    expect(message.usage?.cost).toBeCloseTo((70 * 2 + 8 * 4 + 30) / 1e6, 12)
    expect(message.usage?.serviceTier).toBeUndefined()
    expect(message.usage?.speed).toBeUndefined()
    expect(message.usage?.pricingUnknown).toBe(true)
  },
)

test("Gemini reads the tier on HTTP errors without inventing reported token usage", async () => {
  const { evs } = await run(
    googleGemini,
    request(googleGemini, true),
    Response.json(
      { error: { message: "busy", status: "RESOURCE_EXHAUSTED" } },
      {
        status: 429,
        headers: { "x-gemini-service-tier": "default" },
      },
    ),
  )
  const result = terminal(evs)
  expect(result.type).toBe("error")
  expect(result.message.usage).toEqual({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    outputReported: false,
    serviceTier: "default",
  })
})
