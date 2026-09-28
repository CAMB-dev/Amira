import type { ModelError } from "../types.ts"
import { isRetryableStatus } from "./openai-chat-errors.ts"

/** Google RPC status names, for errors that carry no HTTP code. */
const STATUS_CODES: Record<string, number> = {
  INVALID_ARGUMENT: 400,
  FAILED_PRECONDITION: 400,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  RESOURCE_EXHAUSTED: 429,
  CANCELLED: 499,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
}

/** Maps a Google API error, `{code: 429, message, status: "RESOURCE_EXHAUSTED"}`. */
export function geminiError(raw: unknown): { error: ModelError; retryable: boolean } {
  if (typeof raw !== "object" || raw === null) {
    return { error: { message: typeof raw === "string" && raw ? raw : "stream error" }, retryable: false }
  }
  const e = raw as Record<string, unknown>
  const error: ModelError = {
    message: typeof e.message === "string" && e.message ? e.message : JSON.stringify(raw),
  }
  const name = typeof e.status === "string" && e.status ? e.status : undefined
  const status = typeof e.code === "number" ? e.code : name ? STATUS_CODES[name] : undefined
  if (status !== undefined) error.status = status
  if (name) error.code = name
  return { error, retryable: status !== undefined && isRetryableStatus(status) }
}
