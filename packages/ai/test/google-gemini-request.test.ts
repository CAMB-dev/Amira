// Request shapes follow the Gemini API reference:
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
// https://ai.google.dev/api/caching#Content (Content, Part, FunctionCall, FunctionResponse)
// https://ai.google.dev/gemini-api/docs/function-calling
// https://ai.google.dev/gemini-api/docs/thinking (thinkingConfig, thought signatures)
import { expect, test } from "bun:test"
import { googleGemini, thinkingConfig } from "../src/dialects/google-gemini.ts"
import { toGeminiSchema } from "../src/dialects/google-gemini-schema.ts"
import type { Message, ModelRequest, ReasoningEffort } from "../src/types.ts"
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
  const config = async (effort: ReasoningEffort) =>
    (await sent({ reasoning: { effort } })).body.generationConfig.thinkingConfig
  expect(await config("low")).toEqual({ thinkingBudget: 1024, includeThoughts: true })
  expect(await config("medium")).toEqual({ thinkingBudget: 8192, includeThoughts: true })
  expect(await config("high")).toEqual({ thinkingBudget: 24576, includeThoughts: true })
  expect(await config("xhigh")).toEqual({ thinkingBudget: 24576, includeThoughts: true })
  expect(await config("max")).toEqual({ thinkingBudget: 24576, includeThoughts: true })
})

test("only 2.5 Pro gets the larger max budget; Gemini 3 gets a thinking level instead", () => {
  expect(thinkingConfig("gemini-2.5-pro", "max")).toEqual({ thinkingBudget: 32768, includeThoughts: true })
  expect(thinkingConfig("gemini-2.5-flash-lite", "max")).toEqual({
    thinkingBudget: 24576,
    includeThoughts: true,
  })
  expect(thinkingConfig("gemini-3-pro-preview", "low")).toEqual({
    thinkingLevel: "LOW",
    includeThoughts: true,
  })
  expect(thinkingConfig("gemini-3.1-flash", "medium")).toEqual({
    thinkingLevel: "MEDIUM",
    includeThoughts: true,
  })
  expect(thinkingConfig("models/gemini-3-pro", "high")).toEqual({
    thinkingLevel: "HIGH",
    includeThoughts: true,
  })
  expect(thinkingConfig("gemini-3-pro", "max")).toEqual({ thinkingLevel: "HIGH", includeThoughts: true })
})

test.each([
  ["low", "LOW", 1024],
  ["medium", "MEDIUM", 8192],
  ["high", "HIGH", 24576],
  ["xhigh", "HIGH", 24576],
  ["max", "HIGH", 32768],
] as const)("sends %s for Gemini 3 and preserves Gemini 2.5 Pro budgets", async (effort, level, budget) => {
  for (const id of ["gemini-3-pro", "gemini-2.5-pro"]) {
    const model = { ...req("google-gemini").model, id }
    const { body } = await sent({ model, reasoning: { effort } })
    expect(body.generationConfig.thinkingConfig).toEqual({
      ...(id === "gemini-3-pro" ? { thinkingLevel: level } : { thinkingBudget: budget }),
      includeThoughts: true,
    })
  }
  expect((await sent({})).body).not.toHaveProperty("generationConfig")
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

test("inlines local refs, stops at recursion, and turns oneOf and allOf into what Gemini takes", () => {
  expect(
    toGeminiSchema({
      type: "object",
      $defs: {
        Point: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        Tree: { type: "object", properties: { child: { $ref: "#/$defs/Tree" }, name: { type: "string" } } },
      },
      properties: {
        at: { $ref: "#/$defs/Point", description: "where" },
        tree: { $ref: "#/$defs/Tree" },
        remote: { $ref: "https://example.com/schema.json" },
        shape: { oneOf: [{ type: "string" }, { $ref: "#/definitions/Missing" }] },
        both: {
          allOf: [
            { $ref: "#/$defs/Point" },
            { type: "object", properties: { y: { type: "number" } }, required: ["y"] },
          ],
          description: "x and y",
        },
      },
    }),
  ).toEqual({
    type: "object",
    properties: {
      at: { type: "object", properties: { x: { type: "number" } }, required: ["x"], description: "where" },
      tree: {
        type: "object",
        properties: { child: { type: "object" }, name: { type: "string" } },
      },
      remote: { type: "object" },
      shape: { anyOf: [{ type: "string" }, { type: "object" }] },
      both: {
        description: "x and y",
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      },
    },
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

test("marks the first unsigned call of a step with the skip signature, as Gemini 3 requires", async () => {
  const messages: Message[] = [
    {
      role: "assistant",
      model,
      content: [
        { type: "text", text: "Two reads." },
        { type: "toolCall", id: "call_a", name: "read", args: {} },
        { type: "toolCall", id: "call_b", name: "read", args: {} },
      ],
    },
  ]
  const { body } = await sent({ messages })
  expect(body.contents[0].parts).toEqual([
    { text: "Two reads." },
    {
      functionCall: { id: "call_a", name: "read", args: {} },
      thoughtSignature: "skip_thought_signature_validator",
    },
    { functionCall: { id: "call_b", name: "read", args: {} } },
  ])
})

test("keeps real call ids, answers missing results and drops stray ones", async () => {
  const messages: Message[] = [
    { role: "assistant", model, content: [{ type: "toolCall", id: "abc", name: "r", args: {} }] },
    { role: "toolResult", toolCallId: "stray", toolName: "r", isError: false, content: [] },
  ]
  const { body } = await sent({ messages })
  expect(body.contents).toEqual([
    {
      role: "model",
      parts: [
        {
          functionCall: { id: "abc", name: "r", args: {} },
          thoughtSignature: "skip_thought_signature_validator",
        },
      ],
    },
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

// Multimodal function responses: https://ai.google.dev/gemini-api/docs/function-calling#multimodal
test("nests tool-result images in the function response when the model takes images", async () => {
  const messages: Message[] = [
    {
      role: "assistant",
      model,
      content: [
        { type: "toolCall", id: "gemini_call_0", name: "shot", args: {} },
        { type: "toolCall", id: "gemini_call_1", name: "shot", args: {} },
      ],
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
    {
      role: "toolResult",
      toolCallId: "gemini_call_1",
      toolName: "shot",
      isError: false,
      content: [{ type: "image", mimeType: "image/jpeg", data: "JPG" }],
    },
  ]
  const withImages = (await sent({ messages }, { images: true })).body.contents[1]
  expect(withImages.parts).toEqual([
    {
      functionResponse: {
        name: "shot",
        response: { output: "ok\n[image: image/png, attached]", image_1: { $ref: "image_1" } },
        parts: [{ inlineData: { mimeType: "image/png", data: "IMG", displayName: "image_1" } }],
      },
    },
    {
      functionResponse: {
        name: "shot",
        response: { output: "[image: image/jpeg, attached]", image_2: { $ref: "image_2" } },
        parts: [{ inlineData: { mimeType: "image/jpeg", data: "JPG", displayName: "image_2" } }],
      },
    },
  ])
  const without = (await sent({ messages })).body.contents[1]
  expect(without.parts).toEqual([
    { functionResponse: { name: "shot", response: { output: "ok\n[image: image/png]" } } },
    { functionResponse: { name: "shot", response: { output: "[image: image/jpeg]" } } },
  ])
})
