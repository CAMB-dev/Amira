// Fixtures follow GenerateContentResponse as streamed with alt=sse:
// https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse
// https://ai.google.dev/api/generate-content#UsageMetadata and #FinishReason
// https://ai.google.dev/gemini-api/docs/thinking (thought parts and thoughtSignature)
// https://ai.google.dev/gemini-api/docs/troubleshooting (error body: {error: {code, message, status}})
import { expect, test } from "bun:test"
import { googleGemini } from "../src/dialects/google-gemini.ts"
import type { StreamEvent } from "../src/types.ts"
import { dataSSE, endless, req, run, sse, terminal } from "./dialect-helpers.ts"
import { type DoneEvent, type ErrorEvent, events, waitFor } from "./helpers.ts"

const chunk = (parts: unknown[], finishReason?: string, usageMetadata?: unknown) => ({
  candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}), index: 0 }],
  ...(usageMetadata ? { usageMetadata } : {}),
  modelVersion: "gemini-2.5-pro",
  responseId: "r1",
})

const go = (chunks: unknown[]) => run(googleGemini, req("google-gemini"), () => sse(dataSSE(chunks)))
const done = (evs: StreamEvent[]) => evs.at(-1) as DoneEvent
const lastError = (evs: StreamEvent[]) => evs.at(-1) as ErrorEvent

test("streams text and maps usage: cached tokens split out, thoughts count as output", async () => {
  const { evs } = await go([
    chunk([{ text: "Hel" }]),
    chunk([{ text: "lo" }], "STOP", {
      promptTokenCount: 100,
      cachedContentTokenCount: 30,
      candidatesTokenCount: 8,
      thoughtsTokenCount: 20,
      totalTokenCount: 128,
    }),
  ])
  expect(evs.map((e) => e.type)).toEqual(["request.start", "start", "text.delta", "text.delta", "done"])
  const { message } = done(evs)
  expect(message.content).toEqual([{ type: "text", text: "Hello" }])
  expect(message.stopReason).toBe("end")
  expect(message.usage).toEqual({ input: 70, output: 28, reasoning: 20, cacheRead: 30, cacheWrite: 0 })
})

test("function calls get stable synthetic ids and indexes, and report toolUse", async () => {
  const { evs } = await go([
    chunk([
      { functionCall: { name: "read", args: { path: "a" } }, thoughtSignature: "sigC" },
      { functionCall: { name: "grep", args: {} } },
    ]),
    chunk([], "STOP"),
  ])
  const deltas = evs.filter((e) => e.type === "toolCall.delta")
  expect(deltas.map((d) => [d.index, d.name, d.argsDelta])).toEqual([
    [0, "read", '{"path":"a"}'],
    [1, "grep", "{}"],
  ])
  const ids = deltas.map((d) => d.id)
  expect(ids[0]).toMatch(/^gemini_call_\w+_0$/)
  expect(ids[1]).toMatch(/^gemini_call_\w+_1$/)
  const { message } = done(evs)
  expect(message.stopReason).toBe("toolUse")
  expect(message.content).toEqual([
    { type: "toolCall", id: ids[0]!, name: "read", args: { path: "a" } },
    { type: "thinking", text: "", redacted: true, signature: { dialect: "google-gemini", value: "sigC" } },
    { type: "toolCall", id: ids[1]!, name: "grep", args: {} },
  ])
})

test("keeps an id Gemini sends with the call", async () => {
  const { evs } = await go([chunk([{ functionCall: { id: "fc-1", name: "r", args: {} } }], "STOP")])
  expect(done(evs).message.content).toEqual([{ type: "toolCall", id: "fc-1", name: "r", args: {} }])
})

test("thoughts stream as thinking; signatures on thoughts, text and empty parts are captured", async () => {
  const { evs } = await go([
    chunk([{ text: "Let me ", thought: true }]),
    chunk([{ text: "think.", thought: true, thoughtSignature: "sigT" }]),
    chunk([{ text: "Answer" }]),
    chunk([{ text: "", thoughtSignature: "sigEnd" }], "STOP"),
  ])
  expect(evs.filter((e) => e.type === "thinking.delta").map((e) => (e as { text: string }).text)).toEqual([
    "Let me ",
    "think.",
  ])
  expect(done(evs).message.content).toEqual([
    { type: "thinking", text: "Let me think.", signature: { dialect: "google-gemini", value: "sigT" } },
    { type: "text", text: "Answer" },
    { type: "thinking", text: "", redacted: true, signature: { dialect: "google-gemini", value: "sigEnd" } },
  ])
})

test("announces a thought part before any thought text", async () => {
  const { evs } = await go([chunk([{ text: "", thought: true }]), chunk([{ text: "answer" }], "STOP")])
  expect(evs.map((e) => e.type)).toEqual([
    "request.start",
    "start",
    "thinking.start",
    "thinking.delta",
    "thinking.end",
    "text.delta",
    "done",
  ])
  expect(done(evs).message.content).toEqual([{ type: "text", text: "answer" }])
})

test("round trips signatures: the streamed message replays with each signature on its part", async () => {
  const { evs } = await go([
    chunk([{ text: "hmm", thought: true }]),
    chunk([{ text: "Reading" }]),
    chunk([{ functionCall: { name: "read", args: { p: 1 } }, thoughtSignature: "sigC" }], "STOP"),
  ])
  const first = done(evs).message
  const call = first.content.find((b) => b.type === "toolCall")!
  const { seen } = await run(
    googleGemini,
    req("google-gemini", {
      messages: [
        first,
        {
          role: "toolResult",
          toolCallId: (call as { id: string }).id,
          toolName: "read",
          isError: false,
          content: [],
        },
      ],
    }),
    () => sse(dataSSE([chunk([{ text: "ok" }], "STOP")])),
  )
  expect(seen.body.contents).toEqual([
    {
      role: "model",
      parts: [
        { text: "hmm", thought: true },
        { text: "Reading" },
        { functionCall: { name: "read", args: { p: 1 } }, thoughtSignature: "sigC" },
      ],
    },
    { role: "user", parts: [{ functionResponse: { name: "read", response: { output: "" } } }] },
  ])
})

test("unsigned thoughts from another dialect come back as text, own thoughts as thoughts", async () => {
  const { evs } = await go([chunk([{ text: "mine", thought: true }, { text: "hi" }], "STOP")])
  const message = done(evs).message
  const { seen } = await run(
    googleGemini,
    req("google-gemini", {
      messages: [message, { ...message, content: [{ type: "thinking", text: "other" }] }],
    }),
    () => sse(dataSSE([chunk([], "STOP")])),
  )
  expect(seen.body.contents.map((c: any) => c.parts)).toEqual([
    [{ text: "mine", thought: true }, { text: "hi" }],
    [{ text: "<thinking>\nother\n</thinking>" }],
  ])
})

test("MAX_TOKENS reports maxTokens", async () => {
  const { evs } = await go([chunk([{ text: "cut" }], "MAX_TOKENS")])
  expect(done(evs).message.stopReason).toBe("maxTokens")
})

test("finishes other than STOP and MAX_TOKENS are non-retryable errors with the partial message", async () => {
  for (const reason of [
    "SAFETY",
    "RECITATION",
    "PROHIBITED_CONTENT",
    "MISSING_THOUGHT_SIGNATURE",
    "OTHER",
    "LANGUAGE",
    "FINISH_REASON_UNSPECIFIED",
    "SOMETHING_NEW",
  ]) {
    const { evs } = await go([chunk([{ text: "par" }]), chunk([], reason)])
    expect(terminal(evs)).toHaveLength(1)
    const e = lastError(evs)
    expect(e.type).toBe("error")
    expect(e.error.code).toBe(reason.toLowerCase())
    expect(e.error.message).toContain(reason)
    expect(e.retryable).toBe(false)
    expect(e.message.stopReason).toBe("error")
    expect(e.message.content).toEqual([{ type: "text", text: "par" }])
  }
})

test("a blocked prompt is an error", async () => {
  const { evs } = await go([
    { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 5 } },
  ])
  const e = lastError(evs)
  expect(e.type).toBe("error")
  expect(e.error.code).toBe("blocked")
  expect(e.error.message).toContain("SAFETY")
  expect(e.message.usage).toEqual({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test("a malformed or unexpected tool call is a retryable error", async () => {
  for (const reason of ["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL"]) {
    const e = lastError((await go([chunk([], reason)])).evs)
    expect(e.error.code).toBe(reason.toLowerCase())
    expect(e.retryable).toBe(true)
  }
})

test("an error inside the stream keeps status and code and is retryable when overloaded", async () => {
  const { evs } = await go([
    chunk([{ text: "par" }]),
    { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } },
  ])
  expect(terminal(evs)).toHaveLength(1)
  const e = lastError(evs)
  expect(e.error).toEqual({ message: "The model is overloaded.", status: 503, code: "UNAVAILABLE" })
  expect(e.retryable).toBe(true)
  expect(e.message.content).toEqual([{ type: "text", text: "par" }])
})

test("a stream that ends without a finish reason is a retryable error", async () => {
  const { evs } = await go([chunk([{ text: "par" }])])
  const e = lastError(evs)
  expect(e.type).toBe("error")
  expect(e.retryable).toBe(true)
  expect(e.message.content).toEqual([{ type: "text", text: "par" }])
})

test("HTTP errors keep status and the Google status name", async () => {
  const body = { error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" } }
  const { evs } = await run(googleGemini, req("google-gemini"), () => Response.json([body], { status: 429 }))
  expect(evs.map((e) => e.type)).toEqual(["request.start", "error"])
  const e = evs.at(-1) as ErrorEvent
  expect(e.error.status).toBe(429)
  expect(e.error.code).toBe("RESOURCE_EXHAUSTED")
  expect(e.retryable).toBe(true)
  const bad = (
    await run(googleGemini, req("google-gemini"), () =>
      Response.json({ error: { code: 400, message: "bad", status: "INVALID_ARGUMENT" } }, { status: 400 }),
    )
  ).last as ErrorEvent
  expect(bad.error.code).toBe("INVALID_ARGUMENT")
  expect(bad.retryable).toBe(false)
})

test("a non-SSE 200 with a chunk array or one response is read as the stream", async () => {
  const array = [
    chunk([{ text: "a" }]),
    chunk([{ text: "b" }], "STOP", { promptTokenCount: 3, candidatesTokenCount: 2 }),
  ]
  const fromArray = await run(googleGemini, req("google-gemini"), () => Response.json(array))
  expect(fromArray.evs.map((e) => e.type)).toEqual([
    "request.start",
    "start",
    "text.delta",
    "text.delta",
    "done",
  ])
  expect(done(fromArray.evs).message.content).toEqual([{ type: "text", text: "ab" }])
  expect(done(fromArray.evs).message.usage).toEqual({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0 })
  const single = await run(googleGemini, req("google-gemini"), () =>
    Response.json(chunk([{ text: "x" }], "STOP")),
  )
  expect(done(single.evs).message.content).toEqual([{ type: "text", text: "x" }])
})

test("a non-SSE 200 error body or junk is an error", async () => {
  const e = (
    await run(googleGemini, req("google-gemini"), () =>
      Response.json({ error: { code: 500, message: "internal", status: "INTERNAL" } }),
    )
  ).last as ErrorEvent
  expect(e.error.status).toBe(500)
  expect(e.retryable).toBe(true)
  const junk = (await run(googleGemini, req("google-gemini"), () => new Response("<html>")))
    .last as ErrorEvent
  expect(junk.error.message).toContain("expected an event stream")
})

test("an empty event stream is a retryable error", async () => {
  const e = lastError((await run(googleGemini, req("google-gemini"), () => sse(""))).evs)
  expect(e.type).toBe("error")
  expect(e.retryable).toBe(true)
})

const textChunk = () => dataSSE([chunk([{ text: "x" }])])

test("stopping iteration mid-stream cancels the HTTP body", async () => {
  const { context, state, stop } = endless(textChunk)
  try {
    let n = 0
    for await (const e of googleGemini.stream(req("google-gemini"), context())) {
      if (e.type === "text.delta" && ++n === 2) break
    }
    expect(await waitFor(() => state.cancelled)).toBe(true)
  } finally {
    stop()
  }
})

test("an abort mid-stream yields one aborted error with the partial message", async () => {
  const { context, state, stop } = endless(textChunk)
  try {
    const ac = new AbortController()
    const evs: StreamEvent[] = []
    for await (const e of googleGemini.stream(req("google-gemini"), context(ac.signal))) {
      evs.push(e)
      if (evs.filter((x) => x.type === "text.delta").length === 3) ac.abort()
    }
    expect(terminal(evs)).toHaveLength(1)
    const e = lastError(evs)
    expect(e.error.code).toBe("aborted")
    expect(e.message.stopReason).toBe("aborted")
    expect(e.message.content).toEqual([{ type: "text", text: "xxx" }])
    expect(await waitFor(() => state.cancelled)).toBe(true)
  } finally {
    stop()
  }
})

test("an abort before the request yields one aborted error", async () => {
  const ac = new AbortController()
  ac.abort()
  const { context, stop } = endless(textChunk)
  try {
    const evs = await events(googleGemini.stream(req("google-gemini"), context(ac.signal)))
    expect(evs).toHaveLength(1)
    expect(lastError(evs).message.stopReason).toBe("aborted")
  } finally {
    stop()
  }
})
