import { expect, test } from "bun:test"
import { createCatalog, trimModelsDev } from "../src/catalog.ts"
import { createAi } from "../src/client.ts"
import { collect } from "../src/dialect.ts"
import type { ProviderConfig } from "../src/providers.ts"
import type { ModelRequest } from "../src/types.ts"
import { events, fakeFetch, type Seen } from "./helpers.ts"

const standard = { input: 5, output: 30, cacheRead: 0.5 }
const priority = { kind: "service-tier", value: "priority" } as const
const dialects = ["openai-chat", "openai-responses"]

function response(dialect: string, tier?: string, input = 100) {
  const meta = tier ? { service_tier: tier } : {}
  return Response.json(
    dialect === "openai-chat"
      ? {
          ...meta,
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: input, completion_tokens: 10 },
        }
      : { ...meta, status: "completed", output: [], usage: { input_tokens: input, output_tokens: 10 } },
  )
}

function setup(
  dialect: string,
  replies: (() => Response)[],
  config: Partial<ProviderConfig> = {},
  retries = 0,
) {
  const seen: Seen[] = []
  const ai = createAi({
    providers: [
      { id: "p", baseUrl: "https://api.openai.com/v1", dialect, defaultModel: { cost: standard }, ...config },
    ],
    retry: { retries, baseDelayMs: 0 },
    fetch: (async (url, init) => {
      const attempt: Seen = {}
      seen.push(attempt)
      const reply = replies.shift()
      if (!reply) throw new Error("unexpected HTTP request")
      return fakeFetch(reply, attempt)(url, init)
    }) as typeof fetch,
  })
  const req: ModelRequest = {
    model: ai.model("p/gpt-5.5"),
    systemPrompt: "",
    messages: [],
    tools: [],
    fastMode: true,
  }
  return { ai, req, seen }
}

for (const dialect of dialects) {
  test(`${dialect}: first-party priority preset retains marked standard estimates without configured premiums`, async () => {
    for (const tier of ["priority", "default"]) {
      const { ai, req, seen } = setup(dialect, [() => response(dialect, tier)])
      expect(req.model.fast).toEqual(priority)
      const message = await collect(ai.stream(req))
      expect(seen[0]!.body.service_tier).toBe("priority")
      expect(message.usage?.serviceTier).toBe(tier)
      expect(message.usage?.speed).toBe(tier === "priority" ? "fast" : "standard")
      expect(message.usage?.pricingUnknown).toBe(tier === "priority" ? true : undefined)
      expect(message.usage?.cost).toBeCloseTo((100 * 5 + 10 * 30) / 1e6, 12)
    }
  })

  test(`${dialect}: config can override the tier, disable a preset, and opt in a gateway`, async () => {
    for (const fast of [false, { kind: "service-tier", value: "fast" }] as const) {
      const { ai, req, seen } = setup(dialect, [() => response(dialect, "default")], {
        defaultModel: { fast: false },
        models: [{ id: "gpt-5.5", fast }],
      })
      await collect(ai.stream(req))
      expect(seen[0]!.body.service_tier).toBe(fast ? "fast" : undefined)
    }
    const { ai, req, seen } = setup(dialect, [() => response(dialect, "priority")], {
      baseUrl: "https://gateway.invalid/v1",
      defaultModel: { fast: priority, cost: standard },
    })
    const result = await collect(ai.stream(req))
    expect(seen[0]!.body.service_tier).toBe("priority")
    expect(result.usage?.pricingUnknown).toBe(true)
    expect(result.usage?.cost).toBeCloseTo((100 * 5 + 10 * 30) / 1e6, 12)
  })

  test(`${dialect}: priority-specific limits retry once immediately without changing the next request`, async () => {
    const fail = () =>
      Response.json(
        {
          error: { code: "priority_rate_limit_exceeded", message: "Priority processing capacity exhausted" },
        },
        { status: 429, headers: { "retry-after": "3600" } },
      )
    const { ai, req, seen } = setup(dialect, [
      fail,
      () => response(dialect, "default"),
      () => response(dialect, "priority"),
    ])
    const out = await events(ai.stream(req))
    expect(out.filter((e) => e.type === "fast.fallback")).toHaveLength(1)
    expect(out.some((e) => e.type === "retry")).toBe(false)
    expect(out.at(-1)).toMatchObject({
      type: "done",
      message: { usage: { serviceTier: "default", speed: "standard" } },
    })
    await collect(ai.stream(req))
    expect(seen.map((s) => s.body.service_tier)).toEqual(["priority", "default", "priority"])
    expect(req.fastMode).toBe(true)
  })

  test(`${dialect}: standard failure after fallback keeps ordinary retries standard`, async () => {
    const fail = (message: string) => () => Response.json({ error: { message } }, { status: 529 })
    const { ai, req, seen } = setup(
      dialect,
      [fail("Priority tier capacity"), fail("overloaded"), () => response(dialect, "default")],
      {},
      1,
    )
    const out = await events(ai.stream(req))
    expect(seen.map((s) => s.body.service_tier)).toEqual(["priority", "default", "default"])
    expect(out.filter((e) => e.type === "fast.fallback")).toHaveLength(1)
    expect(out.filter((e) => e.type === "retry")).toHaveLength(1)
  })

  test(`${dialect}: ordinary rate limits do not trigger priority fallback`, async () => {
    const { ai, req, seen } = setup(
      dialect,
      [
        () => Response.json({ error: { message: "account rate limit" } }, { status: 429 }),
        () => response(dialect, "priority"),
      ],
      {},
      1,
    )
    const out = await events(ai.stream(req))
    expect(seen.map((s) => s.body.service_tier)).toEqual(["priority", "priority"])
    expect(out.some((e) => e.type === "fast.fallback")).toBe(false)
  })

  test(`${dialect}: configured response header overrides a conflicting body tier`, async () => {
    const { ai, req } = setup(
      dialect,
      [
        () => {
          const res = response(dialect, "priority")
          res.headers.set("x-served-tier", "default")
          return res
        },
      ],
      { defaultModel: { fast: { ...priority, responseHeader: "x-served-tier" }, cost: standard } },
    )
    const result = await collect(ai.stream(req))
    expect(result.usage).toMatchObject({ serviceTier: "default", speed: "standard" })
    expect(result.usage?.pricingUnknown).toBeUndefined()
  })
}

test("presets are endpoint-, model-, and dialect-scoped, not inferred from arbitrary provider names", () => {
  for (const [baseUrl, dialect, model, fast] of [
    ["https://api.openai.com/v1", "openai-chat", "gpt-5.4", priority],
    ["https://api.x.ai/v1", "openai-chat", "grok-4.7", { ...priority, textOnly: true }],
    [
      "https://generativelanguage.googleapis.com/v1beta",
      "google-gemini",
      "gemini-2.5-pro",
      { ...priority, responseHeader: "x-gemini-service-tier" },
    ],
    ["https://openrouter.ai/api/v1", "openai-chat", "anthropic/claude-opus-5-5", priority],
    ["https://api.deepinfra.com/v1/openai", "openai-chat", "deepseek-ai/DeepSeek-V4-Flash-0731", priority],
    ["https://api.deepseek.com/v1", "openai-chat", "deepseek-chat", undefined],
    ["https://api.moonshot.ai/v1", "openai-chat", "kimi-k2.7-code-highspeed", undefined],
    ["https://proxy.invalid/v1", "openai-chat", "gpt-5.5", undefined],
    ["https://api.openai.com.evil.invalid", "openai-chat", "gpt-5.5", undefined],
    ["https://api.openai.com/v1", "google-gemini", "gpt-5.5", undefined],
    ["https://api.x.ai/v1", "openai-chat", "grok-imagine-image", undefined],
    ["https://openrouter.ai/api/v1", "openai-chat", "deepseek/deepseek-chat", undefined],
    ["https://api.deepinfra.com/v1/openai", "openai-chat", "untagged-model", undefined],
  ] as const) {
    const ai = createAi({ providers: [{ id: "p", baseUrl, dialect }] })
    expect(ai.model(`p/${model}`).fast).toEqual(fast)
  }
})

test("catalog options/prices survive trimming, while borrowed vendor catalog tiers never leak", () => {
  const raw = {
    openai: { models: { "gpt-5.5": { cost: { input: 5, output: 30 } } } },
    custom: {
      models: { model: { fast: priority, cost: { input: 1, output: 2, fast: { input: 3, output: 4 } } } },
    },
    deepinfra: {
      models: {
        tagged: { tags: ["priority"], cost: { input: 1, output: 2 } },
        untagged: { cost: { input: 1, output: 2 } },
      },
    },
  }
  for (const data of [raw, trimModelsDev(raw)]) {
    const catalog = createCatalog(data)
    expect(catalog.find("openai", "gpt-5.5")?.cost?.fast).toBeUndefined()
    const ai = createAi({
      catalog,
      providers: [
        { id: "proxy", dialect: "openai-chat", baseUrl: "https://proxy.invalid", catalogId: "openai" },
        { id: "custom", dialect: "openai-chat", baseUrl: "https://custom.invalid" },
        { id: "deepinfra", dialect: "openai-chat", baseUrl: "https://api.deepinfra.com/v1/openai" },
      ],
    })
    expect(ai.model("proxy/gpt-5.5").fast).toBeUndefined()
    expect(ai.model("proxy/gpt-5.5").cost?.fast).toBeUndefined()
    expect(ai.model("custom/model").fast).toEqual(priority)
    expect(ai.model("custom/model").cost?.fast).toEqual({ input: 3, output: 4 })
    expect(ai.model("deepinfra/tagged").fast).toEqual(priority)
    expect(ai.model("deepinfra/tagged").cost?.fast).toBeUndefined()
    expect(ai.model("deepinfra/untagged").fast).toBeUndefined()
  }
})

test("configured premium context limits fall back to marked standard estimates", async () => {
  for (const input of [271_999, 272_000]) {
    const { ai, req } = setup("openai-responses", [() => response("openai-responses", "priority", input)], {
      defaultModel: { cost: { ...standard, fast: { input: 12.5, output: 75, maxInputTokens: 271_999 } } },
    })
    const usage = (await collect(ai.stream(req))).usage!
    expect(usage.pricingUnknown).toBe(input < 272_000 ? undefined : true)
    expect(usage.cost).toBeCloseTo(
      (input * (input < 272_000 ? 12.5 : 5) + 10 * (input < 272_000 ? 75 : 30)) / 1e6,
      12,
    )
  }
  const { ai, req } = setup("openai-chat", [() => response("openai-chat")])
  expect((await collect(ai.stream(req))).usage).toMatchObject({ pricingUnknown: true })
})

test("Gemini overflow downgrade trusts the header and does not retry", async () => {
  const { ai, req, seen } = setup(
    "google-gemini",
    [
      () =>
        Response.json(
          {
            candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
            service_tier: "priority",
          },
          { headers: { "x-gemini-service-tier": "standard" } },
        ),
    ],
    {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    },
  )
  const result = await collect(ai.stream({ ...req, model: ai.model("p/gemini-2.5-pro") }))
  expect(seen).toHaveLength(1)
  expect(seen[0]!.body.service_tier).toBe("priority")
  expect(result.usage).toMatchObject({ serviceTier: "standard", speed: "standard" })
  expect(result.usage?.pricingUnknown).toBeUndefined()
})

test("xAI and OpenAI request presets do not imply verified premium prices", () => {
  const ai = createAi({
    providers: [
      { id: "x", baseUrl: "https://api.x.ai/v1", dialect: "openai-chat", defaultModel: { cost: standard } },
      {
        id: "o",
        baseUrl: "https://api.openai.com/v1",
        dialect: "openai-chat",
        defaultModel: { cost: standard },
      },
    ],
  })
  expect(ai.model("x/grok-4.7").cost?.fast).toBeUndefined()
  expect(ai.model("x/grok-unknown").fast).toBeUndefined()
  expect(ai.model("o/gpt-4.1").fast).toEqual(priority)
  expect(ai.model("o/gpt-4.1").cost?.fast).toBeUndefined()
})

test("an unexpected premium tier cannot reuse known priority rates", async () => {
  const { ai, req } = setup("openai-chat", [() => response("openai-chat", "ultrafast")], {
    defaultModel: { cost: { ...standard, fast: { input: 7, output: 9 } } },
  })
  const usage = (await collect(ai.stream(req))).usage!
  expect(usage).toMatchObject({ serviceTier: "ultrafast", pricingUnknown: true })
  expect(usage.cost).toBeCloseTo((100 * 5 + 10 * 30) / 1e6, 12)
})

test("OpenRouter Messages sends service_tier without the Claude beta and reads usage.service_tier", async () => {
  const { ai, req, seen } = setup(
    "anthropic-messages",
    [
      () =>
        Response.json({
          type: "message",
          content: [],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 10, speed: "fast", service_tier: "priority" },
        }),
    ],
    { baseUrl: "https://openrouter.ai/api", defaultModel: { cost: standard } },
  )
  const result = await collect(ai.stream({ ...req, model: ai.model("p/anthropic/claude-opus-5-5") }))
  expect(seen[0]!.body.service_tier).toBe("priority")
  expect(seen[0]!.body.speed).toBeUndefined()
  expect(seen[0]!.headers["anthropic-beta"]).toBeUndefined()
  expect(result.usage).toMatchObject({ serviceTier: "priority", pricingUnknown: true })
})
