import type { ModelError } from "../types.ts"

export const isRetryableStatus = (status: number) => status === 429 || status >= 500

/** Provider body errors that mean the service may succeed when the same request is retried. */
export function isRetryableBodyError(error: ModelError): boolean {
  const text = `${error.code ?? ""} ${error.message}`.replace(/[_-]+/g, " ")
  return /(?:\btimeout\b|\btimed?\s*out\b|\boverload(?:ed|ing)?\b|unable\s+to\s+start\s+processing)/i.test(
    text,
  )
}

const CODE_STATUS: Record<string, number> = {
  rate_limit_exceeded: 429,
  server_error: 500,
  internal_error: 500,
  server_is_overloaded: 503,
  overloaded: 503,
  overloaded_error: 529,
  service_unavailable: 503,
  timeout: 504,
  timeout_error: 504,
}

/** Reads an `error` field from a response body or stream chunk; servers send a string or an object. */
export function bodyError(raw: unknown): { error: ModelError; retryable: boolean } {
  if (typeof raw !== "object" || raw === null) {
    const error = { message: typeof raw === "string" && raw ? raw : "stream error" }
    return { error, retryable: isRetryableBodyError(error) }
  }
  const e = raw as Record<string, unknown>
  const error: ModelError = {
    message: typeof e.message === "string" && e.message ? e.message : JSON.stringify(raw),
  }
  const code = e.code ?? e.type
  const name = codeName(e)
  const status = asStatus(e.status) ?? asStatus(e.code) ?? (name ? CODE_STATUS[name] : undefined)
  if (status !== undefined) error.status = status
  if ((typeof code === "string" && code) || typeof code === "number") error.code = String(code)
  return {
    error,
    retryable: (status !== undefined && isRetryableStatus(status)) || isRetryableBodyError(error),
  }
}

function codeName(e: Record<string, unknown>): string | undefined {
  const code = e.code ?? e.type
  return typeof code === "string" && code ? code : undefined
}

function asStatus(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{3}$/.test(v) ? Number(v) : Number.NaN
  return n >= 100 && n <= 599 ? n : undefined
}
