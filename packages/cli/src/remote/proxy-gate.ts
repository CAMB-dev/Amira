import type { ModelError } from "@amira/ai"

export const PROXY_RECONNECT_TIMEOUT_MS = 10 * 60_000

/** Admission is separate from provider deadlines; disconnect never aborts a turn signal. */
export class ProxyGate<T> {
  private peer?: T
  private waiters = new Set<() => void>()
  private failures = new WeakMap<AbortSignal, ModelError>()

  constructor(readonly timeoutMs = PROXY_RECONNECT_TIMEOUT_MS) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new RangeError("Proxy reconnect timeout must be a positive safe integer")
  }

  attach(peer: T): void {
    this.peer = peer
    for (const wake of this.waiters) wake()
  }

  detach(peer: T): void {
    if (this.peer === peer) this.peer = undefined
  }

  latch(error: ModelError, signal?: AbortSignal): ModelError {
    if (signal && !signal.aborted) this.failures.set(signal, error)
    return error
  }

  async wait(signal?: AbortSignal, scope = signal): Promise<T> {
    const failure = scope && this.failures.get(scope)
    if (failure) throw failure
    if (signal?.aborted) throw proxyFailure("proxy_cancelled")
    if (this.peer) return this.peer
    return new Promise<T>((resolve, reject) => {
      const finish = (error?: ModelError) => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        signal?.removeEventListener("abort", abort)
        if (error) reject(error)
        else resolve(this.peer!)
      }
      const wake = () => {
        if (this.peer) finish()
      }
      const abort = () => finish(proxyFailure("proxy_cancelled"))
      const timer = setTimeout(
        () => finish(this.latch(proxyFailure("proxy_reconnect_expired"), scope)),
        this.timeoutMs,
      )
      this.waiters.add(wake)
      signal?.addEventListener("abort", abort, { once: true })
    })
  }
}

export function proxyFailure(code: string): ModelError {
  return {
    code,
    kind: "network",
    message: code === "proxy_cancelled" ? "Model request cancelled" : "The local model broker is unavailable",
  }
}
