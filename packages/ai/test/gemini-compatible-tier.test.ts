import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { collect } from "../src/dialect.ts"
import { fakeFetch, sseResponse } from "./helpers.ts"

const dialects = ["openai-chat", "openai-responses"]
const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/openai"
const prices = { input: 2, output: 4, fast: { input: 20, output: 40 } }

function response(dialect: string, streaming: boolean, bodyTier: string, header?: string) {
  const headers: Record<string, string> = header === undefined ? {} : { "x-gemini-service-tier": header }
  if (dialect === "openai-chat") {
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 0 }
    return streaming
      ? withHeaders(
          sseResponse([
            { service_tier: bodyTier, choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
            { usage, choices: [] },
          ]),
          headers,
        )
      : Response.json(
          { service_tier: bodyTier, usage, choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
          { headers },
        )
  }
  const usage = { input_tokens: 1_000_000, output_tokens: 0 }
  return streaming
    ? withHeaders(
        sseResponse(
          [
            { type: "response.created", response: { service_tier: bodyTier } },
            { type: "response.completed", response: { usage, output: [] } },
          ],
          false,
        ),
        headers,
      )
    : Response.json({ service_tier: bodyTier, usage, status: "completed", output: [] }, { headers })
}

function withHeaders(res: Response, headers: Record<string, string>) {
  for (const [key, value] of Object.entries(headers)) res.headers.set(key, value)
  return res
}

async function reply(
  dialect: string,
  streaming: boolean,
  bodyTier: string,
  header?: string,
  baseUrl = geminiUrl,
  modelId = "gemini-2.5-pro",
  disabled = false,
) {
  const ai = createAi({
    providers: [
      {
        id: "p",
        dialect,
        baseUrl,
        models: [{ id: modelId, cost: prices, ...(disabled ? { fast: false as const } : {}) }],
      },
    ],
    fetch: fakeFetch(() => response(dialect, streaming, bodyTier, header)),
    retry: { retries: 0 },
  })
  return collect(
    ai.stream({ model: ai.model(`p/${modelId}`), systemPrompt: "", messages: [], tools: [], fastMode: true }),
  )
}

for (const dialect of dialects) {
  for (const streaming of [false, true]) {
    test(`Gemini ${dialect} ignores body-only priority for billing (streaming=${streaming})`, async () => {
      const usage = (await reply(dialect, streaming, "priority")).usage!
      expect(usage.input).toBe(1_000_000)
      expect(usage.serviceTier).toBeUndefined()
      expect(usage.speed).toBeUndefined()
      expect(usage.cost).toBe(2)
      expect(usage.pricingUnknown).toBe(true)
    })

    for (const header of ["standard", "priority"]) {
      test(`Gemini ${dialect} trusts ${header} header over a conflicting body (streaming=${streaming})`, async () => {
        const usage = (
          await reply(dialect, streaming, header === "priority" ? "default" : "priority", header)
        ).usage!
        expect(usage.serviceTier).toBe(header)
        expect(usage.speed).toBe(header === "priority" ? "fast" : "standard")
        expect(usage.cost).toBe(header === "priority" ? 20 : 2)
        expect(usage.pricingUnknown).toBeUndefined()
      })
    }

    test(`Gemini ${dialect} still ignores body-only tier when the fast preset is disabled (streaming=${streaming})`, async () => {
      const usage = (
        await reply(dialect, streaming, "priority", undefined, geminiUrl, "gemini-2.5-pro", true)
      ).usage!
      expect(usage.serviceTier).toBeUndefined()
      expect(usage.speed).toBeUndefined()
      expect(usage.cost).toBe(2)
    })

    for (const [baseUrl, modelId] of [
      ["https://api.openai.com/v1", "gpt-5.4"],
      ["https://api.x.ai/v1", "grok-4.7"],
      ["https://openrouter.ai/api/v1", "openai/gpt-5.4"],
    ]) {
      test(`${baseUrl} ${dialect} retains ordinary body-tier parsing (streaming=${streaming})`, async () => {
        const usage = (await reply(dialect, streaming, "priority", undefined, baseUrl, modelId)).usage!
        expect(usage.serviceTier).toBe("priority")
        expect(usage.speed).toBe("fast")
        expect(usage.cost).toBe(20)
        expect(usage.pricingUnknown).toBeUndefined()
      })
    }
  }
}
