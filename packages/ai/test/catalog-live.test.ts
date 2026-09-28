import { expect, test } from "bun:test"
import { createCatalog } from "../src/catalog.ts"
import { createAi } from "../src/client.ts"
import { collect } from "../src/dialect.ts"
import type { ToolSpec } from "../src/types.ts"
import fixture from "./fixtures/models-dev.json" with { type: "json" }

// Runs against DeepSeek when AMIRA_LIVE_DEEPSEEK_KEY is set.
const KEY_ENV = "AMIRA_LIVE_DEEPSEEK_KEY"
const noKey = !process.env[KEY_ENV]
const TIMEOUT = 120_000

const ai = createAi({
  catalog: createCatalog(fixture),
  providers: [
    { id: "deepseek", dialect: "openai-chat", baseUrl: "https://api.deepseek.com", apiKeyEnv: KEY_ENV },
    {
      id: "ds-text",
      dialect: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: KEY_ENV,
      catalogId: "deepseek",
      models: [{ id: "deepseek-flash", caps: { tools: "none" } }],
    },
  ],
})

const weather: ToolSpec = {
  name: "get_weather",
  description: "Current weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
}

test.skipIf(noKey)(
  "a DeepSeek reply is priced from the catalog",
  async () => {
    const model = ai.model("deepseek/deepseek-flash")
    expect(model.contextWindow).toBe(1_000_000)
    const m = await collect(
      ai.stream({ model, systemPrompt: "You are terse.", messages: [userText("Say hi.")], tools: [] }),
    )
    expect(m.stopReason).toBe("end")
    expect(m.usage?.cost).toBeGreaterThan(0)
  },
  TIMEOUT,
)

test.skipIf(noKey)(
  "a model without native tools calls one through the text protocol",
  async () => {
    const m = await collect(
      ai.stream({
        model: ai.model("ds-text/deepseek-flash"),
        systemPrompt: "Use tools when they help.",
        messages: [userText("What is the weather in Paris? Use the tool.")],
        tools: [weather],
      }),
    )
    expect(m.stopReason).toBe("toolUse")
    const call = m.content.find((b) => b.type === "toolCall")
    expect(call).toMatchObject({ name: "get_weather", args: { city: expect.stringMatching(/paris/i) } })
  },
  TIMEOUT,
)

function userText(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }] }
}
