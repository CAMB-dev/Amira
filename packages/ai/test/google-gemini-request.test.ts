// Request shapes follow the Gemini API reference:
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
// https://ai.google.dev/api/caching#Content (Content, Part, FunctionCall, FunctionResponse)
// https://ai.google.dev/gemini-api/docs/function-calling
// https://ai.google.dev/gemini-api/docs/thinking (thinkingConfig, thought signatures)
import { expect, test } from "bun:test"
import { googleGemini } from "../src/dialects/google-gemini.ts"
import { toGeminiSchema } from "../src/dialects/google-gemini-schema.ts"
import type { Message, ModelRequest } from "../src/types.ts"
import { dataSSE, req, run, sse } from "./dialect-helpers.ts"

const model = { provider: "test", model: "m" }
const stop = dataSSE([
  { candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }] },
])

async function sent(extra: Partial<ModelRequest>, caps = {}) {
  const { seen } = await run(googleGemini, req("google-gemini", extra, caps), () => sse(stop))
  return seen
}

test("posts to streamGenerateContent with alt=sse and the key in x-goog-api-key", async () => {
  const seen = await sent({ systemPrompt: "be brief", maxTokens: 500, temperature: 0.3 })
  expect(seen.url).toBe("http://test/v1/models/m:streamGenerateContent?alt=sse")
  expect(seen.headers["x-goog-api-key"]).toBe("k")
  expect(seen.headers.authorization).toBeUndefined()
  expect(seen.body).toEqual({
    contents: [],
    systemInstruction: { parts: [{ text: "be brief" }] },
    generationConfig: { maxOutputTokens: 500, temperature: 0.3 },
  })
})

test("asks for thoughts with a budget per effort", async () => {
  const config = async (effort: "low" | "medium" | "high" | "max") =>
    (await sent({ reasoning: { effort } })).body.generationConfig.thinkingConfig
  expect(await config("low")).toEqual({ thinkingBudget: 1024, includeThoughts: true })
  expect(await config("medium")).toEqual({ thinkingBudget: 8192, includeThoughts: true })
  expect(await config("high")).toEqual({ thinkingBudget: 24576, includeThoughts: true })
  expect(await config("max")).toEqual({ thinkingBudget: 32768, includeThoughts: true })
})

test("sends tools as function declarations with a cleaned schema", async () => {
  const parameters = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string", description: "file" } },
    required: ["path"],
  }
  const seen = await sent({
    tools: [
      { name: "read", description: "Read a file", parameters },
      { name: "now", description: "Time", parameters: { type: "object", properties: {} } },
    ],
  })
  expect(seen.body.tools).toEqual([
    {
      functionDeclarations: [
        {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "file" } },
            required: ["path"],
          },
        },
        { name: "now", description: "Time" },
      ],
    },
  ])
})

test("strips unsupported schema keys recursively", () => {
  expect(
    toGeminiSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: ["string", "null"], $comment: "a property named type" },
        tags: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: { k: { const: "x" } },
            required: ["k"],
          },
        },
        n: {
          anyOf: [
            { type: "integer", exclusiveMinimum: 0 },
            { type: "string", enum: ["a"] },
          ],
        },
        mode: { type: "integer", enum: [1, 2] },
      },
      required: ["type", "missing"],
      $defs: { x: {} },
    }),
  ).toEqual({
    type: "object",
    properties: {
      type: { type: "string", nullable: true },
      tags: { type: "array", items: { type: "object", properties: { k: { enum: ["x"] } }, required: ["k"] } },
      n: { anyOf: [{ type: "integer" }, { type: "string", enum: ["a"] }] },
      mode: { type: "integer" },
    },
    required: ["type"],
  })
})

test("translates every block type into contents", async () => {
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
        { type: "thinking", text: "plan", signature: { dialect: "google-gemini", value: "sigT" } },
        { type: "text", text: "Reading." },
        { type: "toolCall", id: "gemini_call_x_0", name: "read", args: { path: "a" } },
        {
          type: "thinking",
          text: "",
          redacted: true,
          signature: { dialect: "google-gemini", value: "sigC" },
        },
        { type: "toolCall", id: "gemini_call_x_1", name: "read", args: { path: "b" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "gemini_call_x_1",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "no b" }],
    },
    {
      role: "toolResult",
      toolCallId: "gemini_call_x_0",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "file a" }],
    },
    { role: "assistant", model, content: [{ type: "text", text: "Done." }] },
  ]
  const { body } = await sent({ messages })
  expect(body.contents).toEqual([
    { role: "user", parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: "AAA" } }] },
    {
      role: "model",
      parts: [
        { text: "plan", thought: true, thoughtSignature: "sigT" },
        { text: "Reading." },
        { functionCall: { name: "read", args: { path: "a" } }, thoughtSignature: "sigC" },
        { functionCall: { name: "read", args: { path: "b" } } },
      ],
    },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "read", response: { output: "file a" } } },
        { functionResponse: { name: "read", response: { error: "no b" } } },
      ],
    },
    { role: "model", parts: [{ text: "Done." }] },
  ])
})

test("keeps real call ids, answers missing results and drops stray ones", async () => {
  const messages: Message[] = [
    { role: "assistant", model, content: [{ type: "toolCall", id: "abc", name: "r", args: {} }] },
    { role: "toolResult", toolCallId: "stray", toolName: "r", isError: false, content: [] },
  ]
  const { body } = await sent({ messages })
  expect(body.contents).toEqual([
    { role: "model", parts: [{ functionCall: { id: "abc", name: "r", args: {} } }] },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "abc",
            name: "r",
            response: { error: "[no result: the call did not complete]" },
          },
        },
      ],
    },
  ])
})

test("turns foreign thinking into text and places a lone signature on an empty part", async () => {
  const messages: Message[] = [
    {
      role: "assistant",
      model,
      content: [
        { type: "thinking", text: "", redacted: true, signature: { dialect: "google-gemini", value: "s0" } },
        { type: "thinking", text: "theirs", signature: { dialect: "openai-responses", value: "x" } },
        {
          type: "thinking",
          text: "",
          redacted: true,
          signature: { dialect: "anthropic-messages", value: "y" },
        },
      ],
    },
  ]
  const { body } = await sent({ messages })
  expect(body.contents).toEqual([
    {
      role: "model",
      parts: [{ text: "", thoughtSignature: "s0" }, { text: "<thinking>\ntheirs\n</thinking>" }],
    },
  ])
})

test("sends tool-result images after the responses when the model takes images", async () => {
  const messages: Message[] = [
    {
      role: "assistant",
      model,
      content: [{ type: "toolCall", id: "gemini_call_0", name: "shot", args: {} }],
    },
    {
      role: "toolResult",
      toolCallId: "gemini_call_0",
      toolName: "shot",
      isError: false,
      content: [
        { type: "text", text: "ok" },
        { type: "image", mimeType: "image/png", data: "IMG" },
      ],
    },
  ]
  const withImages = (await sent({ messages }, { images: true })).body.contents[1]
  expect(withImages.parts).toEqual([
    {
      functionResponse: {
        name: "shot",
        response: { output: "ok\n[image: image/png, sent after the responses]" },
      },
    },
    { text: "Images from the shot result:" },
    { inlineData: { mimeType: "image/png", data: "IMG" } },
  ])
  const without = (await sent({ messages })).body.contents[1]
  expect(without.parts).toEqual([
    { functionResponse: { name: "shot", response: { output: "ok\n[image: image/png]" } } },
  ])
})
