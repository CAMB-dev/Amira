import type { StreamEvent } from "../types.ts"

const NUMBER = /^\d+(\.\d+)?$/

/**
 * How long a response asks the client to wait: `retry-after-ms`, or `Retry-After` in seconds
 * or as an HTTP date. Undefined when absent or unreadable.
 */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get("retry-after-ms")?.trim()
  if (ms && NUMBER.test(ms)) return Math.round(Number(ms))
  const v = headers.get("retry-after")?.trim()
  if (!v) return undefined
  if (NUMBER.test(v)) return Math.round(Number(v) * 1000)
  const at = Date.parse(v)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/** Copies the response's Retry-After onto an error event. */
export function withRetryAfter(ev: StreamEvent, headers: Headers): StreamEvent {
  if (ev.type !== "error") return ev
  const ms = retryAfterMs(headers)
  return ms === undefined ? ev : { ...ev, retryAfterMs: ms }
}
