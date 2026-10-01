import { expect, test } from "bun:test"
import { type Message, userMessage } from "@amira/ai"
import { estimateAfter, summaryMessages } from "../src/compaction.ts"

const reply = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  model: { provider: "p", model: "m" },
})

test("the size after a compaction scales the model's count by what is left of the history", () => {
  const older = [userMessage("a".repeat(36_000)), reply("b".repeat(36_000))]
  const kept = [userMessage("c".repeat(8_000))]
  const summary = summaryMessages("d".repeat(4_000))
  // 80k of history by estimate, about 12k left: 100k before is about 15k after.
  const after = estimateAfter(100_000, older, kept, summary)
  expect(after).toBeGreaterThan(14_000)
  expect(after).toBeLessThan(16_000)
})

test("the estimate follows the model's count for text with few characters a token", () => {
  // Chinese runs about one character a token, not four: the model's count says so.
  const older = [userMessage("改".repeat(90_000))]
  const kept = [userMessage("留".repeat(2_000))]
  const summary = summaryMessages("总".repeat(10_000))
  const after = estimateAfter(100_000, older, kept, summary)
  expect(after).toBeGreaterThan(12_000)
  expect(after).toBeLessThan(14_000)
})

test("the estimate is never more than before, unless the summary is longer than what it replaced", () => {
  const older = [userMessage("x".repeat(1_000))]
  const kept = [userMessage("y".repeat(400))]
  expect(estimateAfter(1_000, older, kept, summaryMessages("z"))).toBeLessThanOrEqual(1_000)
  expect(estimateAfter(1_000, older, kept, summaryMessages("z".repeat(4_000)))).toBeGreaterThan(1_000)
  expect(estimateAfter(1_000, [], [], [])).toBe(1_000)
})

test("a checkpoint's token count replaces the old messages without scaling the prompt overhead", () => {
  const older = [userMessage("x".repeat(1000))]
  const kept = [userMessage("y".repeat(400))]
  expect(estimateAfter(1000, older, kept, 100)).toBe(850)
  expect(estimateAfter(1000, older, kept, 500)).toBe(1250)
  expect(estimateAfter(100, older, [], 50)).toBe(50)
})
