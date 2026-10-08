import { expect, test } from "bun:test"
import type { AssistantMessage } from "@amira/api"
import { type ReplyTiming, replySpeed } from "../src/format.ts"
import { requestSpeed, streamTiming, turnSpeed } from "../src/speed.ts"

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

test("raw reasoning counts use the sum of block durations, not text length", () => {
  expect(
    replySpeed(
      message(80),
      {
        start: 0,
        first: 1000,
        thinkingDisplay: "raw",
        thinkingBlocks: [
          { start: 1000, end: 3000 },
          { start: 3500, end: 5500 },
        ],
      },
      6000,
    ),
  ).toBe("output 20 tok/s · TTFT 1.00s · reply 20 tok/s · thinking 20 tok/s")
})

test("a requested summary suppresses the split even if the summary text is long", () => {
  expect(replySpeed(message(80, true), { start: 0, first: 1000, thinkingDisplay: "summarized" }, 6000)).toBe(
    "output 20 tok/s · TTFT 1.00s · summarized thinking; no split",
  )
})

test("reported reasoning is never replaced by a text estimate when block timing is unavailable", () => {
  expect(replySpeed(message(80, true), { start: 0, first: 1000, thinking: 1000, reply: 5000 }, 6000)).toBe(
    "output 20 tok/s · TTFT 1.00s",
  )
  expect(
    requestSpeed(
      message(80),
      {
        start: 0,
        first: 1000,
        thinkingDisplay: "omitted",
        thinkingBlocks: [{ start: 1000 }],
      },
      6000,
    ).split,
  ).toBeUndefined()
})

test("missing reasoning counts keep marked split estimates but reported output remains exact", () => {
  expect(
    replySpeed(
      message(undefined, true),
      { start: 0, thinking: 1000, reply: 5000, thinkingDisplay: "raw" },
      6000,
    ),
  ).toBe("output 20 tok/s · TTFT 1.00s · reply ~20 tok/s · thinking ~20 tok/s")
})

test("hidden or redacted reasoning without a count retains a marked reply estimate", () => {
  const hidden = message()
  hidden.content.unshift({ type: "thinking", text: "", redacted: true })
  expect(replySpeed(hidden, { start: 0, reply: 100, thinkingDisplay: "raw" }, 1100)).toBe(
    "output 100 tok/s · TTFT 0.10s · reply ~20 tok/s (hidden reasoning)",
  )
  expect(replySpeed(message(), { start: 0, reply: 5000, thinkingDisplay: "raw" }, 6000, 5000)).toBe(
    "output 100 tok/s · TTFT 5.00s · reply ~20 tok/s (hidden reasoning)",
  )
})

test("reported zero reasoning rules out the hidden-reasoning heuristic", () => {
  expect(replySpeed(message(0), { start: 0, first: 5000, thinkingDisplay: "raw" }, 6000, 5000)).toBe(
    "output 100 tok/s · TTFT 5.00s · reply 100 tok/s",
  )
})

test("reported counts use even short positive intervals; zero duration cannot give a rate", () => {
  expect(replySpeed(message(0), { start: 0, first: 5000 }, 5100)).toBe("output 1000 tok/s · TTFT 5.00s")
  expect(replySpeed(message(0), { start: 0, first: 5000 }, 5000)).toBeUndefined()
  expect(replySpeed(message(), { start: 0 }, 5000)).toBeUndefined()
})

test("tool-call-only replies include the empty tool start in output timing", () => {
  const call: AssistantMessage = {
    role: "assistant",
    model: { provider: "mock", model: "m" },
    content: [{ type: "toolCall", id: "t", name: "read", args: { path: "x".repeat(72) } }],
    usage: { input: 0, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  }
  expect(replySpeed(call, { start: 0, first: 500, reply: 900, thinkingDisplay: "raw" }, 1000)).toBe(
    "output 100 tok/s · TTFT 0.50s · reply 100 tok/s",
  )
})

test("no usage estimates output and reply; turn estimates are marked too", () => {
  const unreported = message()
  delete unreported.usage
  expect(replySpeed(unreported, { start: 0, first: 1000, reply: 1000, thinkingDisplay: "raw" }, 2000)).toBe(
    "output ~20 tok/s · TTFT 1.00s · reply ~20 tok/s",
  )
  expect(turnSpeed(40, 0, 2000, true)).toBe("effective ~20 tok/s (includes tools and waits)")
})

test("unknown display mode never invents a phase split, even without reasoning counts", () => {
  expect(
    requestSpeed(message(undefined, true), { start: 0, first: 1000, thinking: 1000, reply: 3000 }, 5000)
      .split,
  ).toBeUndefined()
})

test("an orphan thinking end invalidates the split, not just the missing block", () => {
  const t: ReplyTiming = {
    start: 0,
    first: 1000,
    thinkingDisplay: "raw",
    thinkingBlocks: [{ index: 0, start: 1000, end: 2000 }],
  }
  streamTiming(t, { kind: "thinkingEnd", index: 1 }, 3000)
  expect(requestSpeed(message(80), t, 5000).split).toBeUndefined()
})

test("search-only usage metadata cannot turn an unreported output count into an exact rate", () => {
  const searchOnly = message()
  searchOnly.usage!.outputReported = false
  expect(requestSpeed(searchOnly, { start: 0, first: 1000 }, 2000).output).toBe("output ~20 tok/s")
})
