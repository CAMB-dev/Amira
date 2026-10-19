import { RemoteError, RemoteReplyError } from "../remote/errors.ts"
import type { RemoteJson } from "../remote/protocol.ts"
import { copyRemoteJson } from "../remote/schema/json.ts"

export interface OperationScope {
  clientId: string
  /** The lease token, not the connection's changing controllerGeneration. */
  controllerToken: string
}

export interface OperationLedgerOptions {
  /** Maximum running plus retained completed entries. Defaults to 128. */
  maxEntries?: number
  /** Maximum distinct scoped ids for this ledger's entire lifetime. Defaults to 4,096. */
  maxIds?: number
  /** Result/error retention measured from settlement. Defaults to ten minutes. */
  retentionMs?: number
  /** Maximum canonical UTF-8 payload bytes per retained entry. Defaults to 64 MiB. */
  maxPayloadBytes?: number
  /** Maximum running/retained payload plus terminal JSON bytes. Defaults to 32 MiB. */
  maxBytes?: number
  now?: () => number
}

interface RetainedEntry {
  canonical: string
  bytes: number
  promise: Promise<unknown>
  /** Undefined until settlement: running operations cannot expire. */
  expiresAt?: number
}

const identifier = /^[a-zA-Z0-9_.:-]+$/
// A single fixed failure needs no per-entry byte reservation, even at a completely full budget.
// Entry/id limits bound references to this failure and permanent expiry tombstones.
const terminalLimit = Object.freeze(
  new RemoteError("limit_exceeded", "Operation terminal value limit exceeded"),
)
const errorPrototypes = new Set([
  Error.prototype,
  TypeError.prototype,
  RangeError.prototype,
  SyntaxError.prototype,
  ReferenceError.prototype,
  EvalError.prototype,
  URIError.prototype,
  RemoteError.prototype,
  RemoteReplyError.prototype,
])

function validateIdentity(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !identifier.test(value))
    throw new RemoteError("invalid_frame", "Invalid operation scope or id")
}

/** The input is an inert copy. Canonicalize and freeze it before handing it to an effect. */
function canonicalJson(value: RemoteJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  Object.freeze(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`
}

/**
 * Host-internal at-most-once admission for one daemon/workspace lifetime.
 *
 * Call Controller.assertCurrent before run, including retries. Keep the same scope across
 * reconnects and include the operation name and every semantic input in payload; transport
 * request ids and controller generations do not belong in that payload. The callback receives
 * the admitted immutable JSON snapshot, avoiding mutation between acceptance and execution.
 * Successful results are likewise retained as immutable JSON snapshots so they cannot grow later.
 *
 * Expired entries become small permanent tombstones, never reusable ids. Payload/terminal bytes,
 * result entries and total ids are bounded; exhaustion refuses new work rather than evicting
 * running work or forgetting an accepted id. There is deliberately no clear/reset API: create a
 * new ledger only with a new daemon epoch, not on reconnect or session changes. This is not crash persistence.
 */
export class OperationLedger {
  private readonly entries = new Map<string, RetainedEntry | null>()
  private retained = 0
  private bytes = 0
  private lastTime = 0
  private readonly maxEntries: number
  private readonly maxIds: number
  private readonly retentionMs: number
  private readonly maxPayloadBytes: number
  private readonly maxBytes: number
  private readonly clock: () => number

  constructor(options: OperationLedgerOptions = {}) {
    this.maxEntries = options.maxEntries ?? 128
    this.maxIds = options.maxIds ?? 4_096
    this.retentionMs = options.retentionMs ?? 10 * 60 * 1_000
    this.maxPayloadBytes = options.maxPayloadBytes ?? 64 * 1024 * 1024
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024
    this.clock = options.now ?? Date.now
    for (const value of [this.maxEntries, this.maxIds, this.maxPayloadBytes, this.maxBytes]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError("Operation ledger limits must be positive safe integers")
    }
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 0)
      throw new RangeError("Operation retention must be a nonnegative safe integer")
  }

  /** Admission failures reject; a retained retry returns the exact original promise. */
  run<T>(
    scope: OperationScope,
    id: string,
    payload: unknown,
    execute: (accepted: RemoteJson) => T | PromiseLike<T>,
  ): Promise<T> {
    try {
      const { clientId, controllerToken } = scope
      validateIdentity(clientId)
      validateIdentity(controllerToken)
      validateIdentity(id)
      if (typeof execute !== "function")
        throw new RemoteError("invalid_frame", "An operation executor is required")
      // Tuple encoding prevents collisions between ids containing valid separator characters.
      const key = JSON.stringify([clientId, controllerToken, id])
      this.prune()
      if (this.entries.get(key) === null)
        throw new RemoteReplyError("operation_expired", "The accepted operation result is no longer retained")
      const accepted = copyRemoteJson(payload)
      const canonical = canonicalJson(accepted)
      const payloadBytes = Buffer.byteLength(canonical, "utf8")
      if (payloadBytes > this.maxPayloadBytes)
        throw new RemoteError("limit_exceeded", "Operation payload limit exceeded")
      // Snapshotting proxies can reenter admission through their descriptor traps. Observe
      // the current slot only after the snapshot, rather than overwriting a nested admission.
      const previous = this.entries.get(key)
      if (previous === null)
        throw new RemoteReplyError("operation_expired", "The accepted operation result is no longer retained")
      if (previous) {
        if (previous.canonical !== canonical)
          throw new RemoteReplyError(
            "operation_conflict",
            "The operation id was accepted with another payload",
          )
        return previous.promise as Promise<T>
      }
      if (
        this.retained >= this.maxEntries ||
        this.entries.size >= this.maxIds ||
        payloadBytes > this.maxBytes - this.bytes
      )
        throw new RemoteError("limit_exceeded", "Operation ledger capacity exhausted")

      // Install acceptance before invoking even synchronous/reentrant effects. Start in this
      // stack so transport EOF cannot revoke already admitted frontend work in a microtask gap.
      let resolve!: (value: T | PromiseLike<T>) => void
      let reject!: (error: unknown) => void
      const pending = new Promise<T>((accept, fail) => {
        resolve = accept
        reject = fail
      })
      const entry: RetainedEntry = {
        canonical,
        bytes: payloadBytes,
        promise: pending
          .then(
            (value) => this.retainTerminal(entry, value, false),
            (error) => {
              throw this.retainTerminal(entry, error, true)
            },
          )
          .finally(() => {
            entry.expiresAt = Math.min(Number.MAX_SAFE_INTEGER, this.now() + this.retentionMs)
          }),
      }
      this.entries.set(key, entry)
      this.retained++
      this.bytes += payloadBytes
      try {
        resolve(execute(accepted))
      } catch (error) {
        reject(error)
      }
      // A lost transport may never observe its rejected result. Retain the original rejected
      // promise without turning it into a success or producing an unhandled-rejection event.
      void entry.promise.catch(() => {})
      return entry.promise as Promise<T>
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** Release expired payloads/results; retain their bounded no-reexecution tombstones. */
  prune(): number {
    const now = this.now()
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (entry?.expiresAt !== undefined && now >= entry.expiresAt) {
        this.entries.set(key, null)
        this.retained--
        this.bytes -= entry.bytes
        removed++
      }
    }
    return removed
  }

  /** Retain inert JSON results or simple immutable errors, never arbitrary object graphs. */
  private retainTerminal(entry: RetainedEntry, value: unknown, failure: boolean): unknown {
    try {
      let retained: unknown
      let canonical: string
      if (failure && value instanceof Error) {
        if (!errorPrototypes.has(Object.getPrototypeOf(value))) throw terminalLimit
        const fields: Record<string, unknown> = Object.create(null)
        for (const key of Reflect.ownKeys(value)) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)
          if (
            typeof key !== "string" ||
            !descriptor ||
            !Object.hasOwn(descriptor, "value") ||
            (descriptor.value !== null && ["object", "function"].includes(typeof descriptor.value))
          )
            throw terminalLimit
          fields[key] = descriptor.value
        }
        canonical = canonicalJson(copyRemoteJson(fields))
        // Preserve ordinary Error identity while preventing later growth through caller mutation.
        retained = Object.freeze(value)
      } else {
        retained = copyRemoteJson(value)
        canonical = canonicalJson(retained as RemoteJson)
      }
      const bytes = Buffer.byteLength(canonical, "utf8")
      if (bytes > this.maxBytes - this.bytes) throw terminalLimit
      entry.bytes += bytes
      this.bytes += bytes
      return retained
    } catch {
      // Do not retain an oversized result, exception graph, or serialization failure. Its
      // canonical payload stays reserved so retries still conflict/replay without reexecution.
      throw terminalLimit
    }
  }

  private now(): number {
    const value = this.clock()
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError("Operation ledger clock must return a nonnegative safe integer")
    this.lastTime = Math.max(this.lastTime, value)
    return this.lastTime
  }
}
