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
  "system.build": "pass",
  "compact.before": "pass",
}

/** `ask` holds the reasons of handlers that want the call approved (tool.call.before only). */
export type InterceptOutcome<T> =
  | { blocked: false; value: T; ask?: string[] }
  | { blocked: true; reason: string; value: T }

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

  /**
   * Runs handlers in order. modify feeds the next handler; block stops the pipeline.
   * Each handler gets a signal that fires on turn abort or on its own timeout.
   */
  async run<K extends keyof InterceptorMap>(
    point: K,
    value: InterceptorMap[K],
    ctx: InterceptContext,
  ): Promise<InterceptOutcome<InterceptorMap[K]>> {
    const blocksOnFailure = FAILURE_POLICY[point] === "block"
    let current = value
    const ask: string[] = []
    for (const entry of this.#entries.get(point) ?? []) {
      if (ctx.signal.aborted) {
        return blocksOnFailure
          ? { blocked: true, reason: "aborted", value: current }
          : { blocked: false, value: current }
      }
      let result: Intercept<InterceptorMap[K]>
      try {
        result = await runHandler(entry, current, ctx)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.#onError(point, entry.source, msg)
        if (blocksOnFailure) {
          return { blocked: true, reason: `interceptor from ${entry.source} failed: ${msg}`, value: current }
        }
        continue
      }
      if (result.action === "block") return { blocked: true, reason: result.reason, value: current }
      if (result.action === "modify") current = result.value
      if (result.action === "ask" && point === "tool.call.before") ask.push(result.reason)
    }
    return ask.length ? { blocked: false, value: current, ask } : { blocked: false, value: current }
  }
}

/** Races the handler against its timeout and the turn's abort signal. */
async function runHandler<T>(entry: Entry, value: T, ctx: InterceptContext): Promise<Intercept<T>> {
  const own = new AbortController()
  const signal = AbortSignal.any([ctx.signal, own.signal])
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      own.abort()
      reject(new Error(`timed out after ${entry.timeoutMs} ms`))
    }, entry.timeoutMs)
    onAbort = () => reject(new Error("aborted"))
    ctx.signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve(entry.handler(value, { ...ctx, signal })), stop])
  } finally {
    clearTimeout(timer)
    if (onAbort) ctx.signal.removeEventListener("abort", onAbort)
  }
}
