import type { CompactionLayout } from "./dialect.ts"
import type { Signature, Usage } from "./types.ts"

/**
 * Ways of server-side compaction found not to work, by endpoint key ("provider host model")
 * and method, with when each failed (ms since the epoch).
 */
export type RememberedFailures = Record<string, Record<string, number>>

/** Where remembered failures live between runs (e.g. a file in the user directory). */
export interface CompactionMemory {
  load(): RememberedFailures
  save(failures: RememberedFailures): void
}

/** How long a failed way is skipped: a proxy may learn it meanwhile. */
export const FORGET_FAILURE_MS = 7 * 24 * 3600_000

/** Server-side compaction a model's provider offers now (Ai.nativeCompaction). */
export interface NativeCompaction {
  dialect: string
  /** Ways still worth trying, in order. */
  methods: string[]
  layouts: CompactionLayout[]
  /** See DialectCompaction.midTurn. */
  midTurn: boolean
}

/** One way that was tried and failed. */
export interface CompactAttempt {
  method: string
  error: string
  /** The endpoint does not do it this way; it is skipped from now on. */
  unsupported: boolean
}

/** What Ai.compact came to. `usage` counts every attempt, with its cost when prices are known. */
export type CompactResult =
  | {
      ok: true
      /** The checkpoint, to be carried by the summary messages (Signature.kind "checkpoint"). */
      checkpoint: Signature
      /** Readable summary text, when the server gives one. */
      summary?: string
      usage: Usage
      /** At least one attempt did not report usage. */
      usageIncomplete?: boolean
      method: string
      /** Ways that failed before this one worked. */
      tried: CompactAttempt[]
    }
  | {
      ok: false
      error: string
      usage: Usage
      usageIncomplete?: boolean
      tried: CompactAttempt[]
      aborted?: boolean
      timedOut?: boolean
    }

/**
 * Remembers ways of compacting that an endpoint does not support: for the rest of the
 * process, and in `memory` when given, so later runs skip them too until FORGET_FAILURE_MS.
 * A memory that fails to load or save is left alone: it only saves a wasted attempt.
 */
export class CompactionFailures {
  readonly #memory: CompactionMemory | undefined
  readonly #now: () => number
  #data: RememberedFailures | undefined

  constructor(memory?: CompactionMemory, now: () => number = Date.now) {
    this.#memory = memory
    this.#now = now
  }

  /** Methods to skip for this endpoint key. */
  skipped(key: string): Set<string> {
    const at = this.#load()[key] ?? {}
    const fresh = this.#now() - FORGET_FAILURE_MS
    return new Set(Object.entries(at).flatMap(([m, t]) => (typeof t === "number" && t > fresh ? [m] : [])))
  }

  remember(key: string, method: string): void {
    const data = this.#load()
    const at = Object.hasOwn(data, key) ? data[key]! : {}
    at[method] = this.#now()
    data[key] = at
    try {
      this.#memory?.save(data)
    } catch {}
  }

  #load(): RememberedFailures {
    if (this.#data) return this.#data
    let loaded: unknown
    try {
      loaded = this.#memory?.load()
    } catch {}
    const data: RememberedFailures = Object.create(null)
    if (loaded && typeof loaded === "object") {
      for (const [key, methods] of Object.entries(loaded)) {
        if (methods && typeof methods === "object") data[key] = { ...(methods as Record<string, number>) }
      }
    }
    this.#data = data
    return data
  }
}

/** The key failures are remembered under. */
export function endpointKey(provider: string, host: string, model: string): string {
  return `${provider} ${host} ${model}`
}

/**
 * Whether a failed compaction request says the endpoint does not do it that way: no such
 * route (404, 405, 501), or a request rejected (400, 422) for a field or item it does not know.
 * Other failures (auth, rate limits, server errors, a context overflow) say nothing about it.
 */
export function isUnsupportedCompaction(status: number | undefined, message: string): boolean {
  if (status === 404 || status === 405 || status === 501) return true
  if (status !== 400 && status !== 422) return false
  return /compact|unsupported|not supported|unknown|unrecognized|invalid (value|type|parameter)|extra inputs|not permitted/i.test(
    message,
  )
}
