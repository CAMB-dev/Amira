import type { ModelError } from "../types.ts"
import { bodyError, isRetryableStatus } from "./openai-chat-errors.ts"

/** Maps a stream `error` event or a failed response's `error`; known codes get a status. */
export function responsesError(raw: unknown): { error: ModelError; retryable: boolean } {
  const { error, retryable } = bodyError(raw)
  if (error.status !== undefined || !error.code) return { error, retryable }
  const status = isRetryableStatus(Number(error.code)) ? Number(error.code) : undefined
  if (status === undefined) return { error, retryable }
  return { error: { ...error, status }, retryable: isRetryableStatus(status) || retryable }
}
