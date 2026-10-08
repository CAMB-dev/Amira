import { expect, test } from "bun:test"
import type { AssistantMessage } from "@amira/api"
import { replySpeed } from "../src/format.ts"

const response = (output: number, reasoning?: number): AssistantMessage => ({
  role: "assistant",
  model: { provider: "anthropic", model: "claude-sonnet-5-5" },
  content: [
    { type: "thinking", text: "summary" },
    { type: "text", text: "answer" },
  ],
  usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, ...(reasoning !== undefined ? { reasoning } : {}) },
})

test("measured omitted thinking uses block timing and total output", () => {
  const timing = {
    start: 0,
    first: 760,
    last: 6020,
    reply: 1930,
    thinkingDisplay: "omitted" as const,
    thinkingBlocks: [{ start: 760, end: 1930 }],
  }
  expect(replySpeed(response(856, 195), timing, 6020)).toBe(
    "output 163 tok/s · TTFT 0.76s · reply 162 tok/s · thinking 167 tok/s",
  )
})

test("measured summarized thinking has comparable output speed and no misleading split", () => {
  const timing = {
    start: 0,
    first: 1380,
    last: 6530,
    thinking: 5060,
    reply: 5070,
    thinkingDisplay: "summarized" as const,
    thinkingBlocks: [{ start: 1380, end: 5070 }],
  }
  expect(replySpeed(response(848, 194), timing, 6530)).toBe(
    "output 165 tok/s · TTFT 1.38s · summarized thinking; no split",
  )
})
