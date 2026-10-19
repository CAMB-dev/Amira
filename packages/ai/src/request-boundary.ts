import { AsyncLocalStorage } from "node:async_hooks"
import type { Ai } from "./client.ts"

/** Host-only approval, scoped to one logical model operation, including all retries. */
export interface AiRequestBoundary {
  origin: string
}

const boundary = new AsyncLocalStorage<Readonly<AiRequestBoundary>>()
const rejected = () => new Error("Model request is outside the approved HTTP boundary")

/** Uses the injected Ai, including wrappers around createAi, without changing its public interface. */
export function withAiRequestBoundary(ai: Ai, policy: AiRequestBoundary): Ai {
  const url = new URL(policy.origin)
  if (!["https:", "http:"].includes(url.protocol) || url.origin !== policy.origin) throw rejected()
  const approved = Object.freeze({ origin: url.origin })
  const run = <T>(operation: () => T): T => {
    const parent = boundary.getStore()
    if (parent && parent.origin !== approved.origin) throw rejected()
    return boundary.run(approved, operation)
  }
  return {
    ...ai,
    stream(...args) {
      const source = run(() => ai.stream(...args))
      return {
        [Symbol.asyncIterator]() {
          const iterator = run(() => source[Symbol.asyncIterator]())
          return {
            next: (value?: unknown) => run(() => iterator.next(value)),
            ...(iterator.return ? { return: (value?: unknown) => run(() => iterator.return!(value)) } : {}),
            ...(iterator.throw ? { throw: (error?: unknown) => run(() => iterator.throw!(error)) } : {}),
          }
        },
      }
    },
    compact: (...args) => run(() => ai.compact(...args)),
  }
}

/** Applied at createAi's actual fetch dispatch, never just at metadata resolution. */
export function requestBoundaryFetch(fetcher: typeof fetch): typeof fetch {
  const captured = boundary.getStore()
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const current = boundary.getStore()
      const policy = captured ?? current
      if (!policy) return fetcher(input, init)
      if (current && current.origin !== policy.origin) throw rejected()
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin !== policy.origin || !["http:", "https:"].includes(url.protocol)) throw rejected()
      // A redirect must never get a chance to resend provider credentials to another endpoint.
      const response = await fetcher(input, { ...init, redirect: "error" })
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400) ||
        (response.url && new URL(response.url).origin !== policy.origin)
      ) {
        await response.body?.cancel().catch(() => {})
        throw rejected()
      }
      return response
    },
    { preconnect: fetcher.preconnect },
  )
}
