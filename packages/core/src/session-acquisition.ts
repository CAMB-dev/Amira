import { SessionWriteGuardError } from "./file-lock.ts"
import { SessionInUseError, type SessionStore } from "./session-store.ts"

/** Internal awaited acquisition budget; synchronous claim/Agent construction stay unchanged. */
export interface SessionAcquisitionOptions {
  signal?: AbortSignal
  /** Tests or callers may shorten, never extend, the two-second budget. */
  waitMs?: number
}

function transient(error: unknown): boolean {
  if (error instanceof SessionWriteGuardError || error instanceof SessionInUseError)
    return error.pendingOwnedCleanup
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "EPERM" || code === "EBUSY" || code === "EACCES"
}

// Only the synchronous claim attempt observes this phase; no ownership snapshots escape.
const claimPhases = new WeakMap<SessionStore, { acquired: boolean }>()

/** Internal boundary: sharing errors after authority was obtained are refresh failures. */
export function sessionClaimAcquired(store: SessionStore): void {
  const phase = claimPhases.get(store)
  if (phase) phase.acquired = true
}

/** Retains exactly one temporary ref, removed even if construction or cancellation fails. */
export function withSessionClaim<T>(
  store: SessionStore,
  construct: () => T,
  options: SessionAcquisitionOptions = {},
): T | Promise<T> {
  const waitMs = options.waitMs ?? 2000
  const deadline = performance.now() + (Number.isFinite(waitMs) ? Math.max(0, Math.min(2000, waitMs)) : 2000)
  const finish = () => {
    try {
      options.signal?.throwIfAborted()
      return construct()
    } finally {
      store.release()
    }
  }
  options.signal?.throwIfAborted()
  const blocked = attempt()
  return blocked ? wait(blocked.error).then(finish) : finish()

  function attempt(): { error: unknown } | undefined {
    const previous = claimPhases.get(store)
    const phase = { acquired: false }
    claimPhases.set(store, phase)
    try {
      store.claim()
    } catch (error) {
      if (phase.acquired || !transient(error)) throw error
      return { error }
    } finally {
      if (previous) claimPhases.set(store, previous)
      else claimPhases.delete(store)
    }
  }

  async function wait(original: unknown): Promise<void> {
    for (;;) {
      options.signal?.throwIfAborted()
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw original
      await delay(Math.min(10, remaining), options.signal)
      options.signal?.throwIfAborted()
      // Do not start another claim after expiry, even with a fixed Date.now test clock.
      if (performance.now() >= deadline) throw original
      if (!attempt()) return
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)
    function abort() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(signal!.reason)
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}
