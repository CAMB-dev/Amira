import { expect, test } from "bun:test"
import { collect } from "../src/dialect.ts"
import { messagesUrl } from "../src/dialects/anthropic.ts"
import type { AnthropicMessage } from "../src/dialects/anthropic-messages.ts"
import { unsignedToolLoop } from "../src/dialects/anthropic-request.ts"
import type { ProviderConfig } from "../src/providers.ts"
import type { Message, ModelRequest } from "../src/types.ts"
import { anthropicAi, anthropicRequest, anthropicResponse, textReply } from "./anthropic-helpers.ts"
import { fakeFetch, type Seen } from "./helpers.ts"

async function sent(extra: Partial<ModelRequest> = {}, provider: Partial<ProviderConfig> = {}) {
  const seen: Seen = {}
  const ai = anthropicAi(fakeFetch(() => anthropicResponse(textReply("ok")), seen))
  const p = ai.providers().find((x) => x.id === "anth")!
  ai.registerProvider({ ...p, ...provider })
  await collect(ai.stream(anthropicRequest(ai, extra)))
  return seen
}

const budgetMode: Partial<ProviderConfig> = { compat: { thinking: "budget" } }

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
  const seen = await sent({}, { headers: { "anthropic-beta": "x", "anthropic-version": "2099-01-01" } })
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

test("adaptive mode, the default, sends an effort and never a budget, disabled or temperature", async () => {
  for (const effort of ["low", "medium", "high", "max"] as const) {
    const { body } = await sent({ reasoning: { effort }, temperature: 0.2 })
    expect(body.thinking).toEqual({ type: "adaptive" })
    expect(body.output_config).toEqual({ effort })
    expect(body.temperature).toBeUndefined()
  }
  const plain = (await sent({ temperature: 0.2 })).body
  expect(plain.thinking).toBeUndefined()
  expect(plain.output_config).toBeUndefined()
  expect(plain.temperature).toBeUndefined()
  const reasoning = { effort: "low" as const }
  const loop = (await sent({ reasoning, messages: toolTurn(false), tools: [tool("read")] })).body
  expect(loop.thinking).toEqual({ type: "adaptive" })
})

test("budget mode maps effort to a thinking budget below max_tokens and drops temperature", async () => {
  const budget = async (extra: Partial<ModelRequest>) =>
    (await sent(extra, budgetMode)).body.thinking?.budget_tokens
  expect(await budget({ reasoning: { effort: "low" } })).toBe(2_048)
  expect(await budget({ reasoning: { effort: "medium" } })).toBe(8_192)
  expect(await budget({ reasoning: { effort: "high" } })).toBe(24_576)
  expect(await budget({ reasoning: { effort: "max" } })).toBe(32_000 - 1_024)
  expect(await budget({ reasoning: { effort: "high" }, maxTokens: 4_000 })).toBe(4_000 - 1_024)
  expect(await budget({ reasoning: { effort: "high" }, maxTokens: 1_500 })).toBeUndefined()
  expect(await budget({})).toBeUndefined()
  const withThinking = await sent({ reasoning: { effort: "low" }, temperature: 0.2 }, budgetMode)
  expect(withThinking.body.thinking).toEqual({ type: "enabled", budget_tokens: 2_048 })
  expect(withThinking.body.output_config).toBeUndefined()
  expect(withThinking.body.temperature).toBeUndefined()
  expect((await sent({ temperature: 0.2 }, budgetMode)).body.temperature).toBe(0.2)
})

test("sends no thinking when the model lacks the capability", async () => {
  const seen: Seen = {}
  const ai = anthropicAi(fakeFetch(() => anthropicResponse(textReply("ok")), seen))
  const req = anthropicRequest(ai, { reasoning: { effort: "high" } })
  req.model = { ...req.model, caps: { ...req.model.caps, thinking: false } }
  await collect(ai.stream(req))
  expect(seen.body.thinking).toBeUndefined()
})

test("budget mode turns thinking off mid tool loop when the loop has no signed thinking", async () => {
  const reasoning = { effort: "low" as const }
  const off = { type: "disabled" }
  const thinkingOf = async (extra: Partial<ModelRequest>) => (await sent(extra, budgetMode)).body.thinking
  expect(await thinkingOf({ reasoning, messages: toolTurn(false), tools: [tool("read")] })).toEqual(off)
  expect(await thinkingOf({ messages: toolTurn(false), tools: [tool("read")] })).toBeUndefined()
  expect(await thinkingOf({ reasoning, messages: toolTurn(true), tools: [tool("read")] })).toEqual({
    type: "enabled",
    budget_tokens: 2_048,
  })
  expect(await thinkingOf({ messages: toolTurn(true), tools: [tool("read")] })).toBeUndefined()
})

test("the tool-loop check looks at the loop's first assistant turn", () => {
  const signed = { type: "thinking" as const, thinking: "t", signature: "s" }
  const use = (id: string) => ({ type: "tool_use" as const, id, name: "r", input: {} })
  const res = (id: string) => ({ type: "tool_result" as const, tool_use_id: id })
  const text = { type: "text" as const, text: "q" }
  const loop = (first: AnthropicMessage["content"]): AnthropicMessage[] => [
    { role: "user", content: [text] },
    { role: "assistant", content: first },
    { role: "user", content: [res("a")] },
    { role: "assistant", content: [use("b")] },
    { role: "user", content: [res("b")] },
  ]
  expect(unsignedToolLoop(loop([signed, use("a")]))).toBe(false)
  expect(unsignedToolLoop(loop([use("a")]))).toBe(true)
  expect(unsignedToolLoop(loop([use("a")]).slice(0, 4))).toBe(false)
  const newTurn = loop([use("a")])
  newTurn[2] = { role: "user", content: [res("a"), text] }
  newTurn[3] = { role: "assistant", content: [signed, use("b")] }
  expect(unsignedToolLoop(newTurn)).toBe(false)
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

test("places no breakpoints when the model does not support prompt caching", async () => {
  const noCache: Partial<ProviderConfig> = {
    models: [{ id: "claude", maxOutput: 32_000, caps: { promptCache: false } }],
  }
  const req = { systemPrompt: "sys", tools: [tool("a")], messages: history }
  expect(breakpoints((await sent(req, noCache)).body)).toBe(0)
})

test("caches the tool results of an agent loop", async () => {
  const { body } = await sent({ messages: toolTurn(false), tools: [tool("read")] })
  expect(body.messages[2].content.at(-1)).toEqual({
    type: "tool_result",
    tool_use_id: "a",
    cache_control: { type: "ephemeral" },
  })
})
