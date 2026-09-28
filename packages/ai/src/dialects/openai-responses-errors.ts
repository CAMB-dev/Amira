import type { ModelError } from "../types.ts"
import { bodyError, isRetryableStatus } from "./openai-chat-errors.ts"

/** Error codes the Responses API reports in the stream without an HTTP status. */
const CODE_STATUS: Record<string, number> = {
  rate_limit_exceeded: 429,
  server_error: 500,
  internal_error: 500,
  server_is_overloaded: 503,
  overloaded: 503,
  service_unavailable: 503,
  timeout: 504,
}

/** Maps a stream `error` event or a failed response's `error`; known codes get a status. */
export function responsesError(raw: unknown): { error: ModelError; retryable: boolean } {
  const { error, retryable } = bodyError(raw)
  if (error.status !== undefined || !error.code) return { error, retryable }
  const status = CODE_STATUS[error.code]
  if (status === undefined) return { error, retryable }
  return { error: { ...error, status }, retryable: isRetryableStatus(status) }
}
