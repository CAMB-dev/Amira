import { expect, test } from "bun:test"
import { anthropicMessages } from "../src/dialects/anthropic.ts"
import { googleGemini } from "../src/dialects/google-gemini.ts"
import { openaiChat } from "../src/dialects/openai-chat.ts"
import { openaiResponses } from "../src/dialects/openai-responses.ts"
import { req, run, sse } from "./dialect-helpers.ts"

const dialects = [openaiChat, openaiResponses, anthropicMessages, googleGemini]
const tools = [
  {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  { name: "list", description: "List files", parameters: { type: "object" } },
]

for (const dialect of dialects) {
  test(`${dialect.id} forbids tool calls without changing the normal system/tools/messages prefix`, async () => {
    const request = req(
      dialect.id,
      {
        systemPrompt: "Stable system instructions",
        tools,
        messages: [
          { role: "user", content: [{ type: "text", text: "Read a file" }] },
          {
            role: "assistant",
            model: { provider: "test", model: "m" },
            content: [{ type: "toolCall", id: "call_1", name: "read", args: { path: "a" } }],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read",
            content: [{ type: "text", text: "File contents" }],
            isError: false,
          },
          { role: "user", content: [{ type: "text", text: "Summarize" }] },
        ],
      },
      { tools: "native", promptCache: true },
    )
    const normal = (await run(dialect, request, () => sse(""))).seen.body
    const kept = (await run(dialect, { ...request, toolChoice: "none" }, () => sse(""))).seen.body
    const expected =
      dialect.id === "google-gemini"
        ? { toolConfig: { functionCallingConfig: { mode: "NONE" } } }
        : { tool_choice: dialect.id === "anthropic-messages" ? { type: "none" } : "none" }
    expect(kept).toEqual({ ...normal, ...expected })
    expect(kept.tools).toHaveLength(dialect.id === "google-gemini" ? 1 : 2)
    expect(normal).not.toHaveProperty("tool_choice")
    expect(normal).not.toHaveProperty("toolConfig")
    if (dialect.id === "anthropic-messages") {
      expect(kept.tools[1].cache_control).toEqual({ type: "ephemeral" })
      expect(kept.system[0].cache_control).toEqual({ type: "ephemeral" })
      expect(kept.messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" })
    }
  })
}

for (const dialect of [openaiResponses, anthropicMessages]) {
  test(`${dialect.id} preserves hosted-search definitions and cache markers when forbidding all calls`, async () => {
    const request = req(
      dialect.id,
      {
        systemPrompt: "Stable system",
        tools,
        messages: [{ role: "user", content: [{ type: "text", text: "Summarize" }] }],
      },
      { tools: "native", promptCache: true, webSearch: true },
    )
    const normal = (await run(dialect, request, () => sse(""))).seen.body
    const kept = (await run(dialect, { ...request, toolChoice: "none" }, () => sse(""))).seen.body
    expect(kept).toEqual({
      ...normal,
      tool_choice: dialect.id === "anthropic-messages" ? { type: "none" } : "none",
    })
    expect(kept.tools).toHaveLength(3)
  })
}
