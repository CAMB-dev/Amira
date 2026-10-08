import { expect, test } from "bun:test"
import type { StreamEvent } from "../src/types.ts"
import {
  delta,
  type ErrorEvent,
  endlessServer,
  events,
  fakeFetch,
  request,
  SSE_HEADERS,
  sseBody,
  sseResponse,
  testAi,
  waitFor,
} from "./helpers.ts"

const terminal = (evs: StreamEvent[]) => evs.filter((e) => e.type === "done" || e.type === "error")

test("stopping iteration mid-stream cancels the HTTP body", async () => {
  const { ai, state, stop } = endlessServer()
  try {
    let n = 0
    for await (const e of ai.stream(request(ai))) {
      if (e.type === "text.delta" && ++n === 2) break
    }
    expect(await waitFor(() => state.cancelled)).toBe(true)
  } finally {
    stop()
  }
})

test("stopping iteration right after start cancels the HTTP body", async () => {
  const { ai, state, stop } = endlessServer()
  try {
    for await (const e of ai.stream(request(ai))) {
      if (e.type === "start") break
    }
    expect(await waitFor(() => state.cancelled)).toBe(true)
  } finally {
    stop()
  }
})

test("an abort before the request yields one aborted error and sends nothing", async () => {
  let called = false
  const ai = testAi((async () => {
    called = true
    return sseResponse([])
  }) as unknown as typeof fetch)
  const ac = new AbortController()
  ac.abort()
  const evs = await events(ai.stream(request(ai), ac.signal))
  expect(called).toBe(false)
  expect(evs).toHaveLength(1)
  const e = evs[0] as ErrorEvent
  expect(e.error.code).toBe("aborted")
  expect(e.message.stopReason).toBe("aborted")
})

test("an abort mid-stream yields one aborted error with the partial message", async () => {
  const { ai, state, stop } = endlessServer()
  try {
    const ac = new AbortController()
    const evs: StreamEvent[] = []
    for await (const e of ai.stream(request(ai), ac.signal)) {
      evs.push(e)
      if (evs.filter((x) => x.type === "text.delta").length === 3) ac.abort()
    }
    expect(terminal(evs)).toHaveLength(1)
    const e = evs.at(-1) as ErrorEvent
    expect(e.type).toBe("error")
    expect(e.error.code).toBe("aborted")
    expect(e.retryable).toBe(false)
    expect(e.message.stopReason).toBe("aborted")
    expect(e.message.content).toEqual([{ type: "text", text: "xxx" }])
    expect(await waitFor(() => state.cancelled)).toBe(true)
  } finally {
    stop()
  }
})

test("a reader failure mid-stream yields one retryable error with the partial message", async () => {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      c.enqueue(enc.encode(sseBody([delta({ content: "par" })], false)))
      await Bun.sleep(1)
      c.error(new Error("ECONNRESET"))
    },
  })
  const ai = testAi(fakeFetch(new Response(body, { headers: SSE_HEADERS })))
  const evs = await events(ai.stream(request(ai)))
  expect(evs.map((e) => e.type)).toEqual(["request.start", "start", "text.delta", "error"])
  const e = evs.at(-1) as ErrorEvent
  expect(e.error.message).toContain("ECONNRESET")
  expect(e.retryable).toBe(true)
  expect(e.message.stopReason).toBe("error")
  expect(e.message.content).toEqual([{ type: "text", text: "par" }])
})
