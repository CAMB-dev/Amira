import { expect, test } from "bun:test"
import { createCatalog, trimModelsDev } from "../src/catalog.ts"
import { createAi } from "../src/client.ts"
import { usageCost } from "../src/cost.ts"
import { collect } from "../src/dialect.ts"
import type { ProviderConfig } from "../src/providers.ts"
import type { ModelRequest } from "../src/types.ts"
import {
  anthropicResponse,
  blockDelta,
  blockStart,
  messageDelta,
  messageStart,
  messageStop,
  textReply,
} from "./anthropic-helpers.ts"
import { delta, events, fakeFetch, type Seen, sseResponse } from "./helpers.ts"

const anthropicFast = { kind: "anthropic-speed" } as const
const beta = "fast-mode-2026-02-01"
const provider: ProviderConfig = {
  id: "anth",
  dialect: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
}
const standardCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
const fastCost = { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 }
const catalogData = {
  anthropic: {
    models: {
      "claude-opus-5-5": { id: "claude-opus-5-5", cost: { input: 5, output: 25 } },
    },
  },
}

function setup(responses: (() => Response)[], config: Partial<ProviderConfig> = {}, retries = 0) {
  const seen: Seen[] = []
  const ai = createAi({
    providers: [{ ...provider, ...config }],
    retry: { retries, baseDelayMs: 0 },
    fetch: (async (url, init) => {
      const attempt: Seen = {}
      seen.push(attempt)
      const response = responses.shift()
      if (!response) throw new Error("unexpected request")
      return fakeFetch(response, attempt)(url, init)
    }) as typeof fetch,
  })
  const req: ModelRequest = {
    model: ai.model("anth/claude-opus-5-5"),
    systemPrompt: "",
    messages: [],
    tools: [],
    fastMode: true,
  }
  return { ai, seen, req }
}

const reply = () => anthropicResponse(textReply("ok"))
const failure =
  (status: number, message: string, headers: Record<string, string> = {}) =>
  () =>
    Response.json(
      { type: "error", error: { type: status === 429 ? "rate_limit_error" : "overloaded_error", message } },
      { status, headers },
    )

test("catalog marks supported Claude versions and retains fast prices through trimming", () => {
  for (const data of [catalogData, trimModelsDev(catalogData)]) {
    const model = createCatalog(data).find("anthropic", "claude-opus-5-5")!
    expect(model.fast).toEqual(anthropicFast)
    expect(model.cost?.fast).toEqual(fastCost)
  }
})

test.each(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8-20260201"])(
  "first-party %s defaults to fast availability without needing a catalog",
  (id) => {
    const ai = createAi({ providers: [provider] })
    expect(ai.model(`anth/${id}`).fast).toEqual(anthropicFast)
  },
)

test.each([
  ["claude-opus-5-5", fastCost],
  ["claude-opus-5", { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  ["claude-opus-4-8", { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
] as const)("first-party %s uses the published fast rates without changing standard prices", (id, fast) => {
  const ai = createAi({ providers: [{ ...provider, defaultModel: { cost: standardCost } }] })
  expect(ai.model(`anth/${id}`).cost).toEqual({ ...standardCost, fast })
})

test.each([
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-5-1",
  "gpt-5",
  "claude-opus-5-50",
  "claude-sonnet-5",
  "claude-haiku-5-5",
])("unsupported %s does not default to fast availability", (id) =>
  expect(createAi({ providers: [provider] }).model(`anth/${id}`).fast).toBeUndefined(),
)

test("catalog fast capability and pricing do not leak to compatible endpoints or other dialects", () => {
  for (const config of [
    { baseUrl: "https://proxy.example", catalogId: "anthropic" },
    { baseUrl: "https://api.anthropic.com.evil.example", catalogId: "anthropic" },
    { dialect: "openai-chat", catalogId: "anthropic" },
  ]) {
    const ai = createAi({ providers: [{ ...provider, ...config }], catalog: createCatalog(catalogData) })
    const model = ai.model("anth/claude-opus-5-5")
    expect(model.fast).toBeUndefined()
    expect(model.cost?.fast).toBeUndefined()
    expect(model.cost?.input).toBe(5)
  }
})

test("explicit options opt in compatible endpoints, override catalog, and can disable first-party fast mode", () => {
  const catalog = createCatalog(catalogData)
  for (const fast of [anthropicFast, false] as const) {
    const ai = createAi({
      providers: [
        { ...provider, baseUrl: "https://proxy.example", catalogId: "anthropic", defaultModel: { fast } },
      ],
      catalog,
    })
    expect(ai.model("anth/claude-opus-5-5").fast).toBe(fast)
  }
  const ai = createAi({
    providers: [{ ...provider, models: [{ id: "claude-opus-5-5", fast: false }] }],
    catalog,
  })
  expect(ai.model("anth/claude-opus-5-5").fast).toBe(false)
})

test("sends speed fast and merges the beta once with case-insensitive existing betas", async () => {
  const { ai, req, seen } = setup([reply], { headers: { "Anthropic-Beta": `custom,${beta}` } })
  await collect(ai.stream(req))
  expect(seen[0]!.body.speed).toBe("fast")
  expect(seen[0]!.headers["anthropic-beta"]).toBe(`custom,${beta}`)
  expect(seen[0]!.headers["Anthropic-Beta"]).toBeUndefined()
})

test("does not send fast fields unless requested and available", async () => {
  for (const fastMode of [undefined, false]) {
    const { ai, req, seen } = setup([reply])
    await collect(ai.stream({ ...req, fastMode }))
    expect(seen[0]!.body.speed).toBeUndefined()
    expect(seen[0]!.headers["anthropic-beta"]).toBeUndefined()
  }
  for (const config of [
    { baseUrl: "https://proxy.example" },
    { models: [{ id: "claude-opus-5-5", fast: false as const }] },
  ]) {
    const { ai, req, seen } = setup([reply], config)
    await collect(ai.stream(req))
    expect(seen[0]!.body.speed).toBeUndefined()
    expect(seen[0]!.headers["anthropic-beta"]).toBeUndefined()
  }
  const { ai, req, seen } = setup([reply], {
    baseUrl: "https://proxy.example",
    defaultModel: { fast: anthropicFast },
  })
  await collect(ai.stream(req))
  expect(seen[0]!.body.speed).toBe("fast")
})

test.each(["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5"])(
  "unsupported first-party %s never sends speed even with an explicit capability",
  async (id) => {
    const { ai, req, seen } = setup([reply], { defaultModel: { fast: anthropicFast } })
    await collect(ai.stream({ ...req, model: ai.model(`anth/${id}`) }))
    expect(seen[0]!.body.speed).toBeUndefined()
    expect(seen[0]!.headers["anthropic-beta"]).toBeUndefined()
  },
)

test("a compatible endpoint keeps custom fast prices and prices reported speed even when not requested", async () => {
  const customFast = { input: 2, output: 3 }
  const { ai, req, seen } = setup(
    [
      () =>
        Response.json({
          type: "message",
          content: [],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
            speed: "fast",
          },
        }),
    ],
    {
      baseUrl: "https://custom.example",
      models: [{ id: "custom-model", fast: anthropicFast, cost: { ...standardCost, fast: customFast } }],
    },
  )
  const message = await collect(ai.stream({ ...req, model: ai.model("anth/custom-model"), fastMode: false }))
  expect(seen[0]!.body.speed).toBeUndefined()
  expect(message.usage?.speed).toBe("fast")
  expect(message.usage?.cost).toBeCloseTo((100 * 2 + 50 * 3 + 20 * 0.2 + 10 * 2.5) / 1e6, 12)
  expect(ai.model("anth/custom-model").fast).toEqual(anthropicFast)
  expect(ai.model("anth/custom-model").cost?.fast).toEqual(customFast)
})

test("merges fast and compaction betas and preserves the compaction beta on standard fallback", async () => {
  const { ai, req, seen } = setup([failure(429, "Fast mode capacity exhausted"), reply], {
    headers: { "Anthropic-Beta": "custom" },
  })
  const signature = {
    dialect: "anthropic-messages",
    kind: "checkpoint" as const,
    provider: "anth",
    model: req.model.id,
    host: "api.anthropic.com",
    value: JSON.stringify({ type: "compaction", content: "summary", signature: "signed" }),
  }
  req.messages = [
    { role: "user", content: [{ type: "text", text: "summary", signature }] },
    {
      role: "assistant",
      model: { provider: "amira", model: "compaction" },
      content: [{ type: "text", text: "ACK", signature }],
    },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ]
  await collect(ai.stream(req))
  expect(seen[0]!.body.messages[0].content[0].type).toBe("compaction")
  expect(seen[0]!.headers["anthropic-beta"]).toBe(`custom,compact-2026-09-04,${beta}`)
  expect(seen[1]!.headers["anthropic-beta"]).toBe("custom,compact-2026-09-04")
})

test("fast requests on other dialects do not send Anthropic fields even with explicit caps", async () => {
  const { ai, req, seen } = setup([() => sseResponse([delta({ content: "ok" }, "stop")])], {
    dialect: "openai-chat",
    defaultModel: { fast: anthropicFast },
  })
  await collect(ai.stream(req))
  expect(req.model.fast).toBeUndefined()
  expect(seen[0]!.body.speed).toBeUndefined()
  expect(seen[0]!.headers["anthropic-beta"]).toBeUndefined()
})

test.each([429, 529])("fast HTTP %s falls back immediately once, ignoring Retry-After", async (status) => {
  const { ai, req, seen } = setup([
    failure(status, "Fast mode capacity exhausted", { "retry-after": "3600" }),
    reply,
  ])
  const out = await events(ai.stream(req))
  expect(seen.map((s) => s.body.speed)).toEqual(["fast", undefined])
  expect(out.filter((e) => e.type === "fast.fallback")).toHaveLength(1)
  expect(out.map((e) => e.type)).toEqual([
    "request.attempt",
    "request.start",
    "request.end",
    "fast.fallback",
    "request.attempt",
    "request.start",
    "start",
    "content.start",
    "text.delta",
    "done",
  ])
  expect(seen[1]!.headers["anthropic-beta"]).toBeUndefined()
  expect(req.fastMode).toBe(true)
})

test("a standard failure after fallback uses ordinary retry, staying standard", async () => {
  const { ai, req, seen } = setup(
    [failure(429, "Fast mode rate limit"), failure(529, "overloaded"), reply],
    {},
    1,
  )
  const out = await events(ai.stream(req))
  expect(seen.map((s) => s.body.speed)).toEqual(["fast", undefined, undefined])
  expect(out.filter((e) => e.type === "fast.fallback")).toHaveLength(1)
  expect(out.filter((e) => e.type === "retry")).toHaveLength(1)
})

test.each([429, 529])("ordinary HTTP %s still retries in fast mode without a fallback", async (status) => {
  const { ai, req, seen } = setup([failure(status, "ordinary account limit"), reply], {}, 1)
  const out = await events(ai.stream(req))
  expect(seen.map((s) => s.body.speed)).toEqual(["fast", "fast"])
  expect(out.some((e) => e.type === "fast.fallback")).toBe(false)
  expect(out.some((e) => e.type === "retry")).toBe(true)
})

test("fast errors with other statuses never trigger the standard fallback", async () => {
  const { ai, req, seen } = setup([failure(400, "Fast mode invalid request")])
  const out = await events(ai.stream(req))
  expect(seen).toHaveLength(1)
  expect(out.some((e) => e.type === "fast.fallback")).toBe(false)
  expect(out.at(-1)?.type).toBe("error")
})

test("fallback runs once, is per stream, and never mutates the requested preference", async () => {
  const { ai, req, seen } = setup([
    failure(429, "fast_mode_rate_limit"),
    failure(429, "Fast mode capacity exhausted"),
    reply,
  ])
  const first = await events(ai.stream(req))
  expect(first.filter((e) => e.type === "fast.fallback")).toHaveLength(1)
  expect(first.at(-1)?.type).toBe("error")
  await collect(ai.stream(req))
  expect(seen.map((s) => s.body.speed)).toEqual(["fast", undefined, "fast"])
  expect(req.fastMode).toBe(true)
})

test.each(["stream", "plain"])(
  "fast capacity errors in a %s response fall back before any content",
  async (format) => {
    const error = { type: "error", error: { type: "overloaded_error", message: "Fast mode overloaded" } }
    const { ai, req, seen } = setup([
      () => (format === "stream" ? anthropicResponse([messageStart(), error]) : Response.json(error)),
      reply,
    ])
    const out = await events(ai.stream(req))
    expect(seen.map((s) => s.body.speed)).toEqual(["fast", undefined])
    expect(out.filter((e) => e.type === "fast.fallback")).toHaveLength(1)
    expect(out.at(-1)?.type).toBe("done")
  },
)

test("an empty native block does not prevent fast capacity fallback", async () => {
  const { ai, req, seen } = setup([
    () =>
      anthropicResponse([
        messageStart({ input_tokens: 100, output_tokens: 0, speed: "fast" }),
        blockStart(0, { type: "text", text: "" }),
        { type: "error", error: { type: "overloaded_error", message: "Fast mode overloaded" } },
      ]),
    reply,
  ])
  const out = await events(ai.stream(req))
  expect(seen.map((s) => s.body.speed)).toEqual(["fast", undefined])
  expect(out.filter((e) => e.type === "fast.fallback")).toHaveLength(1)
  expect(out.find((e) => e.type === "request.end")).toMatchObject({
    message: { usage: { input: 100, speed: "fast" } },
  })
})

test("never repeats already-streamed content after a fast capacity error", async () => {
  const { ai, req, seen } = setup(
    [
      () =>
        anthropicResponse([
          messageStart(),
          blockStart(0, { type: "text", text: "" }),
          blockDelta(0, { type: "text_delta", text: "partial" }),
          { type: "error", error: { type: "overloaded_error", message: "Fast mode overloaded" } },
        ]),
    ],
    {},
    1,
  )
  const out = await events(ai.stream(req))
  expect(seen).toHaveLength(1)
  expect(out.some((e) => e.type === "fast.fallback" || e.type === "retry")).toBe(false)
  expect(out.at(-1)).toMatchObject({
    type: "error",
    message: { content: [{ type: "text", text: "partial" }] },
  })
})

test("abort at the fallback notice never sends a standard HTTP request", async () => {
  const { ai, req, seen } = setup([failure(429, "Fast mode capacity exhausted")])
  const controller = new AbortController()
  const out = []
  for await (const event of ai.stream(req, controller.signal)) {
    out.push(event)
    if (event.type === "fast.fallback") controller.abort()
  }
  expect(seen).toHaveLength(1)
  expect(out.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } })
})

test("standard fallback usage uses standard rates and never invents usage speed", async () => {
  const { ai, req } = setup([failure(429, "Fast mode rate limit"), reply], {
    defaultModel: { cost: { ...standardCost, fast: fastCost } },
  })
  const message = await collect(ai.stream(req))
  expect(message.usage?.speed).toBeUndefined()
  expect(message.usage?.pricingUnknown).toBeUndefined()
  expect(message.usage?.cost).toBeCloseTo((10 * 5 + 5 * 25) / 1e6, 12)
})

test.each(["fast", "standard"] as const)(
  "parses streaming usage.speed %s and prices reported rather than requested speed",
  async (speed) => {
    const { ai, req } = setup(
      [
        () =>
          anthropicResponse([
            messageStart({
              input_tokens: 100,
              output_tokens: 0,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 10,
              speed,
            }),
            messageDelta("end_turn", { output_tokens: 50 }),
            messageStop,
          ]),
      ],
      { defaultModel: { cost: { ...standardCost, fast: fastCost } } },
    )
    const message = await collect(ai.stream(req))
    expect(message.usage?.speed).toBe(speed)
    const price = speed === "fast" ? fastCost : standardCost
    expect(message.usage?.cost).toBeCloseTo(
      (100 * price.input + 50 * price.output + 20 * price.cacheRead + 10 * price.cacheWrite) / 1e6,
      12,
    )
  },
)

test("parses plain usage.speed and accepts speed first supplied by message_delta", async () => {
  for (const response of [
    () =>
      Response.json({
        type: "message",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, speed: "fast" },
      }),
    () =>
      anthropicResponse([
        messageStart(),
        messageDelta("end_turn", { output_tokens: 5, speed: "fast" }),
        messageStop,
      ]),
  ]) {
    const { ai, req } = setup([response])
    expect((await collect(ai.stream(req))).usage?.speed).toBe("fast")
  }
})

test.each(["fast", "standard"] as const)(
  "Anthropic explicit speed %s is independent of service_tier",
  async (speed) => {
    const { ai, req } = setup(
      [
        () =>
          Response.json({
            type: "message",
            content: [],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              speed,
              service_tier: speed === "fast" ? "standard" : "priority",
            },
          }),
      ],
      { defaultModel: { cost: { ...standardCost, fast: fastCost } } },
    )
    const usage = (await collect(ai.stream(req))).usage!
    expect(usage.speed).toBe(speed)
    expect(usage.pricingUnknown).toBeUndefined()
    expect(usage.cost).toBeCloseTo(
      (100 * (speed === "fast" ? 8 : 5) + 10 * (speed === "fast" ? 40 : 25)) / 1e6,
      12,
    )
  },
)

test("fast prices preserve configured cache multipliers and explicit cache overrides", () => {
  const usage = { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, speed: "fast" as const }
  const cost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10, fast: { input: 8, output: 40 } }
  expect(usageCost(usage, cost)).toBeCloseTo((800 + 2000 + 16 + 160) / 1e6, 12)
  expect(usageCost(usage, { ...cost, fast: { ...cost.fast, cacheRead: 1, cacheWrite: 12 } })).toBeCloseTo(
    (800 + 2000 + 20 + 120) / 1e6,
    12,
  )
})

test("unknown speed is ignored; unknown fast prices retain standard estimates", async () => {
  const { ai, req } = setup([
    () => anthropicResponse([messageStart({ speed: "turbo" }), messageDelta("end_turn"), messageStop]),
  ])
  expect((await collect(ai.stream(req))).usage?.speed).toBeUndefined()
  expect(
    usageCost({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, speed: "fast" }, standardCost),
  ).toBeCloseTo((10 * 5 + 5 * 25) / 1e6, 12)
})
