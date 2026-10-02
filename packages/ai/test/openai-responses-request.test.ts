// Request shapes follow the Responses API reference:
// https://platform.openai.com/docs/api-reference/responses/create
// https://platform.openai.com/docs/guides/reasoning#encrypted-reasoning-items
import { expect, test } from "bun:test"
import { openaiResponses } from "../src/dialects/openai-responses.ts"
import type { Message, ModelRequest } from "../src/types.ts"
import { namedSSE, req, run, sse } from "./dialect-helpers.ts"

const model = { provider: "test", model: "m" }
const completed = namedSSE([{ type: "response.completed", response: { status: "completed" } } as any])

async function sent(extra: Partial<ModelRequest>, caps = {}) {
  const { seen } = await run(openaiResponses, req("openai-responses", extra, caps), () => sse(completed))
  return seen
}

test("posts to /responses with a bearer key, stateless and streaming", async () => {
  const seen = await sent({ systemPrompt: "be brief", maxTokens: 500, temperature: 0.2 })
  expect(seen.url).toBe("http://test/v1/responses")
  expect(seen.headers.authorization).toBe("Bearer k")
  expect(seen.body).toEqual({
    model: "m",
    input: [],
    stream: true,
    store: false,
    instructions: "be brief",
    max_output_tokens: 500,
    temperature: 0.2,
  })
})

test("sends tools as flat function definitions", async () => {
  const parameters = { type: "object", properties: { path: { type: "string" } } }
  const seen = await sent({ tools: [{ name: "read", description: "Read a file", parameters }] })
  expect(seen.body.tools).toEqual([
    { type: "function", name: "read", description: "Read a file", parameters, strict: false },
  ])
})

test.each(["low", "medium", "high", "xhigh", "max"] as const)(
  "passes through reasoning effort %s with encrypted content",
  async (effort) => {
    const { body } = await sent({ reasoning: { effort } })
    expect(body.reasoning).toEqual({ effort, summary: "auto" })
    expect(body.include).toEqual(["reasoning.encrypted_content"])
  },
)

test("omits reasoning and its include when no effort is set", async () => {
  const { body } = await sent({})
  expect(body).not.toHaveProperty("reasoning")
  expect(body).not.toHaveProperty("include")
})

test("translates every block type into input items", async () => {
  const messages: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", mimeType: "image/png", data: "AAA" },
      ],
    },
    {
      role: "assistant",
      model,
      content: [
        {
          type: "thinking",
          text: "plan",
          signature: {
            dialect: "openai-responses",
            value: JSON.stringify({ id: "rs_1", encrypted_content: "enc" }),
          },
        },
        {
          type: "text",
          text: "Reading",
          signature: { dialect: "openai-responses", value: '{"id":"msg_1"}' },
        },
        {
          type: "text",
          text: " it.",
          signature: { dialect: "openai-responses", value: '{"id":"msg_2","phase":"commentary"}' },
        },
        { type: "toolCall", id: "call_1", name: "read", args: { path: "a" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "file a" }],
    },
    { role: "assistant", model, content: [{ type: "text", text: "Done." }] },
  ]
  const { body } = await sent({ messages })
  expect(body.input).toEqual([
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "data:image/png;base64,AAA", detail: "auto" },
      ],
    },
    {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "plan" }],
      encrypted_content: "enc",
    },
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Reading", annotations: [] }],
    },
    {
      type: "message",
      id: "msg_2",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: " it.", annotations: [] }],
      phase: "commentary",
    },
    { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
    { type: "function_call_output", call_id: "call_1", output: "file a" },
    { role: "assistant", content: "Done." },
  ])
})

test("drops reasoning that is not followed by output in its turn", async () => {
  const signed = (id: string) => ({
    type: "thinking" as const,
    text: "",
    redacted: true,
    signature: { dialect: "openai-responses", value: JSON.stringify({ id, encrypted_content: id }) },
  })
  const messages: Message[] = [
    { role: "assistant", model, content: [signed("rs_1"), { type: "text", text: "a" }, signed("rs_2")] },
    { role: "assistant", model, content: [signed("rs_3")] },
  ]
  const { body } = await sent({ messages })
  expect(body.input).toEqual([
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "rs_1" },
    { role: "assistant", content: "a" },
  ])
})

test("replays redacted reasoning and turns foreign thinking into text", async () => {
  const messages: Message[] = [
    {
      role: "assistant",
      model,
      content: [
        {
          type: "thinking",
          text: "",
          redacted: true,
          signature: { dialect: "openai-responses", value: "raw" },
        },
        { type: "thinking", text: "theirs", signature: { dialect: "anthropic-messages", value: "s" } },
        { type: "thinking", text: "unsigned" },
        { type: "text", text: "hi" },
      ],
    },
  ]
  const { body } = await sent({ messages })
  expect(body.input).toEqual([
    { type: "reasoning", summary: [], encrypted_content: "raw" },
    { role: "assistant", content: "<thinking>\ntheirs\n</thinking><thinking>\nunsigned\n</thinking>hi" },
  ])
})

test("answers every call right after the turn: reordered, missing and stray results", async () => {
  const messages: Message[] = [
    {
      role: "assistant",
      model,
      content: [
        { type: "toolCall", id: "a", name: "r", args: {} },
        { type: "toolCall", id: "b", name: "r", args: {} },
      ],
    },
    { role: "toolResult", toolCallId: "stray", toolName: "r", isError: false, content: [] },
    {
      role: "toolResult",
      toolCallId: "b",
      toolName: "r",
      isError: false,
      content: [{ type: "text", text: "B" }],
    },
    { role: "user", content: [{ type: "text", text: "go on" }] },
  ]
  const { body } = await sent({ messages })
  expect(body.input.map((i: any) => [i.type, i.call_id ?? i.role, i.output])).toEqual([
    ["function_call", "a", undefined],
    ["function_call", "b", undefined],
    ["function_call_output", "a", "[no result: the call did not complete]"],
    ["function_call_output", "b", "B"],
    ["message", "user", undefined],
  ])
})

test("sends tool-result images in a following user message when the model takes images", async () => {
  const messages: Message[] = [
    { role: "assistant", model, content: [{ type: "toolCall", id: "a", name: "shot", args: {} }] },
    {
      role: "toolResult",
      toolCallId: "a",
      toolName: "shot",
      isError: false,
      content: [
        { type: "text", text: "ok" },
        { type: "image", mimeType: "image/png", data: "IMG" },
      ],
    },
  ]
  const withImages = (await sent({ messages }, { images: true })).body.input
  expect(withImages.slice(1)).toEqual([
    {
      type: "function_call_output",
      call_id: "a",
      output: "ok\n[image: image/png, sent in the next message]",
    },
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Images from the shot result (a):" },
        { type: "input_image", image_url: "data:image/png;base64,IMG", detail: "auto" },
      ],
    },
  ])
  const without = (await sent({ messages })).body.input
  expect(without.slice(1)).toEqual([
    { type: "function_call_output", call_id: "a", output: "ok\n[image: image/png]" },
  ])
})
