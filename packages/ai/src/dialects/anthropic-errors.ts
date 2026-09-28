import type { ModelError } from "../types.ts"
import { isRetryableStatus } from "./openai-chat-errors.ts"

export { isRetryableStatus }

/** HTTP status behind each documented error type, so in-stream errors retry like HTTP ones. */
const STATUS_BY_TYPE: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
}

/** Reads `{type: "error", error: {type, message}}`, the shape of both error bodies and stream events. */
export function anthropicError(raw: unknown, status?: number): { error: ModelError; retryable: boolean } {
  const e = (raw && typeof raw === "object" ? (raw as any).error : undefined) ?? raw
  const type = typeof e?.type === "string" && e.type ? e.type : undefined
  const message =
    typeof e?.message === "string" && e.message
      ? e.message
      : typeof e === "string" && e
        ? e
        : JSON.stringify(raw)
  const error: ModelError = { message }
  const st = status ?? (type ? STATUS_BY_TYPE[type] : undefined)
  if (st !== undefined) error.status = st
  if (type) error.code = type
  return { error, retryable: st !== undefined && isRetryableStatus(st) }
}
