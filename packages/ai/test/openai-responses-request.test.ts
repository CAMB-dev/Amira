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
    { type: "function", name: "read", description: "Read a file", parameters },
  ])
})

test("asks for reasoning with encrypted content and maps max to high", async () => {
  expect((await sent({ reasoning: { effort: "low" } })).body.reasoning).toEqual({
    effort: "low",
    summary: "auto",
  })
  const seen = await sent({ reasoning: { effort: "max" } })
  expect(seen.body.reasoning).toEqual({ effort: "high", summary: "auto" })
  expect(seen.body.include).toEqual(["reasoning.encrypted_content"])
  expect((await sent({})).body.include).toBeUndefined()
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
        { type: "text", text: "Reading" },
        { type: "text", text: " it." },
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
    { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "enc" },
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "Reading" },
        { type: "output_text", text: " it." },
      ],
    },
    { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
    { type: "function_call_output", call_id: "call_1", output: "file a" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
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
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "<thinking>\ntheirs\n</thinking>" },
        { type: "output_text", text: "<thinking>\nunsigned\n</thinking>" },
        { type: "output_text", text: "hi" },
      ],
    },
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
