import { expect, test } from "bun:test"
import { openaiResponses } from "../src/dialects/openai-responses.ts"
import type { StreamEvent } from "../src/types.ts"
import { ctx, endless, namedSSE, req, sse, terminal } from "./dialect-helpers.ts"
import { type ErrorEvent, events, waitFor } from "./helpers.ts"

const textDelta = () =>
  namedSSE([{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "x" } as any])

test("stopping iteration mid-stream cancels the HTTP body", async () => {
  const { context, state, stop } = endless(textDelta)
  try {
    let n = 0
    for await (const e of openaiResponses.stream(req("openai-responses"), context())) {
      if (e.type === "text.delta" && ++n === 2) break
    }
    expect(await waitFor(() => state.cancelled)).toBe(true)
  } finally {
    stop()
  }
})

test("an abort mid-stream yields one aborted error with the partial message", async () => {
  const { context, state, stop } = endless(textDelta)
  try {
    const ac = new AbortController()
    const evs: StreamEvent[] = []
    for await (const e of openaiResponses.stream(req("openai-responses"), context(ac.signal))) {
      evs.push(e)
      if (evs.filter((x) => x.type === "text.delta").length === 3) ac.abort()
    }
    expect(terminal(evs)).toHaveLength(1)
    const e = evs.at(-1) as ErrorEvent
    expect(e.error.code).toBe("aborted")
    expect(e.retryable).toBe(false)
    expect(e.message.stopReason).toBe("aborted")
    expect(e.message.content).toEqual([{ type: "text", text: "xxx" }])
    expect(await waitFor(() => state.cancelled)).toBe(true)
  } finally {
    stop()
  }
})

test("an abort before the request yields one aborted error and sends nothing", async () => {
  const ac = new AbortController()
  ac.abort()
  let called = false
  const evs = await events(
    openaiResponses.stream(
      req("openai-responses"),
      ctx(
        () => {
          called = true
          return sse("")
        },
        {},
        ac.signal,
      ),
    ),
  )
  expect(called).toBe(false)
  expect(evs).toHaveLength(1)
  expect((evs[0] as ErrorEvent).message.stopReason).toBe("aborted")
})

test("a network failure is one retryable error", async () => {
  const context = ctx(() => sse(""))
  context.fetch = (async () => {
    throw new Error("ECONNREFUSED")
  }) as unknown as typeof fetch
  const evs = await events(openaiResponses.stream(req("openai-responses"), context))
  expect(evs).toHaveLength(1)
  const e = evs[0] as ErrorEvent
  expect(e.error.message).toContain("ECONNREFUSED")
  expect(e.retryable).toBe(true)
})
