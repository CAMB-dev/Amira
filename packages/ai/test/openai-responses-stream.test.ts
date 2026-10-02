// Fixtures follow the documented Responses streaming events:
// https://platform.openai.com/docs/api-reference/responses-streaming
// https://platform.openai.com/docs/guides/function-calling#streaming
// https://platform.openai.com/docs/guides/reasoning#reasoning-summaries
import { expect, test } from "bun:test"
import { openaiResponses } from "../src/dialects/openai-responses.ts"
import type { StreamEvent } from "../src/types.ts"
import { namedSSE, req, run, sse, terminal } from "./dialect-helpers.ts"
import type { DoneEvent, ErrorEvent } from "./helpers.ts"

let seq = 0
const ev = (type: string, fields: Record<string, unknown> = {}) => ({
  type,
  sequence_number: seq++,
  ...fields,
})

const created = ev("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } })
const completed = (usage?: unknown, output: unknown[] = []) =>
  ev("response.completed", { response: { id: "resp_1", status: "completed", output, usage } })

const textEvents = (id: string, index: number, deltas: string[]) => [
  ev("response.output_item.added", {
    output_index: index,
    item: { id, type: "message", status: "in_progress", role: "assistant", content: [] },
  }),
  ev("response.content_part.added", {
    item_id: id,
    output_index: index,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  }),
  ...deltas.map((delta) =>
    ev("response.output_text.delta", { item_id: id, output_index: index, content_index: 0, delta }),
  ),
  ev("response.output_text.done", {
    item_id: id,
    output_index: index,
    content_index: 0,
    text: deltas.join(""),
  }),
  ev("response.output_item.done", {
    output_index: index,
    item: {
      id,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: deltas.join(""), annotations: [] }],
    },
  }),
]

const callEvents = (id: string, callId: string, name: string, index: number, deltas: string[]) => [
  ev("response.output_item.added", {
    output_index: index,
    item: { id, type: "function_call", status: "in_progress", call_id: callId, name, arguments: "" },
  }),
  ...deltas.map((delta) =>
    ev("response.function_call_arguments.delta", { item_id: id, output_index: index, delta }),
  ),
  ev("response.function_call_arguments.done", {
    item_id: id,
    output_index: index,
    arguments: deltas.join(""),
  }),
  ev("response.output_item.done", {
    output_index: index,
    item: {
      id,
      type: "function_call",
      status: "completed",
      call_id: callId,
      name,
      arguments: deltas.join(""),
    },
  }),
]

const stream = (events: { type: string }[]) => () => sse(namedSSE(events))
const go = (events: { type: string }[]) => run(openaiResponses, req("openai-responses"), stream(events))
const done = (evs: StreamEvent[]) => evs.at(-1) as DoneEvent
/** Text from an output message, signed with its item id for replay. */
const said = (text: string, id = "msg_1") => ({
  type: "text" as const,
  text,
  signature: { dialect: "openai-responses", value: JSON.stringify({ id }) },
})

test("streams text and maps usage with cached tokens", async () => {
  const { evs } = await go([
    created,
    ...textEvents("msg_1", 0, ["Hel", "lo"]),
    completed({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 12,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 112,
    }),
  ])
  expect(evs.map((e) => e.type)).toEqual(["start", "text.delta", "text.delta", "done"])
  const { message } = done(evs)
  expect(message.content).toEqual([said("Hello")])
  expect(message.stopReason).toBe("end")
  expect(message.usage).toEqual({ input: 60, output: 12, reasoning: 5, cacheRead: 40, cacheWrite: 0 })
})

test("maps cache_write_tokens to cacheWrite and out of input", async () => {
  const { evs } = await go([
    created,
    completed({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 25 },
      output_tokens: 1,
    }),
  ])
  expect(done(evs).message.usage).toEqual({ input: 35, output: 1, cacheRead: 40, cacheWrite: 25 })
})

test("streams tool calls with stable indexes and reports toolUse", async () => {
  const { evs } = await go([
    created,
    ...callEvents("fc_1", "call_a", "read", 0, ['{"pa', 'th":"a"}']),
    ...callEvents("fc_2", "call_b", "grep", 1, ["{}"]),
    completed(),
  ])
  const deltas = evs.filter((e) => e.type === "toolCall.delta")
  expect(deltas).toEqual([
    { type: "toolCall.delta", index: 0, id: "call_a", name: "read", argsDelta: "" },
    { type: "toolCall.delta", index: 0, id: "call_a", name: "read", argsDelta: '{"pa' },
    { type: "toolCall.delta", index: 0, id: "call_a", name: "read", argsDelta: 'th":"a"}' },
    { type: "toolCall.delta", index: 1, id: "call_b", name: "grep", argsDelta: "" },
    { type: "toolCall.delta", index: 1, id: "call_b", name: "grep", argsDelta: "{}" },
  ])
  const { message } = done(evs)
  expect(message.stopReason).toBe("toolUse")
  expect(message.content).toEqual([
    { type: "toolCall", id: "call_a", name: "read", args: { path: "a" } },
    { type: "toolCall", id: "call_b", name: "grep", args: {} },
  ])
})

test("keeps invalid tool JSON", async () => {
  const { evs } = await go([created, ...callEvents("fc_1", "call_a", "read", 0, ['{"p']), completed()])
  expect(done(evs).message.content).toEqual([
    { type: "toolCall", id: "call_a", name: "read", args: { __invalidJson: '{"p' } },
  ])
})

test("reasoning summaries stream as thinking and keep the encrypted content as the signature", async () => {
  const reasoning = (status: string, extra = {}) => ({
    id: "rs_1",
    type: "reasoning",
    status,
    summary: [],
    ...extra,
  })
  const { evs } = await go([
    created,
    ev("response.output_item.added", { output_index: 0, item: reasoning("in_progress") }),
    ev("response.reasoning_summary_part.added", {
      item_id: "rs_1",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
    ev("response.reasoning_summary_text.delta", {
      item_id: "rs_1",
      output_index: 0,
      summary_index: 0,
      delta: "Plan",
    }),
    ev("response.reasoning_summary_text.delta", {
      item_id: "rs_1",
      output_index: 0,
      summary_index: 1,
      delta: "Act",
    }),
    ev("response.output_item.done", {
      output_index: 0,
      item: reasoning("completed", {
        summary: [
          { type: "summary_text", text: "Plan" },
          { type: "summary_text", text: "Act" },
        ],
        encrypted_content: "gAAAA-enc",
      }),
    }),
    ...textEvents("msg_1", 1, ["Hi"]),
    completed(),
  ])
  expect(evs.filter((e) => e.type === "thinking.delta")).toEqual([
    { type: "thinking.delta", text: "Plan" },
    { type: "thinking.delta", text: "\n\nAct" },
  ])
  const { message } = done(evs)
  expect(message.content).toEqual([
    {
      type: "thinking",
      text: "Plan\n\nAct",
      signature: {
        dialect: "openai-responses",
        value: JSON.stringify({ id: "rs_1", encrypted_content: "gAAAA-enc" }),
      },
    },
    said("Hi"),
  ])
})

test("round trips reasoning: the streamed message replays as the same reasoning item", async () => {
  const { evs } = await go([
    created,
    ev("response.output_item.added", {
      output_index: 0,
      item: { id: "rs_9", type: "reasoning", summary: [] },
    }),
    ev("response.output_item.done", {
      output_index: 0,
      item: { id: "rs_9", type: "reasoning", summary: [], encrypted_content: "secret" },
    }),
    ...callEvents("fc_1", "call_a", "read", 1, ["{}"]),
    completed(),
  ])
  expect(evs.filter((e) => e.type === "thinking.start")).toEqual([{ type: "thinking.start" }])
  const first = done(evs).message
  expect(first.content[0]).toEqual({
    type: "thinking",
    text: "",
    redacted: true,
    signature: {
      dialect: "openai-responses",
      value: JSON.stringify({ id: "rs_9", encrypted_content: "secret" }),
    },
  })
  const { seen } = await run(
    openaiResponses,
    req("openai-responses", {
      messages: [
        first,
        { role: "toolResult", toolCallId: "call_a", toolName: "read", isError: false, content: [] },
      ],
    }),
    stream([completed()]),
  )
  expect(seen.body.input).toEqual([
    { type: "reasoning", id: "rs_9", summary: [], encrypted_content: "secret" },
    { type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_a", output: "" },
  ])
})

test("round trips output messages with their id and phase", async () => {
  const item = { id: "msg_7", type: "message", role: "assistant", phase: "final_answer", content: [] }
  const { evs } = await go([
    created,
    ev("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } }),
    ev("response.output_text.delta", { item_id: "msg_7", output_index: 0, content_index: 0, delta: "Hi" }),
    ev("response.output_item.done", { output_index: 0, item: { ...item, status: "completed" } }),
    completed(),
  ])
  const first = done(evs).message
  const { seen } = await run(
    openaiResponses,
    req("openai-responses", { messages: [first] }),
    stream([completed()]),
  )
  expect(seen.body.input).toEqual([
    {
      type: "message",
      id: "msg_7",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hi", annotations: [] }],
      phase: "final_answer",
    },
  ])
})

test("drops empty reasoning items that carry nothing to replay", async () => {
  const { evs } = await go([
    created,
    ev("response.output_item.added", {
      output_index: 0,
      item: { id: "rs_1", type: "reasoning", summary: [] },
    }),
    ev("response.output_item.done", {
      output_index: 0,
      item: { id: "rs_1", type: "reasoning", summary: [] },
    }),
    ...textEvents("msg_1", 1, ["ok"]),
    completed(),
  ])
  expect(done(evs).message.content).toEqual([said("ok")])
})

test("response.incomplete for max_output_tokens reports maxTokens", async () => {
  const { evs } = await go([
    created,
    ...textEvents("msg_1", 0, ["cut"]),
    ev("response.incomplete", {
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    }),
  ])
  const { message } = done(evs)
  expect(message.stopReason).toBe("maxTokens")
  expect(message.usage).toEqual({ input: 5, output: 7, cacheRead: 0, cacheWrite: 0 })
})

test("response.incomplete for content_filter is an error with the partial message", async () => {
  const { evs } = await go([
    created,
    ...textEvents("msg_1", 0, ["par"]),
    ev("response.incomplete", {
      response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
    }),
  ])
  const e = evs.at(-1) as ErrorEvent
  expect(e.type).toBe("error")
  expect(e.error.code).toBe("content_filter")
  expect(e.message.content).toEqual([said("par")])
})

test("response.failed keeps code and partial message; server errors are retryable", async () => {
  const { evs } = await go([
    created,
    ...textEvents("msg_1", 0, ["par"]),
    ev("response.failed", {
      response: { status: "failed", error: { code: "server_error", message: "The server had an error" } },
    }),
  ])
  expect(terminal(evs)).toHaveLength(1)
  const e = evs.at(-1) as ErrorEvent
  expect(e.error).toEqual({ message: "The server had an error", code: "server_error", status: 500 })
  expect(e.retryable).toBe(true)
  expect(e.message.stopReason).toBe("error")
  expect(e.message.content).toEqual([said("par")])
})

test("an in-stream error event keeps its code; rate limits are retryable, bad requests are not", async () => {
  const errorOf = async (code: string) => {
    const { last } = await go([created, ev("error", { code, message: "nope", param: null })])
    return last as ErrorEvent
  }
  const limited = await errorOf("rate_limit_exceeded")
  expect(limited.error).toEqual({ message: "nope", code: "rate_limit_exceeded", status: 429 })
  expect(limited.retryable).toBe(true)
  const bad = await errorOf("invalid_prompt")
  expect(bad.error).toEqual({ message: "nope", code: "invalid_prompt" })
  expect(bad.retryable).toBe(false)
})

test("a stream that ends before response.completed is a retryable error", async () => {
  const { evs } = await go([created, ...textEvents("msg_1", 0, ["par"])])
  expect(terminal(evs)).toHaveLength(1)
  const e = evs.at(-1) as ErrorEvent
  expect(e.type).toBe("error")
  expect(e.retryable).toBe(true)
  expect(e.message.content).toEqual([said("par")])
})

test("reads events named only in the SSE event field", async () => {
  const body =
    'event: response.output_text.delta\ndata: {"item_id":"m","delta":"hi"}\n\nevent: response.completed\ndata: {"response":{}}\n\n'
  const { evs } = await run(openaiResponses, req("openai-responses"), () => sse(body))
  expect(done(evs).message.content).toEqual([{ type: "text", text: "hi" }])
})

test("HTTP errors keep status and code", async () => {
  const res = () =>
    new Response(
      JSON.stringify({ error: { message: "slow down", type: "requests", code: "rate_limit_exceeded" } }),
      {
        status: 429,
      },
    )
  const { evs } = await run(openaiResponses, req("openai-responses"), res)
  expect(evs).toHaveLength(1)
  const e = evs[0] as ErrorEvent
  expect(e.error.status).toBe(429)
  expect(e.error.code).toBe("rate_limit_exceeded")
  expect(e.retryable).toBe(true)
  const bad = (await run(openaiResponses, req("openai-responses"), () => new Response("no", { status: 400 })))
    .last as ErrorEvent
  expect(bad.retryable).toBe(false)
  expect(bad.error.status).toBe(400)
})

test("a non-SSE 200 with a whole response is read as one", async () => {
  const response = {
    id: "resp_1",
    object: "response",
    status: "completed",
    output: [
      {
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "think" }],
        encrypted_content: "enc",
      },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi", annotations: [] }],
      },
      { id: "fc_1", type: "function_call", call_id: "call_a", name: "read", arguments: '{"p":1}' },
    ],
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3 },
  }
  const res = () =>
    new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } })
  const { evs } = await run(openaiResponses, req("openai-responses"), res)
  expect(evs.map((e) => e.type)).toEqual([
    "start",
    "thinking.start",
    "thinking.delta",
    "text.delta",
    "toolCall.delta",
    "toolCall.delta",
    "done",
  ])
  const { message } = done(evs)
  expect(message.stopReason).toBe("toolUse")
  expect(message.usage).toEqual({ input: 8, output: 3, cacheRead: 2, cacheWrite: 0 })
  expect(message.content).toEqual([
    {
      type: "thinking",
      text: "think",
      signature: {
        dialect: "openai-responses",
        value: JSON.stringify({ id: "rs_1", encrypted_content: "enc" }),
      },
    },
    said("hi"),
    { type: "toolCall", id: "call_a", name: "read", args: { p: 1 } },
  ])
})

test("a non-SSE 200 error body or junk is an error", async () => {
  const json = (body: unknown) => () =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  const e = (
    await run(
      openaiResponses,
      req("openai-responses"),
      json({ error: { message: "bad", code: "server_error" } }),
    )
  ).last as ErrorEvent
  expect(e.error.code).toBe("server_error")
  expect(e.retryable).toBe(true)
  const junk = (await run(openaiResponses, req("openai-responses"), () => new Response("<html>")))
    .last as ErrorEvent
  expect(junk.type).toBe("error")
  expect(junk.error.message).toContain("expected an event stream")
})
