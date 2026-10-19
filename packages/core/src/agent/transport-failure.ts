import type { ModelError } from "@amira/ai"

const TERMINAL_PROXY_CODES = new Set([
  "proxy_reconnect_expired",
  "proxy_broker_lost",
  "proxy_retention_expired",
])

/** Host-only convention: stream errors with these codes are network failures, never retryable. */
export function isTerminalProxyFailure(error: ModelError | undefined): error is ModelError {
  return error?.kind === "network" && !!error.code && TERMINAL_PROXY_CODES.has(error.code)
}

// An operation's signal owns its latch, not the session: a new user turn may try again.
const failures = new WeakMap<AbortSignal, ModelError>()

export function latchTransportFailure(signal: AbortSignal, error: ModelError | undefined): void {
  if (!signal.aborted && isTerminalProxyFailure(error) && !failures.has(signal)) failures.set(signal, error)
}

export function transportFailure(signal: AbortSignal): ModelError | undefined {
  return failures.get(signal)
}
