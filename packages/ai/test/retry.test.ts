import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { retryAfterMs } from "../src/dialects/retry-after.ts"
import { type RetryOptions, withRetry } from "../src/retry.ts"
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

test("a silent reasoning block uses the idle timeout instead of the first-content timeout", async () => {
  const attempt = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: "start" }
    yield { type: "thinking.start" }
    await Bun.sleep(35)
    yield {
      type: "done",
      message: { role: "assistant", content: [], model: { provider: "", model: "" }, stopReason: "end" },
    }
  }
  const evs = await events(
    withRetry(attempt, new AbortController().signal, {
      retries: 0,
      firstContentTimeoutMs: 15,
      idleTimeoutMs: 100,
    }),
  )
  expect(types(evs)).toEqual(["start", "thinking.start", "done"])
})

test("a reasoning start alone that then goes idle is sent again", async () => {
  let n = 0
  const attempt = async function* (): AsyncGenerator<StreamEvent> {
    n++
    yield { type: "start" }
    yield { type: "thinking.start" }
    if (n === 1) await new Promise<never>(() => {})
    yield { type: "text.delta", text: "hi" }
    yield {
      type: "done",
      message: { role: "assistant", content: [], model: { provider: "", model: "" }, stopReason: "end" },
    }
  }
  const evs = await events(
    withRetry(attempt, new AbortController().signal, {
      retries: 1,
      baseDelayMs: 1,
      firstContentTimeoutMs: 15,
      idleTimeoutMs: 20,
    }),
  )
  expect(n).toBe(2)
  expect(types(evs)).toEqual(["start", "thinking.start", "retry", "thinking.start", "text.delta", "done"])
  expect(evs[2]).toMatchObject({
    type: "retry",
    error: { code: "timeout", message: "model stream was idle for 20 ms" },
  })
})

test("a reasoning start alone does not stop a retryable error from being retried", async () => {
  let n = 0
  const attempt = async function* (): AsyncGenerator<StreamEvent> {
    n++
    yield { type: "start" }
    yield { type: "thinking.start" }
    if (n === 1) {
      yield {
        type: "error",
        error: { message: "overloaded", status: 529 },
        retryable: true,
        message: { role: "assistant", content: [], model: { provider: "", model: "" }, stopReason: "error" },
      }
      return
    }
    yield {
      type: "done",
      message: { role: "assistant", content: [], model: { provider: "", model: "" }, stopReason: "end" },
    }
  }
  const evs = await events(withRetry(attempt, new AbortController().signal, { retries: 1, baseDelayMs: 1 }))
  expect(n).toBe(2)
  expect(types(evs)).toEqual(["start", "thinking.start", "retry", "thinking.start", "done"])
})

test("streamed reasoning text that then goes idle is not sent again", async () => {
  let n = 0
  const attempt = async function* (): AsyncGenerator<StreamEvent> {
    n++
    yield { type: "start" }
    yield { type: "thinking.start" }
    yield { type: "thinking.delta", text: "hmm" }
    await new Promise<never>(() => {})
  }
  const evs = await events(
    withRetry(attempt, new AbortController().signal, {
      retries: 2,
      baseDelayMs: 1,
      firstContentTimeoutMs: 15,
      idleTimeoutMs: 20,
    }),
  )
  expect(n).toBe(1)
  expect(types(evs)).toEqual(["start", "thinking.start", "thinking.delta", "error"])
  expect(evs[3]).toMatchObject({
    error: {
      code: "timeout",
      message: "model stream was idle for 20 ms. Type a message to continue, or press ↑ to resend.",
    },
    message: { content: [{ type: "thinking", text: "hmm" }], stopReason: "error" },
  })
})

test("a stream with no events still times out as having no content", async () => {
  const attempt = async function* (): AsyncGenerator<StreamEvent> {
    await new Promise<never>(() => {})
  }
  const evs = await events(
    withRetry(attempt, new AbortController().signal, {
      retries: 0,
      firstContentTimeoutMs: 15,
      idleTimeoutMs: 100,
    }),
  )
  expect(types(evs)).toEqual(["error"])
  expect(evs[0]).toMatchObject({
    type: "error",
    error: { code: "timeout", message: "model produced no content within 15 ms" },
  })
})

test("ends a stream that goes silent after content without sending it again", async () => {
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
  const { calls, signals, stream } = scripted([partial, ok], {
    retries: 1,
    baseDelayMs: 1,
    firstContentTimeoutMs: 100,
    idleTimeoutMs: 15,
  })
  const evs = await stream()
  // The partial text was already shown: a second attempt would show it twice.
  expect(calls.n).toBe(1)
  expect(signals[0]?.aborted).toBe(true)
  expect(types(evs)).toEqual(["start", "text.delta", "error"])
  expect(evs.at(-1)).toMatchObject({
    error: {
      code: "timeout",
      status: 408,
      message: "model stream was idle for 15 ms. Type a message to continue, or press ↑ to resend.",
    },
    message: { content: [{ type: "text", text: "partial" }], stopReason: "error" },
  })
})

test("a timeout after a visible tool event waits for the user instead of sending again", async () => {
  const visible: StreamEvent[] = [
    { type: "toolCall.delta", id: "call1", name: "echo", argsDelta: "{}" },
    {
      type: "serverTool",
      block: { type: "serverTool", id: "ws1", name: "web_search", input: {}, status: "done" },
    },
  ]
  for (const ev of visible) {
    let calls = 0
    const attempt = async function* (): AsyncGenerator<StreamEvent> {
      calls++
      yield { type: "start" }
      yield ev
      await new Promise<never>(() => {})
    }
    const evs = await events(
      withRetry(attempt, new AbortController().signal, {
        retries: 2,
        baseDelayMs: 1,
        firstContentTimeoutMs: 100,
        idleTimeoutMs: 15,
      }),
    )
    expect(calls).toBe(1)
    expect(types(evs)).toEqual(["start", ev.type, "error"])
    expect(evs.at(-1)).toMatchObject({
      error: {
        code: "timeout",
        message: "model stream was idle for 15 ms. Type a message to continue, or press ↑ to resend.",
      },
    })
  }
})

test("a visible-content idle timeout after a retry retains the retry count and recovery hint", async () => {
  let calls = 0
  const attempt = async function* (): AsyncGenerator<StreamEvent> {
    calls++
    yield { type: "start" }
    if (calls === 1) {
      yield {
        type: "error",
        error: { message: "overloaded", status: 529 },
        retryable: true,
        message: { role: "assistant", content: [], model: { provider: "", model: "" }, stopReason: "error" },
      }
      return
    }
    yield { type: "text.delta", text: "partial" }
    await new Promise<never>(() => {})
  }
  const evs = await events(
    withRetry(attempt, new AbortController().signal, {
      retries: 3,
      baseDelayMs: 1,
      idleTimeoutMs: 15,
    }),
  )
  expect(calls).toBe(2)
  expect(types(evs)).toEqual(["start", "retry", "text.delta", "error"])
  expect(evs.at(-1)).toMatchObject({
    error: {
      code: "timeout",
      retries: 1,
      message: "model stream was idle for 15 ms. Type a message to continue, or press ↑ to resend.",
    },
    message: { content: [{ type: "text", text: "partial" }], stopReason: "error" },
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

test("an abort while waiting for the first content ends the attempt as aborted", async () => {
  // Like fetch, the body fails once the request's signal aborts.
  let hangingSignal: AbortSignal | undefined
  const hanging = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          hangingSignal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          )
        },
      }),
      { headers: SSE_HEADERS },
    )
  const { calls, signals, stream } = scripted(
    [
      () => {
        hangingSignal = signals.at(-1)
        return hanging()
      },
      ok,
    ],
    { retries: 1, firstContentTimeoutMs: 5_000 },
  )
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), 10)
  const evs = await stream(ctl.signal)
  expect(calls.n).toBe(1)
  expect(signals[0]?.aborted).toBe(true)
  expect(evs.at(-1)).toMatchObject({ type: "error", error: { code: "aborted" } })
})

test("a running hosted search keeps a quiet stream alive past the idle timeout", async () => {
  const block = (status: "running" | "done") =>
    ({
      type: "serverTool",
      block: { type: "serverTool", id: "ws1", name: "web_search", input: {}, status },
    }) as const
  const attempt = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: "start" }
    yield block("running")
    await Bun.sleep(40)
    yield block("done")
    yield { type: "text.delta", text: "found" }
    yield {
      type: "done",
      message: { role: "assistant", content: [], model: { provider: "", model: "" }, stopReason: "end" },
    }
  }
  const evs = await events(withRetry(attempt, new AbortController().signal, { idleTimeoutMs: 15 }))
  expect(types(evs)).toEqual(["start", "serverTool", "serverTool", "text.delta", "done"])
})
