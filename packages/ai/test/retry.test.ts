import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { retryAfterMs } from "../src/dialects/retry-after.ts"
import type { RetryOptions } from "../src/retry.ts"
import type { StreamEvent } from "../src/types.ts"
import { delta, events, SSE_HEADERS, sseBody, sseResponse } from "./helpers.ts"

/** A client whose fetch answers with the given responses in turn, counting calls. */
function scripted(responses: (() => Response)[], retry: RetryOptions = { baseDelayMs: 5 }) {
  const calls = { n: 0 }
  const signals: AbortSignal[] = []
  const ai = createAi({
    retry,
    fetch: (async (_url: string | URL | Request, init: RequestInit = {}) => {
      if (init.signal) signals.push(init.signal)
      return responses[Math.min(calls.n++, responses.length - 1)]!()
    }) as unknown as typeof fetch,
    providers: [{ id: "test", dialect: "openai-chat", baseUrl: "http://test/v1" }],
  })
  const stream = (signal?: AbortSignal) =>
    events(ai.stream({ model: ai.model("test/m"), systemPrompt: "", messages: [], tools: [] }, signal))
  return { calls, signals, stream }
}

const ok = () => sseResponse([delta({ content: "hi" }), delta({}, "stop")])
const status =
  (s: number, headers: Record<string, string> = {}) =>
  () =>
    new Response("busy", { status: s, headers })
const types = (evs: StreamEvent[]) => evs.map((e) => e.type)

test("parses Retry-After as seconds, an HTTP date, or retry-after-ms", () => {
  const now = Date.parse("2026-01-01T00:00:00Z")
  expect(retryAfterMs(new Headers({ "retry-after": "3" }))).toBe(3000)
  expect(retryAfterMs(new Headers({ "retry-after": "0.5" }))).toBe(500)
  expect(retryAfterMs(new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:07 GMT" }), now)).toBe(7000)
  expect(retryAfterMs(new Headers({ "retry-after": "Wed, 31 Dec 2025 00:00:00 GMT" }), now)).toBe(0)
  expect(retryAfterMs(new Headers({ "retry-after-ms": "250", "retry-after": "9" }))).toBe(250)
  expect(retryAfterMs(new Headers({ "retry-after": "soon" }))).toBeUndefined()
  expect(retryAfterMs(new Headers())).toBeUndefined()
})

test("HTTP error events carry Retry-After", async () => {
  const { stream } = scripted([status(429, { "retry-after": "2" })], { retries: 0 })
  const last = (await stream()).at(-1)
  expect(last).toMatchObject({ type: "error", retryable: true, retryAfterMs: 2000 })
})

test("retries a retryable failure with exponential backoff, then succeeds", async () => {
  const { calls, stream } = scripted([status(500), status(503), ok])
  const evs = await stream()
  expect(calls.n).toBe(3)
  expect(types(evs)).toEqual(["retry", "retry", "start", "text.delta", "done"])
  expect(evs.filter((e) => e.type === "retry")).toEqual([
    { type: "retry", attempt: 1, maxRetries: 3, delayMs: 5, error: expect.objectContaining({ status: 500 }) },
    {
      type: "retry",
      attempt: 2,
      maxRetries: 3,
      delayMs: 10,
      error: expect.objectContaining({ status: 503 }),
    },
  ])
})

test("retries a timeout body error returned before any content", async () => {
  const timeout = () =>
    sseResponse([{ error: { message: "unable to start processing your request within the timeout limit" } }])
  const { calls, stream } = scripted([timeout, ok], { retries: 1, baseDelayMs: 1 })
  const evs = await stream()
  expect(calls.n).toBe(2)
  expect(types(evs)).toEqual(["start", "retry", "text.delta", "done"])
  expect(evs.find((e) => e.type === "retry")).toMatchObject({
    error: { message: expect.stringContaining("unable to start processing") },
  })
})

test("times out a keep-alive-only attempt and retries it", async () => {
  const encoder = new TextEncoder()
  const hanging = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(": keep-alive\n\n"))
        },
      }),
      { headers: SSE_HEADERS },
    )
  const { calls, signals, stream } = scripted([hanging, ok], {
    retries: 1,
    baseDelayMs: 1,
    firstContentTimeoutMs: 15,
    idleTimeoutMs: 15,
  })
  const evs = await stream()
  expect(calls.n).toBe(2)
  expect(signals[0]?.aborted).toBe(true)
  expect(types(evs)).toEqual(["start", "retry", "text.delta", "done"])
  expect(evs.find((e) => e.type === "retry")).toMatchObject({
    error: { code: "timeout", message: "model produced no content within 15 ms" },
  })
})

test("times out silence after content and retries the attempt", async () => {
  const encoder = new TextEncoder()
  const partial = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseBody([delta({ content: "partial" })], false)))
        },
      }),
      { headers: SSE_HEADERS },
    )
  const { calls, stream } = scripted([partial, ok], {
    retries: 1,
    baseDelayMs: 1,
    firstContentTimeoutMs: 100,
    idleTimeoutMs: 15,
  })
  const evs = await stream()
  expect(calls.n).toBe(2)
  expect(types(evs)).toEqual(["start", "text.delta", "retry", "text.delta", "done"])
  expect(evs.find((e) => e.type === "retry")).toMatchObject({
    error: { code: "timeout", message: "model stream was idle for 15 ms" },
  })
})

test("gives up after the configured number of retries", async () => {
  const { calls, stream } = scripted([status(500)], { retries: 2, baseDelayMs: 1 })
  const evs = await stream()
  expect(calls.n).toBe(3)
  expect(types(evs)).toEqual(["retry", "retry", "error"])
})

test("does not retry errors that are not retryable", async () => {
  const { calls, stream } = scripted([status(400), ok])
  expect(types(await stream())).toEqual(["error"])
  expect(calls.n).toBe(1)
})

test("waits as long as Retry-After says", async () => {
  const { stream } = scripted([status(429, { "retry-after": "0.05" }), ok])
  const started = performance.now()
  const evs = await stream()
  expect(evs[0]).toMatchObject({ type: "retry", delayMs: 50 })
  expect(performance.now() - started).toBeGreaterThanOrEqual(45)
  expect(evs.at(-1)?.type).toBe("done")
})

test("returns the error instead of waiting out a very long Retry-After", async () => {
  const { calls, stream } = scripted([status(429, { "retry-after": "3600" }), ok])
  expect(types(await stream())).toEqual(["error"])
  expect(calls.n).toBe(1)
})

test("never retries once content has streamed", async () => {
  const cut = () =>
    new Response(
      sseBody([delta({ content: "partial" }), { error: { message: "overloaded", code: 503 } }], false),
      {
        headers: SSE_HEADERS,
      },
    )
  const { calls, stream } = scripted([cut, ok])
  const evs = await stream()
  expect(calls.n).toBe(1)
  expect(types(evs)).toEqual(["start", "text.delta", "error"])
})

test("a stream that failed after start but before content is retried with one start event", async () => {
  const empty = () => new Response("", { headers: SSE_HEADERS })
  const { calls, stream } = scripted([empty, ok])
  expect(types(await stream())).toEqual(["start", "retry", "text.delta", "done"])
  expect(calls.n).toBe(2)
})

test("an abort during the backoff ends the stream at once as aborted", async () => {
  const { calls, stream } = scripted([status(500), ok], { baseDelayMs: 10_000 })
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 20)
  const started = performance.now()
  const evs = await stream(ctrl.signal)
  expect(performance.now() - started).toBeLessThan(2000)
  expect(calls.n).toBe(1)
  expect(evs.at(-1)).toMatchObject({
    type: "error",
    error: { code: "aborted" },
    retryable: false,
    message: { stopReason: "aborted" },
  })
})
