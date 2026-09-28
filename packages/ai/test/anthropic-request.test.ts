import { expect, test } from "bun:test"
import { collect } from "../src/dialect.ts"
import { messagesUrl } from "../src/dialects/anthropic.ts"
import type { Message, ModelRequest } from "../src/types.ts"
import { anthropicAi, anthropicRequest, anthropicResponse, textReply } from "./anthropic-helpers.ts"
import { fakeFetch, type Seen } from "./helpers.ts"

async function sent(extra: Partial<ModelRequest> = {}, providerHeaders?: Record<string, string>) {
  const seen: Seen = {}
  const ai = anthropicAi(fakeFetch(() => anthropicResponse(textReply("ok")), seen))
  if (providerHeaders) {
    const p = ai.providers().find((x) => x.id === "anth")!
    ai.registerProvider({ ...p, headers: providerHeaders })
  }
  await collect(ai.stream(anthropicRequest(ai, extra)))
  return seen
}

const tool = (name: string) => ({ name, description: `${name} it`, parameters: { type: "object" } })
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const toolTurn = (thinking: boolean): Message[] => [
  user("q"),
  {
    role: "assistant",
    model: { provider: "anth", model: "claude" },
    content: [
      ...(thinking
        ? [{ type: "thinking" as const, text: "t", signature: { dialect: "anthropic-messages", value: "s" } }]
        : []),
      { type: "toolCall", id: "a", name: "read", args: {} },
    ],
  },
  { role: "toolResult", toolCallId: "a", toolName: "read", isError: false, content: [] },
]

test("posts to /v1/messages with the api key, version and provider headers", async () => {
  const seen = await sent({}, { "anthropic-beta": "x", "anthropic-version": "2099-01-01" })
  expect(seen.url).toBe("http://anth/v1/messages")
  expect(seen.headers).toEqual({
    "content-type": "application/json",
    "anthropic-version": "2099-01-01",
    "x-api-key": "sk-test",
    "anthropic-beta": "x",
  })
  expect(seen.body.stream).toBe(true)
  expect(seen.body.model).toBe("claude")
})

test("builds the URL whether or not the base URL ends in /v1", () => {
  expect(messagesUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages")
  expect(messagesUrl("https://api.anthropic.com/")).toBe("https://api.anthropic.com/v1/messages")
  expect(messagesUrl("https://x/anthropic/v1")).toBe("https://x/anthropic/v1/messages")
})

test("sends the system prompt, tools and max_tokens", async () => {
  const { body } = await sent({ systemPrompt: "be nice", tools: [tool("a"), tool("b")], promptCache: false })
  expect(body.system).toEqual([{ type: "text", text: "be nice" }])
  expect(body.tools).toEqual([
    { name: "a", description: "a it", input_schema: { type: "object" } },
    { name: "b", description: "b it", input_schema: { type: "object" } },
  ])
  expect(body.max_tokens).toBe(32_000)
  expect((await sent({ maxTokens: 500 })).body.max_tokens).toBe(500)
  expect((await sent({ maxTokens: 10_000_000 })).body.max_tokens).toBe(32_000)
})

test("maps reasoning effort to a thinking budget below max_tokens and drops temperature", async () => {
  const budget = async (extra: Partial<ModelRequest>) => (await sent(extra)).body.thinking?.budget_tokens
  expect(await budget({ reasoning: { effort: "low" } })).toBe(2_048)
  expect(await budget({ reasoning: { effort: "medium" } })).toBe(8_192)
  expect(await budget({ reasoning: { effort: "high" } })).toBe(24_576)
  expect(await budget({ reasoning: { effort: "max" } })).toBe(32_000 - 1_024)
  expect(await budget({ reasoning: { effort: "high" }, maxTokens: 4_000 })).toBe(4_000 - 1_024)
  expect(await budget({ reasoning: { effort: "high" }, maxTokens: 1_500 })).toBeUndefined()
  expect(await budget({})).toBeUndefined()
  const withThinking = await sent({ reasoning: { effort: "low" }, temperature: 0.2 })
  expect(withThinking.body.thinking).toEqual({ type: "enabled", budget_tokens: 2_048 })
  expect(withThinking.body.temperature).toBeUndefined()
  expect((await sent({ temperature: 0.2 })).body.temperature).toBe(0.2)
})

test("sends no thinking when the model lacks the capability", async () => {
  const seen: Seen = {}
  const ai = anthropicAi(fakeFetch(() => anthropicResponse(textReply("ok")), seen))
  const req = anthropicRequest(ai, { reasoning: { effort: "high" } })
  req.model = { ...req.model, caps: { ...req.model.caps, thinking: false } }
  await collect(ai.stream(req))
  expect(seen.body.thinking).toBeUndefined()
})

test("skips thinking mid tool loop when the assistant turn has no signed thinking", async () => {
  const reasoning = { effort: "low" as const }
  expect((await sent({ reasoning, messages: toolTurn(false) })).body.thinking).toBeUndefined()
  expect((await sent({ reasoning, messages: toolTurn(true) })).body.thinking).toBeDefined()
})

const history: Message[] = [
  user("one"),
  { role: "assistant", model: { provider: "anth", model: "claude" }, content: [{ type: "text", text: "1" }] },
  user("two"),
  { role: "assistant", model: { provider: "anth", model: "claude" }, content: [{ type: "text", text: "2" }] },
  user("three"),
]

const breakpoints = (body: any): number => JSON.stringify(body).split('"cache_control"').length - 1

test("marks the system prompt, last tool and last two user turns for caching", async () => {
  const { body } = await sent({ systemPrompt: "sys", tools: [tool("a"), tool("b")], messages: history })
  const eph = { type: "ephemeral" }
  expect(body.system[0].cache_control).toEqual(eph)
  expect(body.tools[0].cache_control).toBeUndefined()
  expect(body.tools[1].cache_control).toEqual(eph)
  expect(body.messages[0].content[0].cache_control).toBeUndefined()
  expect(body.messages[2].content[0].cache_control).toEqual(eph)
  expect(body.messages[4].content[0].cache_control).toEqual(eph)
  expect(breakpoints(body)).toBe(4)
})

test("never places more than four breakpoints and none when caching is off", async () => {
  const many = { systemPrompt: "sys", tools: [tool("a")], messages: [...history, ...history.slice(1)] }
  expect(breakpoints((await sent(many)).body)).toBe(4)
  expect(breakpoints((await sent({ messages: history })).body)).toBe(2)
  expect(breakpoints((await sent({ ...many, promptCache: false })).body)).toBe(0)
})

test("caches the tool results of an agent loop", async () => {
  const { body } = await sent({ messages: toolTurn(false) })
  expect(body.messages[2].content.at(-1)).toEqual({
    type: "tool_result",
    tool_use_id: "a",
    cache_control: { type: "ephemeral" },
  })
})
