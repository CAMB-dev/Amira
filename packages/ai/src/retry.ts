import type { StreamEvent } from "./types.ts"

type ErrorEvent = Extract<StreamEvent, { type: "error" }>

export interface RetryOptions {
  /** Attempts after the first. Default 3; 0 turns retrying off. */
  retries?: number
  /** Backoff before the first retry, doubling each time. Default 1000 ms. */
  baseDelayMs?: number
  /** A Retry-After longer than this is not waited out; the error is returned instead. Default 60 s. */
  maxDelayMs?: number
}

// A hosted search already shown (and paid for) counts too: sending again would search again.
const CONTENT = new Set<StreamEvent["type"]>(["text.delta", "thinking.delta", "toolCall.delta", "serverTool"])

/**
 * Sends a request again after a retryable failure, as long as nothing was streamed yet (D52):
 * exponential backoff, or the server's Retry-After when it gave one. Each retry is announced
 * with a retry event. An abort during the wait ends the stream with an aborted error.
 */
export async function* withRetry(
  open: () => AsyncIterable<StreamEvent>,
  signal: AbortSignal,
  opts: RetryOptions = {},
): AsyncGenerator<StreamEvent> {
  const retries = opts.retries ?? 3
  const base = opts.baseDelayMs ?? 1000
  const max = opts.maxDelayMs ?? 60_000
  let started = false
  for (let attempt = 0; ; attempt++) {
    let content = false
    let failed: ErrorEvent | undefined
    for await (const ev of open()) {
      if (ev.type === "start") {
        if (!started) yield ev
        started = true
        continue
      }
      if (ev.type === "error" && ev.retryable && !content && attempt < retries && !signal.aborted) {
        failed = ev
        break
      }
      if (CONTENT.has(ev.type)) content = true
      // The final failure says how often it was retried.
      yield ev.type === "error" && attempt > 0 && ev.error.code !== "aborted" ? retried(ev, attempt) : ev
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

function retried(ev: ErrorEvent, retries: number): ErrorEvent {
  return { ...ev, error: { ...ev.error, retries } }
}

/** Resolves true after ms, or false as soon as the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
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
