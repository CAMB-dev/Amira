import { expect, test } from "bun:test"
import { adaptThinking } from "../src/thinking.ts"
import type { Message } from "../src/types.ts"

const history: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
  {
    role: "assistant",
    model: { provider: "anthropic", model: "c" },
    content: [
      { type: "thinking", text: "signed here", signature: { dialect: "anthropic-messages", value: "sig" } },
      {
        type: "thinking",
        text: "",
        redacted: true,
        signature: { dialect: "anthropic-messages", value: "enc" },
      },
      { type: "thinking", text: "unsigned" },
      { type: "text", text: "answer" },
    ],
  },
]

test("keeps thinking signed by the target dialect as is", () => {
  const out = adaptThinking(history, "anthropic-messages")
  const a = out[1]!
  expect(a.role === "assistant" && a.content.map((b) => b.type)).toEqual([
    "thinking",
    "thinking",
    "text",
    "text",
  ])
})

test("turns foreign thinking into tagged text and drops what it cannot read", () => {
  const out = adaptThinking(history, "openai-responses")
  const a = out[1]!
  expect(a.role === "assistant" && a.content).toEqual([
    { type: "text", text: "<thinking>\nsigned here\n</thinking>" },
    { type: "text", text: "<thinking>\nunsigned\n</thinking>" },
    { type: "text", text: "answer" },
  ])
  // The original history is untouched.
  expect(history[1]!.role === "assistant" && history[1]!.content).toHaveLength(4)
  expect(out[0]).toBe(history[0])
})
