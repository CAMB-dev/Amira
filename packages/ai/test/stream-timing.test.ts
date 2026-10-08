import { expect, test } from "bun:test"
import type { DialectContext, ProviderCompat } from "../src/dialect.ts"
import { anthropicMessages } from "../src/dialects/anthropic.ts"
import { googleGemini } from "../src/dialects/google-gemini.ts"
import { openaiChat } from "../src/dialects/openai-chat.ts"
import { openaiResponses } from "../src/dialects/openai-responses.ts"
import {
  anthropicResponse,
  blockDelta,
  blockStart,
  blockStop,
  messageDelta,
  messageStart,
  messageStop,
} from "./anthropic-helpers.ts"
import { ctx, dataSSE, namedSSE, req, run, sse } from "./dialect-helpers.ts"
import { delta, events, type Seen, sseResponse } from "./helpers.ts"

const reasoning = { effort: "high" as const }
const completed: { type: string; [key: string]: unknown } = { type: "response.completed", response: {} }
const geminiChunk = (parts: unknown[], finishReason?: string) => ({
  candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }],
})

for (const dialect of [anthropicMessages, openaiChat, openaiResponses, googleGemini]) {
  test(`${dialect.id}: request.start precedes the actual fetch, including HTTP failures`, async () => {
    let calls = 0
    const context = ctx(() => {
      calls++
      return new Response("busy", { status: 503 })
    })
    const stream = dialect.stream(req(dialect.id), context)[Symbol.asyncIterator]()
    const first = await stream.next()
    expect(first.value).toMatchObject({ type: "request.start" })
    expect(calls).toBe(0)
    const next = await stream.next()
    expect(calls).toBe(1)
    expect(next.value).toMatchObject({ type: "error", error: { status: 503 } })
    expect((await stream.next()).done).toBe(true)
  })

  test(`${dialect.id}: aborting before send emits no request.start`, async () => {
    const ac = new AbortController()
    ac.abort()
    let calls = 0
    const context = ctx(
      () => {
        calls++
        return new Response("never")
      },
      {},
      ac.signal,
    )
    const evs = await events(dialect.stream(req(dialect.id), context))
    expect(calls).toBe(0)
    expect(evs.map((e) => e.type)).toEqual(["error"])
    expect(evs[0]).toMatchObject({ error: { code: "aborted" } })
  })
}

const anthropicDisplays: {
  name: string
  baseUrl: string
  compat?: ProviderCompat
  modelDisplay?: "summarized" | "omitted"
  display?: "summarized" | "omitted"
  mode: "adaptive" | "enabled" | "disabled"
  unsigned?: boolean
}[] = [
  {
    name: "official adaptive default",
    baseUrl: "https://api.anthropic.com",
    display: "summarized",
    mode: "adaptive",
  },
  { name: "compatible raw", baseUrl: "https://compatible.test", mode: "adaptive" },
  {
    name: "provider summarized",
    baseUrl: "https://compatible.test",
    compat: { thinkingDisplay: "summarized" },
    display: "summarized",
    mode: "adaptive",
  },
  {
    name: "provider omitted",
    baseUrl: "https://api.anthropic.com",
    compat: { thinkingDisplay: "omitted" },
    display: "omitted",
    mode: "adaptive",
  },
  {
    name: "model overrides provider",
    baseUrl: "https://api.anthropic.com",
    compat: { thinkingDisplay: "summarized" },
    modelDisplay: "omitted",
    display: "omitted",
    mode: "adaptive",
  },
  {
    name: "budget summarized",
    baseUrl: "https://api.anthropic.com",
    compat: { thinking: "budget" },
    display: "summarized",
    mode: "enabled",
  },
  {
    name: "disabled unsigned tool loop",
    baseUrl: "https://api.anthropic.com",
    compat: { thinking: "budget", thinkingDisplay: "omitted" },
    mode: "disabled",
    unsigned: true,
  },
]

for (const row of anthropicDisplays) {
  test(`Anthropic request metadata reflects the actual payload: ${row.name}`, async () => {
    const r = req("anthropic-messages", { reasoning }, { thinking: true })
    if (row.modelDisplay) r.model.compat = { thinkingDisplay: row.modelDisplay }
    if (row.unsigned) {
      r.model.caps.tools = "native"
      r.tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }]
      r.messages = [
        {
          role: "assistant",
          model: { provider: "test", model: "m" },
          content: [{ type: "toolCall", id: "c", name: "read", args: {} }],
        },
        { role: "toolResult", toolCallId: "c", toolName: "read", content: [], isError: false },
      ]
    }
    const seen: Seen = {}
    const context: DialectContext = ctx(
      () => anthropicResponse([messageStart(), messageDelta("end_turn"), messageStop]),
      seen,
    )
    context.endpoint.baseUrl = row.baseUrl
    context.compat = row.compat
    const evs = await events(anthropicMessages.stream(r, context))
    expect(seen.body.thinking).toMatchObject({ type: row.mode })
    expect(seen.body.thinking.display).toBe(row.display)
    expect(evs[0]).toEqual(
      row.mode === "disabled"
        ? { type: "request.start" }
        : { type: "request.start", thinkingDisplay: row.display ?? "raw" },
    )
  })
}

test("Anthropic announces every native block and pairs multiple thinking blocks, including redacted and empty", async () => {
  const { evs } = await run(anthropicMessages, req("anthropic-messages"), () =>
    anthropicResponse([
      messageStart(),
      blockStart(0, { type: "text", text: "" }),
      blockStop(0),
      blockStart(1, { type: "thinking", thinking: "" }),
      blockDelta(1, { type: "thinking_delta", thinking: "" }),
      blockDelta(1, { type: "thinking_delta", thinking: "plan" }),
      blockStop(1),
      blockStart(2, { type: "redacted_thinking", data: "encrypted" }),
      blockStop(2),
      blockStop(2),
      blockStart(3, { type: "thinking", thinking: "" }),
      blockStop(3),
      blockStart(4, { type: "tool_use", id: "c", name: "read", input: {} }),
      blockStop(4),
      blockStart(5, { type: "unknown_future_block" }),
      blockStop(5),
      messageDelta("tool_use"),
      messageStop,
    ]),
  )
  expect(evs.slice(0, -1)).toEqual([
    { type: "request.start", thinkingDisplay: "raw" },
    { type: "start" },
    { type: "content.start", index: 0 },
    { type: "content.start", index: 1 },
    { type: "thinking.start", index: 1 },
    { type: "thinking.delta", text: "" },
    { type: "thinking.delta", text: "plan" },
    { type: "thinking.end", index: 1 },
    { type: "content.start", index: 2 },
    { type: "thinking.start", index: 2 },
    { type: "thinking.end", index: 2 },
    { type: "content.start", index: 3 },
    { type: "thinking.start", index: 3 },
    { type: "thinking.end", index: 3 },
    { type: "content.start", index: 4 },
    { type: "toolCall.delta", id: "c", index: 0, name: "read", argsDelta: "" },
    { type: "content.start", index: 5 },
  ])
  expect(evs.at(-1)).toMatchObject({ type: "done", message: { stopReason: "toolUse" } })
})

test("Responses summary:auto is summarized regardless of visible summary length", async () => {
  const summary = "summary ".repeat(10_000)
  const { evs, seen } = await run(openaiResponses, req("openai-responses", { reasoning }), () =>
    sse(
      namedSSE([
        { type: "response.output_item.added", output_index: 0, item: { id: "r", type: "reasoning" } },
        { type: "response.reasoning_summary_text.delta", item_id: "r", output_index: 0, delta: summary },
        { type: "response.output_item.done", output_index: 0, item: { id: "r", type: "reasoning" } },
        completed,
      ]),
    ),
  )
  expect(seen.body.reasoning.summary).toBe("auto")
  expect(evs[0]).toEqual({ type: "request.start", thinkingDisplay: "summarized" })
  expect(evs.slice(1, -1)).toEqual([
    { type: "start" },
    { type: "content.start", index: 0 },
    { type: "thinking.start", index: 0 },
    { type: "thinking.delta", text: summary },
    { type: "thinking.end", index: 0 },
  ])
  expect(evs.at(-1)?.type).toBe("done")
})

test("Responses tracks overlapping reasoning items and done-only reasoning without double endings", async () => {
  const { evs } = await run(openaiResponses, req("openai-responses"), () =>
    sse(
      namedSSE([
        { type: "response.output_item.added", output_index: 0, item: { id: "a", type: "reasoning" } },
        { type: "response.output_item.added", output_index: 1, item: { id: "b", type: "reasoning" } },
        { type: "response.reasoning_summary_text.delta", item_id: "a", output_index: 0, delta: "" },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: { id: "b", type: "reasoning", encrypted_content: "secret" },
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: { id: "b", type: "reasoning", encrypted_content: "secret" },
        },
        { type: "response.output_item.done", output_index: 0, item: { id: "a", type: "reasoning" } },
        {
          type: "response.output_item.done",
          output_index: 2,
          item: { id: "c", type: "reasoning", summary: [{ text: "late" }] },
        },
        {
          type: "response.output_item.added",
          output_index: 3,
          item: { id: "empty", type: "message", content: [] },
        },
        completed,
      ]),
    ),
  )
  expect(evs.slice(0, -1)).toEqual([
    { type: "request.start" },
    { type: "start" },
    { type: "content.start", index: 0 },
    { type: "thinking.start", index: 0 },
    { type: "content.start", index: 1 },
    { type: "thinking.start", index: 1 },
    { type: "thinking.delta", text: "" },
    { type: "thinking.end", index: 1 },
    { type: "thinking.end", index: 0 },
    { type: "thinking.start", index: 2 },
    { type: "thinking.delta", text: "late" },
    { type: "thinking.end", index: 2 },
    { type: "content.start", index: 3 },
  ])
  expect(evs.at(-1)).toMatchObject({
    type: "done",
    message: {
      content: [
        { type: "thinking", redacted: true },
        { type: "thinking", text: "late" },
      ],
    },
  })
})

test("Gemini includeThoughts requests summaries and closes each block on a transition or finish", async () => {
  const summary = "summary ".repeat(10_000)
  const { evs, seen } = await run(googleGemini, req("google-gemini", { reasoning }), () =>
    sse(
      dataSSE([
        geminiChunk([{ thought: true, text: summary, thoughtSignature: "s0" }]),
        geminiChunk([{ thought: true, text: "", thoughtSignature: "s1" }]),
        geminiChunk([{ text: "answer" }]),
        geminiChunk([{ thought: true, text: "tool plan" }]),
        geminiChunk([{ functionCall: { id: "c", name: "read", args: {} } }]),
        geminiChunk([{ thought: true, text: "last" }], "STOP"),
      ]),
    ),
  )
  expect(seen.body.generationConfig.thinkingConfig.includeThoughts).toBe(true)
  expect(evs.slice(0, -1)).toEqual([
    { type: "request.start", thinkingDisplay: "summarized" },
    { type: "start" },
    { type: "thinking.start", index: 0 },
    { type: "thinking.delta", text: summary },
    { type: "thinking.start", index: 1 },
    { type: "thinking.delta", text: "" },
    { type: "thinking.end", index: 0 },
    { type: "thinking.end", index: 1 },
    { type: "text.delta", text: "answer" },
    { type: "thinking.start", index: 2 },
    { type: "thinking.delta", text: "tool plan" },
    { type: "thinking.end", index: 2 },
    { type: "toolCall.delta", id: "c", index: 0, name: "read", argsDelta: "{}" },
    { type: "thinking.start", index: 3 },
    { type: "thinking.delta", text: "last" },
    { type: "thinking.end", index: 3 },
  ])
  expect(evs.at(-1)?.type).toBe("done")
})

test("Chat raw reasoning closes on answer, tool output and finish, with distinct repeated blocks", async () => {
  const { evs } = await run(openaiChat, req("openai-chat"), () =>
    sseResponse([
      delta({ reasoning_content: "" }),
      delta({ content: "answer" }),
      delta({ reasoning_content: "tool plan" }),
      delta({ tool_calls: [{ index: 0, id: "c", function: { name: "read", arguments: "{}" } }] }),
      delta({ reasoning_content: "last" }, "stop"),
    ]),
  )
  expect(evs.slice(0, -1)).toEqual([
    { type: "request.start", thinkingDisplay: "raw" },
    { type: "start" },
    { type: "thinking.start", index: 0 },
    { type: "thinking.delta", text: "" },
    { type: "thinking.end", index: 0 },
    { type: "text.delta", text: "answer" },
    { type: "thinking.start", index: 1 },
    { type: "thinking.delta", text: "tool plan" },
    { type: "thinking.end", index: 1 },
    { type: "toolCall.delta", id: "c", index: 0, name: "read", argsDelta: "{}" },
    { type: "thinking.start", index: 2 },
    { type: "thinking.delta", text: "last" },
    { type: "thinking.end", index: 2 },
  ])
  expect(evs.at(-1)).toMatchObject({
    type: "done",
    message: {
      content: [
        { type: "text", text: "answer" },
        { type: "thinking", text: "tool plan" },
        { type: "thinking", text: "last" },
        { type: "toolCall", id: "c" },
      ],
    },
  })
})

test("Chat [DONE] closes a reasoning-only block when there is no finish_reason", async () => {
  const { evs } = await run(openaiChat, req("openai-chat"), () => sseResponse([delta({ reasoning: "plan" })]))
  expect(evs.map((e) => e.type)).toEqual([
    "request.start",
    "start",
    "thinking.start",
    "thinking.delta",
    "thinking.end",
    "done",
  ])
})

test("empty answer placeholders do not invent a thinking stop", async () => {
  const chat = await run(openaiChat, req("openai-chat"), () =>
    sseResponse([
      delta({ reasoning_content: "first", content: "" }),
      delta({ reasoning_content: "second", content: "" }, "stop"),
    ]),
  )
  const gemini = await run(googleGemini, req("google-gemini"), () =>
    sse(
      dataSSE([
        geminiChunk([{ thought: true, text: "first" }, { text: "" }]),
        geminiChunk([{ thought: true, text: "second" }], "STOP"),
      ]),
    ),
  )
  for (const { evs } of [chat, gemini]) {
    expect(evs.map((e) => e.type)).toEqual([
      "request.start",
      "start",
      "thinking.start",
      "thinking.delta",
      "thinking.delta",
      "thinking.end",
      "done",
    ])
    expect(evs[2]).toEqual({ type: "thinking.start", index: 0 })
    expect(evs[5]).toEqual({ type: "thinking.end", index: 0 })
  }
})
