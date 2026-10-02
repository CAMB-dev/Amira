import { expect, test } from "bun:test"
import type { StreamEvent } from "../src/types.ts"
import {
  anthropicAi,
  anthropicRequest,
  anthropicResponse,
  blockDelta,
  blockStart,
  blockStop,
  messageDelta,
  messageStart,
  messageStop,
  textReply,
} from "./anthropic-helpers.ts"
import { type DoneEvent, type ErrorEvent, events, fakeFetch, SSE_HEADERS } from "./helpers.ts"

async function run(res: Response | (() => Response)) {
  const ai = anthropicAi(fakeFetch(res))
  return events(ai.stream(anthropicRequest(ai)))
}

const last = (evs: StreamEvent[]) => evs.at(-1)!
const terminal = (evs: StreamEvent[]) => evs.filter((e) => e.type === "done" || e.type === "error")

test("streams text and ignores pings", async () => {
  const evs = await run(() =>
    anthropicResponse([
      messageStart(),
      blockStart(0, { type: "text", text: "" }),
      { type: "ping" },
      blockDelta(0, { type: "text_delta", text: "Hel" }),
      blockDelta(0, { type: "text_delta", text: "lo" }),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop,
    ]),
  )
  expect(evs.map((e) => e.type)).toEqual(["start", "text.delta", "text.delta", "done"])
  const e = last(evs) as DoneEvent
  expect(e.message.content).toEqual([{ type: "text", text: "Hello" }])
  expect(e.message.stopReason).toBe("end")
  expect(e.message.model).toEqual({ provider: "anth", model: "claude" })
})

test("assembles tool arguments from input_json_delta with a stable index", async () => {
  const evs = await run(() =>
    anthropicResponse([
      messageStart(),
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "Let me look." }),
      blockStop(0),
      blockStart(1, { type: "tool_use", id: "toolu_1", name: "read", input: {} }),
      blockDelta(1, { type: "input_json_delta", partial_json: "" }),
      blockDelta(1, { type: "input_json_delta", partial_json: '{"path":' }),
      blockDelta(1, { type: "input_json_delta", partial_json: '"a.ts"}' }),
      blockStop(1),
      blockStart(2, { type: "tool_use", id: "toolu_2", name: "grep", input: {} }),
      blockDelta(2, { type: "input_json_delta", partial_json: '{"q": nope' }),
      blockStop(2),
      messageDelta("tool_use"),
      messageStop,
    ]),
  )
  const deltas = evs.filter((e) => e.type === "toolCall.delta")
  expect(deltas).toEqual([
    { type: "toolCall.delta", id: "toolu_1", index: 0, name: "read", argsDelta: "" },
    { type: "toolCall.delta", id: "toolu_1", index: 0, name: "read", argsDelta: '{"path":' },
    { type: "toolCall.delta", id: "toolu_1", index: 0, name: "read", argsDelta: '"a.ts"}' },
    { type: "toolCall.delta", id: "toolu_2", index: 1, name: "grep", argsDelta: "" },
    { type: "toolCall.delta", id: "toolu_2", index: 1, name: "grep", argsDelta: '{"q": nope' },
  ])
  const e = last(evs) as DoneEvent
  expect(e.message.stopReason).toBe("toolUse")
  expect(e.message.content).toEqual([
    { type: "text", text: "Let me look." },
    { type: "toolCall", id: "toolu_1", name: "read", args: { path: "a.ts" } },
    { type: "toolCall", id: "toolu_2", name: "grep", args: { __invalidJson: '{"q": nope' } },
  ])
})

test("streams thinking and captures its signature", async () => {
  const evs = await run(() =>
    anthropicResponse([
      messageStart(),
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      blockDelta(0, { type: "thinking_delta", thinking: "Let me " }),
      blockDelta(0, { type: "thinking_delta", thinking: "think." }),
      blockDelta(0, { type: "signature_delta", signature: "EqQB" }),
      blockDelta(0, { type: "signature_delta", signature: "Zz==" }),
      blockStop(0),
      blockStart(1, { type: "text", text: "" }),
      blockDelta(1, { type: "text_delta", text: "Done." }),
      blockStop(1),
      messageDelta("end_turn"),
      messageStop,
    ]),
  )
  expect(evs.filter((e) => e.type === "thinking.delta").map((e) => (e as any).text)).toEqual([
    "Let me ",
    "think.",
  ])
  expect((last(evs) as DoneEvent).message.content).toEqual([
    {
      type: "thinking",
      text: "Let me think.",
      signature: { dialect: "anthropic-messages", value: "EqQBZz==", host: "anth" },
    },
    { type: "text", text: "Done." },
  ])
})

test("keeps thinking without a signature unsigned", async () => {
  const evs = await run(() =>
    anthropicResponse([
      messageStart(),
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      blockDelta(0, { type: "thinking_delta", thinking: "hm" }),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop,
    ]),
  )
  expect((last(evs) as DoneEvent).message.content).toEqual([{ type: "thinking", text: "hm" }])
})

test("records redacted thinking with its encrypted data as the signature", async () => {
  const evs = await run(() =>
    anthropicResponse([
      messageStart(),
      blockStart(0, { type: "redacted_thinking", data: "ENCRYPTED" }),
      blockStop(0),
      blockStart(1, { type: "text", text: "" }),
      blockDelta(1, { type: "text_delta", text: "hi" }),
      blockStop(1),
      messageDelta("end_turn"),
      messageStop,
    ]),
  )
  expect(evs.map((e) => e.type)).toEqual(["start", "thinking.start", "text.delta", "done"])
  expect((last(evs) as DoneEvent).message.content).toEqual([
    {
      type: "thinking",
      text: "",
      redacted: true,
      signature: { dialect: "anthropic-messages", value: "ENCRYPTED", host: "anth" },
    },
    { type: "text", text: "hi" },
  ])
})

test("merges usage from message_start and message_delta", async () => {
  const evs = await run(() =>
    anthropicResponse([
      messageStart({
        input_tokens: 12,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 40,
        output_tokens: 1,
      }),
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "x" }),
      blockStop(0),
      messageDelta("end_turn", { output_tokens: 57 }),
      messageStop,
    ]),
  )
  expect((last(evs) as DoneEvent).message.usage).toEqual({
    input: 12,
    output: 57,
    cacheRead: 100,
    cacheWrite: 40,
  })
})

test("maps stop reasons", async () => {
  const stopOf = async (reason: string) => {
    const e = last(await run(() => anthropicResponse(textReply("hi", reason))))
    return e.type === "done" ? e.message.stopReason : `error:${(e as ErrorEvent).error.code}`
  }
  expect(await stopOf("end_turn")).toBe("end")
  expect(await stopOf("stop_sequence")).toBe("end")
  expect(await stopOf("max_tokens")).toBe("maxTokens")
  expect(await stopOf("tool_use")).toBe("toolUse")
  expect(await stopOf("refusal")).toBe("error:refusal")
  expect(await stopOf("something_new")).toBe("end")
})

test("a refusal is a non-retryable error that keeps the partial message", async () => {
  const evs = await run(() => anthropicResponse(textReply("I can", "refusal")))
  expect(terminal(evs)).toHaveLength(1)
  const e = last(evs) as ErrorEvent
  expect(e.retryable).toBe(false)
  expect(e.message.stopReason).toBe("error")
  expect(e.message.content).toEqual([{ type: "text", text: "I can" }])
  expect(e.error.message).toBe("the model refused to answer (stop_reason: refusal)")
})

test("a refusal's stop_details go into the error message", async () => {
  const reply = textReply("no", "refusal")
  reply[4] = {
    type: "message_delta",
    delta: {
      stop_reason: "refusal",
      stop_sequence: null,
      stop_details: { type: "refusal", category: "cyber", explanation: "Looks like malware." },
    },
    usage: { output_tokens: 1 },
  } as any
  const e = last(await run(() => anthropicResponse(reply))) as ErrorEvent
  expect(e.error).toMatchObject({
    message: "the model refused to answer (stop_reason: refusal): cyber: Looks like malware.",
    code: "refusal",
  })
})

test("an in-stream overloaded error is retryable and keeps the partial message", async () => {
  const evs = await run(() =>
    anthropicResponse([
      messageStart(),
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "par" }),
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      blockDelta(0, { type: "text_delta", text: "never" }),
    ]),
  )
  expect(terminal(evs)).toHaveLength(1)
  const e = last(evs) as ErrorEvent
  expect(e.error).toMatchObject({ message: "Overloaded", status: 529, code: "overloaded_error" })
  expect(e.retryable).toBe(true)
  expect(e.message.stopReason).toBe("error")
  expect(e.message.content).toEqual([{ type: "text", text: "par" }])
})

test("an in-stream invalid request error is not retryable", async () => {
  const e = last(
    await run(() =>
      anthropicResponse([
        messageStart(),
        { type: "error", error: { type: "invalid_request_error", message: "no" } },
      ]),
    ),
  ) as ErrorEvent
  expect(e.error.status).toBe(400)
  expect(e.retryable).toBe(false)
})

test("HTTP errors keep status and code; 429 and 5xx retry", async () => {
  const httpErr = async (status: number, type: string) => {
    const body = JSON.stringify({ type: "error", error: { type, message: `${type} happened` } })
    const evs = await run(
      () => new Response(body, { status, headers: { "content-type": "application/json" } }),
    )
    expect(evs).toHaveLength(1)
    return evs[0] as ErrorEvent
  }
  const rate = await httpErr(429, "rate_limit_error")
  expect(rate.error).toMatchObject({
    message: "HTTP 429: rate_limit_error happened",
    status: 429,
    code: "rate_limit_error",
  })
  expect(rate.retryable).toBe(true)
  expect((await httpErr(529, "overloaded_error")).retryable).toBe(true)
  expect((await httpErr(500, "api_error")).retryable).toBe(true)
  expect((await httpErr(408, "timeout_error")).retryable).toBe(true)
  expect((await httpErr(409, "conflict_error")).retryable).toBe(true)
  expect((await httpErr(401, "authentication_error")).retryable).toBe(false)
  const bad = await httpErr(400, "invalid_request_error")
  expect(bad.retryable).toBe(false)
  expect(bad.message.stopReason).toBe("error")
  const plain = (await run(() => new Response("gateway down", { status: 502 })))[0] as ErrorEvent
  expect(plain.error).toMatchObject({ message: "HTTP 502: gateway down", status: 502 })
  expect(plain.retryable).toBe(true)
})

test("a JSON error body with status 200 becomes an error event", async () => {
  const body = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } })
  const evs = await run(() => new Response(body, { headers: { "content-type": "application/json" } }))
  expect(evs).toHaveLength(1)
  const e = evs[0] as ErrorEvent
  expect(e.error.code).toBe("overloaded_error")
  expect(e.retryable).toBe(true)
})

test("a whole JSON message with status 200 is replayed as a stream", async () => {
  const msg = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "text", text: "Reading." },
      { type: "tool_use", id: "t1", name: "read", input: { path: "x" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 2 },
  }
  const evs = await run(
    () => new Response(JSON.stringify(msg), { headers: { "content-type": "application/json" } }),
  )
  expect(evs.map((e) => e.type)).toEqual([
    "start",
    "thinking.start",
    "thinking.delta",
    "text.delta",
    "toolCall.delta",
    "toolCall.delta",
    "done",
  ])
  const e = last(evs) as DoneEvent
  expect(e.message.content).toEqual([
    {
      type: "thinking",
      text: "hmm",
      signature: { dialect: "anthropic-messages", value: "sig", host: "anth" },
    },
    { type: "text", text: "Reading." },
    { type: "toolCall", id: "t1", name: "read", args: { path: "x" } },
  ])
  expect(e.message.stopReason).toBe("toolUse")
  expect(e.message.usage).toEqual({ input: 3, output: 4, cacheRead: 2, cacheWrite: 0 })
})

test("a non-JSON 200 body is a non-retryable error", async () => {
  const evs = await run(() => new Response("<html>", { headers: { "content-type": "text/html" } }))
  expect(evs).toHaveLength(1)
  expect((evs[0] as ErrorEvent).error.message).toContain("expected an event stream, got text/html")
})

test("a stream cut before the message ends is a retryable error with the partial message", async () => {
  const evs = await run(() =>
    anthropicResponse([
      messageStart(),
      blockStart(0, { type: "tool_use", id: "t", name: "read", input: {} }),
      blockDelta(0, { type: "input_json_delta", partial_json: '{"pa' }),
    ]),
  )
  expect(terminal(evs)).toHaveLength(1)
  const e = last(evs) as ErrorEvent
  expect(e.retryable).toBe(true)
  expect(e.message.content).toEqual([
    { type: "toolCall", id: "t", name: "read", args: { __invalidJson: '{"pa' } },
  ])
})

test("an empty event stream is a retryable error", async () => {
  const evs = await run(() => new Response("", { headers: SSE_HEADERS }))
  expect(evs.map((e) => e.type)).toEqual(["start", "error"])
  expect((last(evs) as ErrorEvent).retryable).toBe(true)
})

test("a stream cut off before message_delta and message_stop is a retryable error", async () => {
  const evs = await run(() => anthropicResponse(textReply("hi").slice(0, -2)))
  const e = last(evs) as ErrorEvent
  expect(e.type).toBe("error")
  expect(e.retryable).toBe(true)
})

test("accepts a stream that ends after message_delta without message_stop", async () => {
  const evs = await run(() => anthropicResponse(textReply("hi").slice(0, -1)))
  expect(last(evs).type).toBe("done")
})
