export interface ShutdownActions {
  stopResources(): Promise<void>
  removeFiles(): Promise<void>
  stopServer(deferred: boolean): void
  reportFailure?(error: unknown): void
  exhausted?(error: unknown): void
  retryMs?: number
  retryWindowMs?: number
}

/** Resource teardown is once-only; filesystem cleanup is retryable and has a hard deadline. */
export function createShutdown(actions: ShutdownActions) {
  let resources: Promise<void> | undefined
  let pending: Promise<void> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let completed = false
  let expired = false
  let lastError: unknown

  function cancelTimers() {
    if (retry) clearTimeout(retry)
    if (deadline) clearTimeout(deadline)
    retry = undefined
    deadline = undefined
  }

  function failed(error: unknown) {
    lastError = error
    actions.reportFailure?.(error)
    if (expired) return
    deadline ??= setTimeout(() => {
      expired = true
      cancelTimers()
      actions.stopServer(false)
      actions.exhausted?.(lastError)
    }, actions.retryWindowMs ?? 5000)
    retry = setTimeout(() => {
      retry = undefined
      void close().catch(() => {}) // The failure is reported and its next retry is bounded above.
    }, actions.retryMs ?? 1000)
  }

  function close(deferred = false, removeFiles = true): Promise<void> {
    if (completed) return Promise.resolve()
    if (pending) return pending
    if (retry) clearTimeout(retry)
    retry = undefined
    const attempt = (async () => {
      try {
        resources ??= actions.stopResources()
        await resources
        if (removeFiles) await actions.removeFiles()
      } finally {
        // In particular, rm/EBUSY must never leave the command port serving indefinitely.
        actions.stopServer(deferred)
      }
    })()
    pending = attempt.then(
      () => {
        pending = undefined
        if (removeFiles) {
          completed = true
          cancelTimers()
        }
      },
      (error) => {
        pending = undefined // Never retain a rejection: a later stop must get a fresh removal attempt.
        if (removeFiles) failed(error)
        throw error
      },
    )
    return pending
  }

  return { close }
}
