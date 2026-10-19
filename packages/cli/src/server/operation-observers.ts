import { RemoteError } from "../remote/errors.ts"
import { REMOTE_LIMITS } from "../remote/protocol.ts"

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }
interface Observation {
  outcome?: Outcome
  listeners: Set<(outcome: Outcome) => void>
}

/** One settlement reaction per ledger promise; transport waiters are bounded and detachable.
 * Aborting a waiter removes its references immediately, never cancels workspace execution.
 */
export class OperationObservers {
  #observations = new WeakMap<Promise<unknown>, Observation>()

  wait<T>(source: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new RemoteError("cancelled", "Transport observation ended"))
    let observation = this.#observations.get(source)
    if (!observation) {
      observation = { listeners: new Set() }
      this.#observations.set(source, observation)
      const state = observation
      const settle = (outcome: Outcome) => {
        state.outcome = outcome
        for (const listener of state.listeners) listener(outcome)
        state.listeners.clear()
      }
      void source.then(
        (value) => settle({ ok: true, value }),
        (error: unknown) => settle({ ok: false, error }),
      )
    }
    const state = observation
    if (state.outcome)
      return state.outcome.ok
        ? Promise.resolve(state.outcome.value as T)
        : Promise.reject(state.outcome.error)
    if (state.listeners.size >= REMOTE_LIMITS.pendingRequests)
      return Promise.reject(new RemoteError("limit_exceeded", "Too many operation observers"))
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        state.listeners.delete(deliver)
        signal.removeEventListener("abort", abort)
      }
      const deliver = (outcome: Outcome) => {
        cleanup()
        if (outcome.ok) resolve(outcome.value as T)
        else reject(outcome.error)
      }
      const abort = () => {
        cleanup()
        reject(new RemoteError("cancelled", "Transport observation ended"))
      }
      state.listeners.add(deliver)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}
