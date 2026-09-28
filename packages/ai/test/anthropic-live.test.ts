import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import type { AssistantMessage, Message, ModelRequest, StreamEvent, ToolSpec } from "../src/types.ts"

// Runs against DeepSeek's Anthropic-compatible endpoint when AMIRA_LIVE_DEEPSEEK_KEY is set.
const KEY_ENV = "AMIRA_LIVE_DEEPSEEK_KEY"
const noKey = !process.env[KEY_ENV]
const TIMEOUT = 120_000

const ai = createAi({
  providers: [
    {
      id: "ds-anthropic",
      dialect: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKeyEnv: KEY_ENV,
      compat: { thinking: "budget" },
      models: [{ id: "deepseek-flash", maxOutput: 8_192, caps: { thinking: true } }],
    },
  ],
})

const weather: ToolSpec = {
  name: "get_weather",
  description: "Current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
}

async function run(extra: Partial<ModelRequest>) {
  const evs: StreamEvent[] = []
  const req: ModelRequest = {
    model: ai.model("ds-anthropic/deepseek-flash"),
    systemPrompt: "You are terse.",
    messages: [],
    tools: [],
    maxTokens: 2_048,
    ...extra,
  }
  for await (const e of ai.stream(req)) evs.push(e)
  const end = evs.at(-1)!
  if (end.type === "error") throw new Error(`stream failed: ${JSON.stringify(end.error)}`)
  expect(end.type).toBe("done")
  return { evs, message: (end as Extract<StreamEvent, { type: "done" }>).message }
}

const textOf = (m: AssistantMessage) =>
  m.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")

test.skipIf(noKey)(
  "streams a plain reply",
  async () => {
    const { evs, message } = await run({
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with the word: pong" }] }],
    })
    expect(evs[0]!.type).toBe("start")
    expect(evs.some((e) => e.type === "text.delta")).toBe(true)
    expect(textOf(message).toLowerCase()).toContain("pong")
    expect(message.stopReason).toBe("end")
    expect(message.usage!.input + message.usage!.cacheRead).toBeGreaterThan(0)
    expect(message.usage!.output).toBeGreaterThan(0)
  },
  TIMEOUT,
)

test.skipIf(noKey)(
  "completes a tool-use round trip",
  async () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "What is the weather in Paris? Use the tool." }] },
    ]
    const first = await run({ messages: history, tools: [weather] })
    expect(first.message.stopReason).toBe("toolUse")
    const call = first.message.content.find((b) => b.type === "toolCall")
    expect(call?.type === "toolCall" && call.name).toBe("get_weather")
    if (call?.type !== "toolCall") return
    expect(String(call.args.city).toLowerCase()).toContain("paris")
    const deltas = first.evs.filter((e) => e.type === "toolCall.delta")
    expect(deltas.every((d) => d.type === "toolCall.delta" && d.index === 0)).toBe(true)

    history.push(first.message, {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      isError: false,
      content: [{ type: "text", text: "Sunny, 23 degrees Celsius." }],
    })
    const second = await run({ messages: history, tools: [weather] })
    expect(second.message.stopReason).toBe("end")
    expect(textOf(second.message)).toContain("23")
  },
  TIMEOUT,
)

test.skipIf(noKey)(
  "continues a tool loop whose call came from another provider",
  async () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "What is the weather in Paris? Use the tool." }] },
      {
        role: "assistant",
        model: { provider: "other", model: "x" },
        content: [
          { type: "thinking", text: "I should call the tool." },
          { type: "toolCall", id: "call_1", name: "get_weather", args: { city: "Paris" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "get_weather",
        isError: false,
        content: [{ type: "text", text: "Sunny, 23 degrees Celsius." }],
      },
    ]
    const { message } = await run({ messages: history, tools: [weather], reasoning: { effort: "low" } })
    expect(textOf(message)).toContain("23")
  },
  TIMEOUT,
)

test.skipIf(noKey)(
  "thinks with a signature and accepts it back",
  async () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "What is 17 * 23? Answer with the number." }] },
    ]
    const first = await run({ messages: history, reasoning: { effort: "low" } })
    const thinking = first.message.content.find((b) => b.type === "thinking")
    if (!thinking) {
      console.warn("the endpoint returned no thinking; skipping the thinking checks")
      return
    }
    expect(first.evs.some((e) => e.type === "thinking.delta")).toBe(true)
    expect(thinking.type === "thinking" && thinking.signature?.dialect).toBe("anthropic-messages")
    expect(textOf(first.message)).toContain("391")

    history.push(first.message, { role: "user", content: [{ type: "text", text: "Now add 9." }] })
    const second = await run({ messages: history, reasoning: { effort: "low" } })
    expect(textOf(second.message)).toContain("400")
  },
  TIMEOUT,
)
