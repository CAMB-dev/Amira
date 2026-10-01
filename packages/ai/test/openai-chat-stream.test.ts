import { expect, test } from "bun:test"
import type { StreamEvent } from "../src/types.ts"
import { delta, type ErrorEvent, events, fakeFetch, request, sseResponse, testAi } from "./helpers.ts"

async function run(res: Response | (() => Response)) {
  const ai = testAi(fakeFetch(res))
  return events(ai.stream(request(ai)))
}

const last = (evs: StreamEvent[]) => evs.at(-1)!
const terminal = (evs: StreamEvent[]) => evs.filter((e) => e.type === "done" || e.type === "error")

test("maps finish reasons to stop reasons", async () => {
  const stopOf = async (finish: string) => {
    const e = last(await run(() => sseResponse([delta({ content: "hi" }, finish)])))
    return e.type === "done" ? e.message.stopReason : `error:${(e as ErrorEvent).message.stopReason}`
  }
  expect(await stopOf("stop")).toBe("end")
  expect(await stopOf("length")).toBe("maxTokens")
  expect(await stopOf("tool_calls")).toBe("toolUse")
  expect(await stopOf("something_new")).toBe("end")
})

test("reports maxTokens when a tool call is cut off by the length limit", async () => {
  const e = last(
    await run(() =>
      sseResponse([
        delta(
          { tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: '{"p' } }] },
          "length",
        ),
      ]),
    ),
  )
  expect(e.type).toBe("done")
  if (e.type !== "done") return
  expect(e.message.stopReason).toBe("maxTokens")
  expect(e.message.content).toEqual([
    { type: "toolCall", id: "a", name: "read", args: { __invalidJson: '{"p' } },
  ])
})

test("reports toolUse for tool calls finished with stop", async () => {
  const e = last(
    await run(() =>
      sseResponse([
        delta({ tool_calls: [{ index: 0, id: "a", function: { name: "r", arguments: "{}" } }] }, "stop"),
      ]),
    ),
  )
  expect(e.type === "done" && e.message.stopReason).toBe("toolUse")
})

test("reports content_filter as an error that keeps the partial message", async () => {
  const evs = await run(() => sseResponse([delta({ content: "par" }, "content_filter")]))
  expect(terminal(evs)).toHaveLength(1)
  const e = last(evs) as ErrorEvent
  expect(e.type).toBe("error")
  expect(e.error.message).toMatch(/filtered/)
  expect(e.error.code).toBe("content_filter")
  expect(e.retryable).toBe(false)
  expect(e.message.stopReason).toBe("error")
  expect(e.message.content).toEqual([{ type: "text", text: "par" }])
})

test("reads OpenAI cached_tokens usage and keeps the latest usage report", async () => {
  const e = last(
    await run(() =>
      sseResponse([
        { ...delta({ content: "a" }), usage: { prompt_tokens: 10, completion_tokens: 1 } },
        {
          ...delta({ content: "b" }, "stop"),
          usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } },
        },
      ]),
    ),
  )
  expect(e.type === "done" && e.message.usage).toEqual({ input: 6, output: 2, cacheRead: 4, cacheWrite: 0 })
})

const json = (v: unknown, type = "application/json") =>
  new Response(JSON.stringify(v), { headers: { "content-type": type } })

test("keeps the reported reasoning share of completion tokens, including zero", async () => {
  for (const reasoning of [0, 8]) {
    const e = last(
      await run(() =>
        sseResponse([
          {
            ...delta({ content: "answer" }, "stop"),
            usage: {
              prompt_tokens: 10,
              completion_tokens: 12,
              completion_tokens_details: { reasoning_tokens: reasoning },
            },
          },
        ]),
      ),
    )
    expect(e.type === "done" && e.message.usage).toEqual({
      input: 10,
      output: 12,
      reasoning,
      cacheRead: 0,
      cacheWrite: 0,
    })
  }
})

test("reports a JSON error body sent with status 200", async () => {
  const evs = await run(json({ error: { message: "model not found", code: 404 } }))
  expect(evs).toHaveLength(1)
  const e = evs[0] as ErrorEvent
  expect(e.type).toBe("error")
  expect(e.error.message).toBe("model not found")
})

test("translates a whole non-streamed completion into a done message", async () => {
  const evs = await run(
    json({
      choices: [
        {
          message: {
            role: "assistant",
            content: "hi",
            tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: '{"p":1}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    }),
  )
  expect(evs.map((e) => e.type)).toEqual(["start", "text.delta", "toolCall.delta", "done"])
  const e = last(evs)
  if (e.type !== "done") throw new Error("expected done")
  expect(e.message.content).toEqual([
    { type: "text", text: "hi" },
    { type: "toolCall", id: "a", name: "read", args: { p: 1 } },
  ])
  expect(e.message.stopReason).toBe("toolUse")
  expect(e.message.usage).toEqual({ input: 10, output: 3, cacheRead: 0, cacheWrite: 0 })
})

test("reports an unexpected non-stream body with its first 500 characters", async () => {
  const evs = await run(new Response(`<p>${"x".repeat(1000)}`, { headers: { "content-type": "text/html" } }))
  expect(evs).toHaveLength(1)
  const e = evs[0] as ErrorEvent
  expect(e.type).toBe("error")
  expect(e.error.message).toContain("text/html")
  expect(e.error.message).toContain("<p>xxx")
  expect(e.error.message.length).toBeLessThan(600)
})

test("reports an event stream without any events as an error", async () => {
  for (const body of ["", ": keep-alive\n\n", "data: not json\n\n"]) {
    const evs = await run(new Response(body, { headers: { "content-type": "text/event-stream" } }))
    expect(terminal(evs)).toHaveLength(1)
    const e = last(evs) as ErrorEvent
    expect(e.type).toBe("error")
    expect(e.retryable).toBe(true)
  }
})

test("accepts a bare [DONE] stream as an empty reply", async () => {
  const evs = await run(() => sseResponse([]))
  expect(evs.map((e) => e.type)).toEqual(["start", "done"])
})

test("finishes normally when the body ends without [DONE]", async () => {
  const evs = await run(() => sseResponse([delta({ content: "hi" }, "stop")], false))
  expect(evs.map((e) => e.type)).toEqual(["start", "text.delta", "done"])
})

test("a stream cut off before any finish_reason or [DONE] is a retryable error", async () => {
  const cut = [
    delta({ content: "hal" }),
    delta({ tool_calls: [{ index: 0, id: "a", function: { name: "read" } }] }),
  ]
  const evs = await run(() => sseResponse(cut, false))
  const e = last(evs) as ErrorEvent
  expect(e.type).toBe("error")
  expect(e.retryable).toBe(true)
  expect(e.error.message).toContain("ended before the reply was complete")
  // The partial text survives for the caller; the unfinished call is not offered as done.
  expect(e.message.content).toEqual([{ type: "text", text: "hal" }])
})

test("a finish_reason in the last chunk with usage in a later one is complete without [DONE]", async () => {
  const chunks = [
    delta({ content: "hi" }, "stop"),
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
  ]
  const evs = await run(() => sseResponse(chunks, false))
  expect(last(evs).type).toBe("done")
})

test("keeps status and code of an error object inside the stream", async () => {
  const evs = await run(() =>
    sseResponse([delta({ content: "hi" }), { error: { message: "rate limited", code: 429 } }]),
  )
  expect(terminal(evs)).toHaveLength(1)
  const e = last(evs) as ErrorEvent
  expect(e.type).toBe("error")
  expect(e.error).toMatchObject({ message: "rate limited", status: 429, code: "429" })
  expect(e.retryable).toBe(true)
  expect(e.message.content).toEqual([{ type: "text", text: "hi" }])
  expect(e.message.stopReason).toBe("error")
})

test("derives status from a string code or status field", async () => {
  const errorOf = async (error: unknown) => last(await run(() => sseResponse([{ error }]))) as ErrorEvent
  const upstream = await errorOf({ message: "upstream", status: 502, type: "server_error" })
  expect(upstream.error).toMatchObject({ message: "upstream", status: 502, code: "server_error" })
  expect(upstream.retryable).toBe(true)
  const bad = await errorOf({ message: "bad", code: "400" })
  expect(bad.error.status).toBe(400)
  expect(bad.retryable).toBe(false)
  const named = await errorOf({ message: "nope", code: "invalid_api_key" })
  expect(named.error).toMatchObject({ message: "nope", code: "invalid_api_key" })
  expect(named.retryable).toBe(false)
})

test("accepts an error that is a plain string", async () => {
  const e = last(await run(() => sseResponse([{ error: "Internal failure" }]))) as ErrorEvent
  expect(e.type).toBe("error")
  expect(e.error.message).toBe("Internal failure")
  expect(e.retryable).toBe(false)
})

test("marks a 5xx error body sent with status 200 as retryable", async () => {
  const evs = await run(json({ error: { message: "overloaded", code: 503 } }))
  const e = evs[0] as ErrorEvent
  expect(e.error.status).toBe(503)
  expect(e.retryable).toBe(true)
})

test("reports a 200 response without a body", async () => {
  const evs = await run(new Response(null, { status: 200 }))
  expect(evs).toHaveLength(1)
  expect(evs[0]?.type).toBe("error")
})
