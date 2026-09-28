import type { Intercept, InterceptContext, InterceptorMap, InterceptorOptions } from "@amira/api"

type Handler<K extends keyof InterceptorMap> = (
  value: InterceptorMap[K],
  ctx: InterceptContext,
) => Intercept<InterceptorMap[K]> | Promise<Intercept<InterceptorMap[K]>>

interface Entry {
  handler: Handler<any>
  priority: number
  order: number
  timeoutMs: number
  source: string
}

/** What happens when a handler throws or times out. */
export type FailurePolicy = "pass" | "block"

export const FAILURE_POLICY: Record<keyof InterceptorMap, FailurePolicy> = {
  "context.build": "pass",
  "tool.call.before": "block",
}

export type InterceptOutcome<T> = { blocked: false; value: T } | { blocked: true; reason: string; value: T }

export class InterceptorRegistry {
  #entries = new Map<string, Entry[]>()
  #order = 0
  #defaultTimeoutMs: number
  #onError: (point: string, source: string, error: string) => void

  constructor(
    opts: {
      defaultTimeoutMs?: number
      onError?: (point: string, source: string, error: string) => void
    } = {},
  ) {
    this.#defaultTimeoutMs = opts.defaultTimeoutMs ?? 5000
    this.#onError = opts.onError ?? (() => {})
  }

  add<K extends keyof InterceptorMap>(
    point: K,
    handler: Handler<K>,
    opts: InterceptorOptions = {},
    source = "unknown",
  ): () => void {
    const list = this.#entries.get(point) ?? []
    const entry: Entry = {
      handler,
      priority: opts.priority ?? 0,
      order: this.#order++,
      timeoutMs: opts.timeoutMs ?? this.#defaultTimeoutMs,
      source,
    }
    list.push(entry)
    list.sort((a, b) => a.priority - b.priority || a.order - b.order)
    this.#entries.set(point, list)
    return () => {
      const l = this.#entries.get(point)
      if (l)
        this.#entries.set(
          point,
          l.filter((e) => e !== entry),
        )
    }
  }

  /** Runs handlers in order. modify feeds the next handler; block stops the pipeline. */
  async run<K extends keyof InterceptorMap>(
    point: K,
    value: InterceptorMap[K],
    ctx: InterceptContext,
  ): Promise<InterceptOutcome<InterceptorMap[K]>> {
    let current = value
    for (const entry of this.#entries.get(point) ?? []) {
      let result: Intercept<InterceptorMap[K]>
      try {
        result = await withTimeout(Promise.resolve(entry.handler(current, ctx)), entry.timeoutMs)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.#onError(point, entry.source, msg)
        if (FAILURE_POLICY[point] === "block") {
          return { blocked: true, reason: `interceptor from ${entry.source} failed: ${msg}`, value: current }
        }
        continue
      }
      if (result.action === "block") return { blocked: true, reason: result.reason, value: current }
      if (result.action === "modify") current = result.value
    }
    return { blocked: false, value: current }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
