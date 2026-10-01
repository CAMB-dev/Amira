import { expect, test } from "bun:test"
import type { AssistantMessage } from "@amira/api"
import { replySpeed } from "../src/format.ts"

const message = (reasoning?: number, thinking = false): AssistantMessage => ({
  role: "assistant",
  model: { provider: "mock", model: "m" },
  content: [
    ...(thinking ? [{ type: "thinking" as const, text: "x".repeat(320) }] : []),
    { type: "text", text: "x".repeat(80) },
  ],
  usage: {
    input: 0,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    ...(reasoning !== undefined ? { reasoning } : {}),
  },
})

test("streamed thinking and text use separate counts and durations", () => {
  expect(replySpeed(message(80, true), { start: 0, thinking: 1000, reply: 5000 }, 6000, 5000)).toBe(
    "reply 20 tok/s · thinking 20 tok/s",
  )
})

test("streamed thinking without a count uses marked estimates for both phases", () => {
  expect(replySpeed(message(undefined, true), { start: 0, thinking: 1000, reply: 5000 }, 6000, 5000)).toBe(
    "reply ~20 tok/s · thinking ~20 tok/s",
  )
})

test("hidden reasoning with a count is excluded from reply speed", () => {
  expect(replySpeed(message(80), { start: 0, reply: 5000 }, 6000, 5000)).toBe(
    "reply 20 tok/s (hidden reasoning)",
  )
})

test("a long silent gap without a count uses a text estimate", () => {
  expect(replySpeed(message(), { start: 0, reply: 5000 }, 6000, 5000)).toBe(
    "reply ~20 tok/s (hidden reasoning)",
  )
})

test("redacted thinking without a count or a delta uses a text estimate", () => {
  const encrypted = message()
  encrypted.content.unshift({ type: "thinking", text: "", redacted: true })
  expect(replySpeed(encrypted, { start: 0, reply: 100 }, 1100)).toBe("reply ~20 tok/s (hidden reasoning)")
})

test("no thinking uses output tokens; a reported zero rules out the gap heuristic", () => {
  expect(replySpeed(message(), { start: 0, reply: 100 }, 1100, 5000)).toBe("reply 100 tok/s")
  expect(replySpeed(message(0), { start: 0, reply: 5000 }, 6000, 5000)).toBe("reply 100 tok/s")
})

test("very short replies and missing text are not assigned a reply speed", () => {
  expect(replySpeed(message(80), { start: 0, reply: 5000 }, 5100, 5000)).toBeUndefined()
  expect(replySpeed(message(80, true), { start: 0, thinking: 1000 }, 5000, 5000)).toBe("thinking 20 tok/s")
  expect(replySpeed(message(), { start: 0 }, 5000, 5000)).toBeUndefined()
})

test("a signed thinking block with no text and no count is hidden reasoning", () => {
  const omitted = message()
  omitted.content.unshift({ type: "thinking", text: "", signature: { dialect: "anthropic", value: "sig" } })
  expect(replySpeed(omitted, { start: 0, reply: 100 }, 1100)).toBe("reply ~20 tok/s (hidden reasoning)")
})

test("a streamed summary far shorter than the reported reasoning times thinking from the request", () => {
  const summarized = message(80)
  summarized.content.unshift({ type: "thinking", text: "x".repeat(40) })
  expect(replySpeed(summarized, { start: 0, thinking: 3000, reply: 4000 }, 5000)).toBe(
    "reply 20 tok/s · thinking ~20 tok/s",
  )
})

test("tool-call arguments count as the reply", () => {
  const call: AssistantMessage = {
    role: "assistant",
    model: { provider: "mock", model: "m" },
    content: [{ type: "toolCall", id: "t", name: "read", args: { path: "x".repeat(72) } }],
    usage: { input: 0, output: 50, cacheRead: 0, cacheWrite: 0 },
  }
  expect(replySpeed(call, { start: 0, reply: 500 }, 1000)).toBe("reply 100 tok/s")
  expect(
    replySpeed(
      { ...call, usage: { input: 0, output: 50, reasoning: 30, cacheRead: 0, cacheWrite: 0 } },
      { start: 0, reply: 500 },
      1000,
    ),
  ).toBe("reply 40 tok/s (hidden reasoning)")
  const thought = {
    ...call,
    content: [{ type: "thinking" as const, text: "x".repeat(400) }, ...call.content],
  }
  expect(replySpeed(thought, { start: 0, thinking: 100, reply: 500 }, 1000)).toBe(
    "reply ~44 tok/s · thinking ~250 tok/s",
  )
})
