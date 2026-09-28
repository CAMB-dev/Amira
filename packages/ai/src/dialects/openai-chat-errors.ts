import type { ModelError } from "../types.ts"

export const isRetryableStatus = (status: number) => status === 429 || status >= 500

/** Reads an `error` field from a response body or stream chunk; servers send a string or an object. */
export function bodyError(raw: unknown): { error: ModelError; retryable: boolean } {
  if (typeof raw !== "object" || raw === null) {
    return { error: { message: typeof raw === "string" && raw ? raw : "stream error" }, retryable: false }
  }
  const e = raw as Record<string, unknown>
  const error: ModelError = {
    message: typeof e.message === "string" && e.message ? e.message : JSON.stringify(raw),
  }
  const status = asStatus(e.status) ?? asStatus(e.code)
  if (status !== undefined) error.status = status
  const code = e.code ?? e.type
  if ((typeof code === "string" && code) || typeof code === "number") error.code = String(code)
  return { error, retryable: status !== undefined && isRetryableStatus(status) }
}

function asStatus(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{3}$/.test(v) ? Number(v) : Number.NaN
  return n >= 100 && n <= 599 ? n : undefined
}
