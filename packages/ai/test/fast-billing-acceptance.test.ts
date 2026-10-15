import { expect, test } from "bun:test"
import { createCatalog, trimModelsDev } from "../src/catalog.ts"
import { createAi } from "../src/client.ts"
import { usageCost } from "../src/cost.ts"
import { collect } from "../src/dialect.ts"
import type { FastOption, Usage } from "../src/types.ts"
import { fakeFetch, sseResponse } from "./helpers.ts"

const standard = { input: 5, output: 25 }
const configuredFast = { input: 7, output: 9 }
const anthropicSpeed = { kind: "anthropic-speed" } as const
const priority = { kind: "service-tier", value: "priority" } as const

async function anthropicReply(
  streaming: boolean,
  fast: FastOption | false | undefined,
  fastMode: boolean,
  usage: Record<string, unknown>,
  gateway = false,
) {
  const ai = createAi({
    providers: [
      {
        id: "p",
        dialect: "anthropic-messages",
        baseUrl: gateway ? "https://gateway.invalid" : "https://api.anthropic.com",
        models: [
          {
            id: "claude-opus-5-5",
            fast,
            cost: { ...standard, ...(gateway ? { fast: configuredFast } : {}) },
          },
        ],
      },
    ],
    retry: { retries: 0 },
    fetch: fakeFetch(() =>
      streaming
        ? sseResponse([
            { type: "message_start", message: { usage } },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
            { type: "message_stop" },
          ])
        : Response.json({ type: "message", content: [], stop_reason: "end_turn", usage }),
    ),
  })
  return collect(
    ai.stream({
      model: ai.model("p/claude-opus-5-5"),
      systemPrompt: "",
      messages: [],
      tools: [],
      fastMode,
    }),
  )
}

for (const streaming of [false, true]) {
  test.each([undefined, anthropicSpeed, false])(
    `Claude independent priority tier never confirms fast billing (streaming=${streaming}, fast=%j)`,
    async (fast) => {
      for (const fastMode of [false, true]) {
        const usage = (
          await anthropicReply(streaming, fast, fastMode, {
            input_tokens: 1_000_000,
            output_tokens: 0,
            service_tier: "priority",
          })
        ).usage!
        expect(usage.speed).toBeUndefined()
        expect(usage.serviceTier).toBe("priority")
        expect(usage.cost).toBe(5)
        // A requested speed without a speed echo remains unconfirmed, even with a tier echo.
        expect(usage.pricingUnknown).toBe(fastMode && fast !== false ? true : undefined)
      }
    },
  )

  test(`only explicit Claude fast speed activates its confirmed price (streaming=${streaming})`, async () => {
    for (const fast of [anthropicSpeed, false] as const) {
      const usage = (
        await anthropicReply(streaming, fast, false, {
          input_tokens: 1_000_000,
          output_tokens: 0,
          speed: "fast",
          service_tier: "standard",
        })
      ).usage!
      expect(usage.speed).toBe("fast")
      expect(usage.cost).toBe(8)
      expect(usage.pricingUnknown).toBeUndefined()
    }
  })

  test(`a speed-configured gateway cannot infer fast from its independent tier (streaming=${streaming})`, async () => {
    const usage = (
      await anthropicReply(
        streaming,
        anthropicSpeed,
        true,
        {
          input_tokens: 1_000_000,
          output_tokens: 0,
          service_tier: "priority",
        },
        true,
      )
    ).usage!
    expect(usage.speed).toBeUndefined()
    expect(usage.cost).toBe(5)
    expect(usage.pricingUnknown).toBe(true)
  })

  test(`an explicitly service-tier gateway still prices its served priority tier (streaming=${streaming})`, async () => {
    const usage = (
      await anthropicReply(
        streaming,
        priority,
        false,
        {
          input_tokens: 1_000_000,
          output_tokens: 0,
          service_tier: "priority",
        },
        true,
      )
    ).usage!
    expect(usage.speed).toBe("fast")
    expect(usage.cost).toBe(7)
    expect(usage.pricingUnknown).toBeUndefined()
  })
}

test("usageCost never infers an option from raw tier metadata", () => {
  const usage: Usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, serviceTier: "priority" }
  expect(usageCost(usage, { ...standard, fast: { input: 8, output: 40 } })).toBe(5)
})

test.each([
  ["openai", "https://api.openai.com/v1", "gpt-5.5"],
  ["openai", "https://api.openai.com/v1", "gpt-5.4"],
  ["xai", "https://api.x.ai/v1", "grok-4.7"],
  ["deepinfra", "https://api.deepinfra.com/v1/openai", "deepseek-ai/DeepSeek-V4-Flash-0731"],
] as const)(
  "%s/%s/%s has no unverified built-in premium and retains user-configured rates",
  async (vendor, baseUrl, model) => {
    const data = { [vendor]: { models: { [model]: { tags: ["priority"], cost: { input: 5, output: 25 } } } } }
    for (const source of [data, trimModelsDev(data)]) {
      const catalog = createCatalog(source)
      expect(catalog.find(vendor, model)?.cost?.fast).toBeUndefined()
      for (const fast of [undefined, configuredFast]) {
        const ai = createAi({
          catalog,
          providers: [
            {
              id: vendor,
              baseUrl,
              dialect: "openai-chat",
              models: [{ id: model, ...(fast ? { cost: { ...standard, fast } } : {}) }],
            },
          ],
          retry: { retries: 0 },
          fetch: fakeFetch(() =>
            Response.json({
              service_tier: "priority",
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
            }),
          ),
        })
        const usage = (
          await collect(
            ai.stream({
              model: ai.model(`${vendor}/${model}`),
              systemPrompt: "",
              messages: [],
              tools: [],
              fastMode: true,
            }),
          )
        ).usage!
        expect(usage.cost).toBe(fast ? 7 : 5)
        expect(usage.pricingUnknown).toBe(fast ? undefined : true)
      }
    }
  },
)

test("priority tags never replace explicit catalog premium prices, including after trimming", () => {
  const raw = {
    deepinfra: {
      models: {
        tagged: {
          tags: ["priority"],
          cost: { input: 1, output: 2, fast: { input: 7, output: 9, cache_read: 0.7, cache_write: 8.75 } },
        },
      },
    },
  }
  for (const data of [raw, trimModelsDev(raw)]) {
    const catalog = createCatalog(data)
    expect(catalog.find("deepinfra", "tagged")?.cost?.fast).toEqual({
      input: 7,
      output: 9,
      cacheRead: 0.7,
      cacheWrite: 8.75,
    })
    const ai = createAi({
      catalog,
      providers: [
        { id: "deepinfra", baseUrl: "https://api.deepinfra.com/v1/openai", dialect: "openai-chat" },
      ],
    })
    expect(ai.model("deepinfra/tagged").cost?.fast).toEqual({
      input: 7,
      output: 9,
      cacheRead: 0.7,
      cacheWrite: 8.75,
    })
  }
})
