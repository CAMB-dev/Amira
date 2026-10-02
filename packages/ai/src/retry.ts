import { IDLE_TIMEOUT_HINT } from "./errors.ts"
import type { AssistantMessage, ModelRef, StreamEvent } from "./types.ts"

type ErrorEvent = Extract<StreamEvent, { type: "error" }>

export interface RetryOptions {
  /** Attempts after the first. Default 3; 0 turns retrying off. */
  retries?: number
  /** Backoff before the first retry, doubling each time. Default 1000 ms. */
  baseDelayMs?: number
  /** A Retry-After longer than this is not waited out; the error is returned instead. Default 60 s. */
  maxDelayMs?: number
  /** Maximum time to wait for the first content event. Default 150 s; 0 disables it. */
  firstContentTimeoutMs?: number
  /**
   * Maximum silence after content has streamed. Default 100 s; 0 disables it. While a hosted
   * tool (a web search the provider runs) is in progress, at least SERVER_TOOL_IDLE_MS.
   */
  idleTimeoutMs?: number
  /** Deadline for all native compaction attempts and backoff. Default 5 min; 0 disables it. */
  nativeCompactionTimeoutMs?: number
}

/** The idle limit while a hosted tool runs: the server may be quiet (pings only) the whole time. */
export const SERVER_TOOL_IDLE_MS = 600_000

// Content already streamed: sending again would repeat it. A hosted search already shown (and
// paid for) counts too: sending again would search again.
const CONTENT = new Set<StreamEvent["type"]>(["text.delta", "thinking.delta", "toolCall.delta", "serverTool"])
// A reasoning start ends the first-content wait (the model is working, silently), but nothing was
// shown or kept yet, so the attempt can still be sent again.
const ACTIVITY = new Set<StreamEvent["type"]>([...CONTENT, "thinking.start"])

/**
 * Sends a request again after a retryable failure, as long as nothing was streamed yet (D52):
 * exponential backoff, or the server's Retry-After when it gave one. Each retry is announced
 * with a retry event. An abort during the wait ends the stream with an aborted error.
 *
 * Two timers end an attempt that stalls: no content event within firstContentTimeoutMs
 * (retried like any transient failure), or silence longer than idleTimeoutMs after content
 * (not sent again: the partial reply was already shown, and a hosted search would run twice;
 * it ends with a timeout error that keeps the partial text). A reasoning start alone switches
 * to the idle timer but streams nothing, so a later failure is still retried. Keep-alives never
 * reach this layer, so they reset neither timer.
 */
export async function* withRetry(
  open: (signal: AbortSignal) => AsyncIterable<StreamEvent>,
  signal: AbortSignal,
  opts: RetryOptions = {},
  model?: ModelRef,
): AsyncGenerator<StreamEvent> {
  const retries = opts.retries ?? 3
  const base = opts.baseDelayMs ?? 1000
  const max = opts.maxDelayMs ?? 60_000
  const firstContentTimeoutMs = timeoutValue(opts.firstContentTimeoutMs, 150_000)
  const idleTimeoutMs = timeoutValue(opts.idleTimeoutMs, 100_000)
  let started = false
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) {
      yield aborted(undefined)
      return
    }
    let content = false
    let active = false
    let failed: ErrorEvent | undefined
    let partial: AssistantMessage | undefined
    const runningServerTools = new Set<string>()
    const attemptController = new AbortController()
    const abortAttempt = () => attemptController.abort()
    signal.addEventListener("abort", abortAttempt, { once: true })

    const iterator = open(attemptController.signal)[Symbol.asyncIterator]()
    let stop: (() => void) | undefined
    let timeout: Promise<{ timedOut: true }> | undefined
    let armedMs = 0
    const arm = (ms: number) => {
      armedMs = ms
      stop?.()
      if (ms <= 0) {
        timeout = undefined
        stop = undefined
        return
      }
      let timer: ReturnType<typeof setTimeout>
      timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          attemptController.abort()
          resolve({ timedOut: true })
        }, ms)
      })
      stop = () => clearTimeout(timer)
    }
    arm(firstContentTimeoutMs)

    try {
      while (true) {
        const next = iterator.next().then((result) => ({ result }))
        const outcome = timeout ? await Promise.race([next, timeout]) : await next
        if ("timedOut" in outcome) {
          void Promise.resolve(iterator.return?.()).catch(() => {})
          if (signal.aborted) {
            yield aborted(partial)
            return
          }
          const timeoutError = timeoutFailure(active, content, armedMs, model, partial)
          if (!content && attempt < retries) {
            failed = timeoutError
            break
          }
          yield attempt > 0 ? retried(timeoutError, attempt) : timeoutError
          return
        }
        const { value, done } = outcome.result
        if (done) break
        const ev = value
        if (ev.type === "start") {
          if (!started) yield ev
          started = true
          continue
        }
        if (ev.type === "error" && ev.retryable && !content && attempt < retries && !signal.aborted) {
          failed = ev
          break
        }
        if (ACTIVITY.has(ev.type)) {
          active = true
          if (CONTENT.has(ev.type)) content = true
          partial = notePartial(partial, ev, model)
          if (ev.type === "serverTool") {
            if (ev.block.status === "running") runningServerTools.add(ev.block.id)
            else runningServerTools.delete(ev.block.id)
          }
          arm(
            runningServerTools.size && idleTimeoutMs > 0
              ? Math.max(idleTimeoutMs, SERVER_TOOL_IDLE_MS)
              : idleTimeoutMs,
          )
        }
        // The final failure says how often it was retried.
        yield ev.type === "error" && attempt > 0 && ev.error.code !== "aborted" ? retried(ev, attempt) : ev
      }
    } finally {
      stop?.()
      if (!signal.aborted) attemptController.abort()
      if (failed) void Promise.resolve(iterator.return?.()).catch(() => {})
      signal.removeEventListener("abort", abortAttempt)
    }
    if (!failed) return
    const delayMs = failed.retryAfterMs ?? base * 2 ** attempt
    if (delayMs > max) {
      yield attempt > 0 ? retried(failed, attempt) : failed
      return
    }
    yield { type: "retry", attempt: attempt + 1, maxRetries: retries, delayMs, error: failed.error }
    if (!(await sleep(delayMs, signal))) {
      yield {
        type: "error",
        error: { message: "aborted", code: "aborted" },
        retryable: false,
        message: { ...failed.message, stopReason: "aborted" },
      }
      return
    }
  }
}

const timeoutValue = (value: number | undefined, fallback: number) =>
  value === undefined ? fallback : Math.max(0, Math.floor(value))

function notePartial(
  partial: AssistantMessage | undefined,
  ev: StreamEvent,
  model: ModelRef | undefined,
): AssistantMessage | undefined {
  if (ev.type !== "text.delta" && ev.type !== "thinking.delta") return partial
  const base =
    partial ??
    ({
      role: "assistant",
      content: [],
      model: model ?? { provider: "", model: "" },
      stopReason: "error",
    } satisfies AssistantMessage)
  const last = base.content.at(-1)
  if (ev.type === "text.delta" && last?.type === "text") {
    return {
      ...base,
      content: [...base.content.slice(0, -1), { ...last, text: last.text + ev.text }],
    }
  }
  if (ev.type === "thinking.delta" && last?.type === "thinking") {
    return {
      ...base,
      content: [...base.content.slice(0, -1), { ...last, text: last.text + ev.text }],
    }
  }
  return {
    ...base,
    content: [
      ...base.content,
      ev.type === "text.delta" ? { type: "text", text: ev.text } : { type: "thinking", text: ev.text },
    ],
  }
}

function timeoutFailure(
  hadActivity: boolean,
  hadContent: boolean,
  timeoutMs: number,
  model: ModelRef | undefined,
  lastMessage: AssistantMessage | undefined,
): ErrorEvent {
  const message = hadActivity
    ? `model stream was idle for ${timeoutMs} ms`
    : `model produced no content within ${timeoutMs} ms`
  const hint = hadContent ? `. ${IDLE_TIMEOUT_HINT}` : ""
  return {
    type: "error",
    error: { message: message + hint, code: "timeout", status: 408 },
    retryable: true,
    message:
      lastMessage ??
      ({
        role: "assistant",
        content: [],
        model: model ?? { provider: "", model: "" },
        stopReason: "error",
      } satisfies AssistantMessage),
  }
}

function aborted(lastMessage: AssistantMessage | undefined): ErrorEvent {
  return {
    type: "error",
    error: { message: "aborted", code: "aborted" },
    retryable: false,
    message: lastMessage
      ? { ...lastMessage, stopReason: "aborted" }
      : { role: "assistant", content: [], model: { provider: "", model: "" }, stopReason: "aborted" },
  }
}

function retried(ev: ErrorEvent, retries: number): ErrorEvent {
  return { ...ev, error: { ...ev.error, retries } }
}

/** Resolves true after ms, or false as soon as the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const done = (ok: boolean) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve(ok)
    }
    const onAbort = () => done(false)
    const timer = setTimeout(() => done(true), ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
