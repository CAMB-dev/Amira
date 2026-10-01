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
  expect(replySpeed(message(80), { start: 0, thinking: 1000, text: 5000 }, 6000, 5000)).toBe(
    "reply 20 tok/s · thinking 20 tok/s",
  )
})

test("streamed thinking without a count uses marked estimates for both phases", () => {
  expect(replySpeed(message(undefined, true), { start: 0, thinking: 1000, text: 5000 }, 6000, 5000)).toBe(
    "reply ~20 tok/s · thinking ~20 tok/s",
  )
})

test("hidden reasoning with a count is excluded from reply speed", () => {
  expect(replySpeed(message(80), { start: 0, text: 5000 }, 6000, 5000)).toBe(
    "reply 20 tok/s (hidden reasoning)",
  )
})

test("a long silent gap without a count uses a text estimate", () => {
  expect(replySpeed(message(), { start: 0, text: 5000 }, 6000, 5000)).toBe(
    "reply ~20 tok/s (hidden reasoning)",
  )
})

test("redacted thinking without a count or a delta uses a text estimate", () => {
  const encrypted = message()
  encrypted.content.unshift({ type: "thinking", text: "", redacted: true })
  expect(replySpeed(encrypted, { start: 0, text: 100 }, 1100)).toBe("reply ~20 tok/s (hidden reasoning)")
})

test("no thinking uses output tokens; a reported zero rules out the gap heuristic", () => {
  expect(replySpeed(message(), { start: 0, text: 100 }, 1100, 5000)).toBe("reply 100 tok/s")
  expect(replySpeed(message(0), { start: 0, text: 5000 }, 6000, 5000)).toBe("reply 100 tok/s")
})

test("very short replies and missing text are not assigned a reply speed", () => {
  expect(replySpeed(message(80), { start: 0, text: 5000 }, 5100, 5000)).toBeUndefined()
  expect(replySpeed(message(80), { start: 0, thinking: 1000 }, 5000, 5000)).toBe("thinking 20 tok/s")
  expect(replySpeed(message(), { start: 0 }, 5000, 5000)).toBeUndefined()
})
