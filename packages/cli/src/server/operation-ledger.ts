import { createHash } from "node:crypto"
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
  /** Most recently admitted ids remembered per scope after their results are gone. Defaults to 4,096. */
  windowIds?: number
  /** Maximum remembered ids across all scopes before whole idle scopes are forgotten. Defaults to 65,536. */
  maxIds?: number
  /** A scope with no admission or settlement for this long is forgotten. Defaults to 24 hours. */
  idleScopeMs?: number
  /** Forgotten scopes refused before the oldest is dropped. Defaults to 65,536. */
  maxForgotten?: number
  /** Result/error retention measured from settlement. Defaults to ten minutes. */
  retentionMs?: number
  /** Maximum canonical UTF-8 payload bytes per retained entry. Defaults to 64 MiB. */
  maxPayloadBytes?: number
  /** Maximum running/retained payload plus terminal JSON bytes. Defaults to 32 MiB. */
  maxBytes?: number
  /** A clientId that may still resend (attached or in grace) is never forgotten. */
  inUse?: (clientId: string) => boolean
  now?: () => number
}

interface LiveEntry {
  key: string
  hash: string
  scope: ScopeState
  canonical: string
  bytes: number
  promise: Promise<unknown>
  /** Undefined until settlement: running operations cannot expire or be evicted. */
  expiresAt?: number
  /** The terminal value did not fit: the caller has it, a later resend gets operation_expired. */
  unretained?: boolean
}

interface ScopeState {
  key: string
  clientId: string
  /** Admission order; null marks an id whose result is gone (a tombstone). */
  window: Map<string, LiveEntry | null>
  running: number
  lastActive: number
}

const identifier = /^[a-zA-Z0-9_.:-]+$/
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
const expired = () =>
  new RemoteReplyError("operation_expired", "The accepted operation result is no longer retained")
const forgotten = () => new RemoteReplyError("permission_denied", "Controller reconnect credentials expired")
// 128 bits of SHA-256: a collision can only make a new id look like an expired retry.
const digest = (value: string) => createHash("sha256").update(value).digest().toString("latin1", 0, 16)

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
 * Every structure is bounded. Settled results are retained for retentionMs, or tombstoned
 * earlier (oldest first) when a new admission or result needs the room; running entries are
 * never evicted. Each scope remembers its last windowIds admitted ids as hashed tombstones, so a
 * resend of one of them never runs again. Past maxIds in total, or after idleScopeMs without
 * activity, a whole scope that is not in use and has nothing running is forgotten; its later
 * requests (and hellos, see isForgotten) are refused rather than run again. A refused admission
 * (limit_exceeded) never ran. There is deliberately no clear/reset API: create a new ledger only
 * with a new daemon epoch, not on reconnect or session changes. This is not crash persistence.
 */
export class OperationLedger {
  private readonly scopes = new Map<string, ScopeState>()
  private readonly forgottenScopes = new Set<string>()
  /** Settled entries in settlement order, which is also expiry order. */
  private readonly settled = new Set<LiveEntry>()
  private live = 0
  private ids = 0
  private bytes = 0
  private runningBytes = 0
  private lastTime = 0
  private readonly maxEntries: number
  private readonly windowIds: number
  private readonly maxIds: number
  private readonly idleScopeMs: number
  private readonly maxForgotten: number
  private readonly retentionMs: number
  private readonly maxPayloadBytes: number
  private readonly maxBytes: number
  private readonly inUse: (clientId: string) => boolean
  private readonly clock: () => number

  constructor(options: OperationLedgerOptions = {}) {
    this.maxEntries = options.maxEntries ?? 128
    this.windowIds = options.windowIds ?? 4_096
    this.maxIds = options.maxIds ?? 65_536
    this.idleScopeMs = options.idleScopeMs ?? 24 * 60 * 60 * 1_000
    this.maxForgotten = options.maxForgotten ?? 65_536
    this.retentionMs = options.retentionMs ?? 10 * 60 * 1_000
    this.maxPayloadBytes = options.maxPayloadBytes ?? 64 * 1024 * 1024
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024
    this.inUse = options.inUse ?? (() => false)
    this.clock = options.now ?? Date.now
    for (const value of [
      this.maxEntries,
      this.windowIds,
      this.maxIds,
      this.idleScopeMs,
      this.maxForgotten,
      this.maxPayloadBytes,
      this.maxBytes,
    ]) {
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
      const scopeKey = JSON.stringify([clientId, controllerToken])
      const key = JSON.stringify([clientId, controllerToken, id])
      const hash = digest(key)
      this.prune()
      const scopeHash = digest(scopeKey)
      this.lookup(scopeHash, scopeKey, key, hash)
      const accepted = copyRemoteJson(payload)
      const canonical = canonicalJson(accepted)
      const payloadBytes = Buffer.byteLength(canonical, "utf8")
      if (payloadBytes > this.maxPayloadBytes)
        throw new RemoteError("limit_exceeded", "Operation payload limit exceeded")
      // Snapshotting proxies can reenter admission through their descriptor traps. Observe
      // the current slot only after the snapshot, rather than overwriting a nested admission.
      const previous = this.lookup(scopeHash, scopeKey, key, hash)
      if (previous) {
        if (previous.canonical !== canonical)
          throw new RemoteReplyError(
            "operation_conflict",
            "The operation id was accepted with another payload",
          )
        return previous.promise as Promise<T>
      }
      const running = this.live - this.settled.size
      if (running >= this.maxEntries || payloadBytes > this.maxBytes - this.runningBytes)
        throw new RemoteError("limit_exceeded", "Operation ledger capacity exhausted")
      let state = this.scopes.get(scopeKey)
      if (state) this.trim(state, this.windowIds - 1)
      if (this.ids >= this.maxIds) this.forgetIdle(scopeKey)
      if (this.ids >= this.maxIds)
        throw new RemoteError("limit_exceeded", "Operation ledger capacity exhausted")
      if (!this.reserve(1, payloadBytes))
        throw new RemoteError("limit_exceeded", "Operation ledger capacity exhausted")

      // Install acceptance before invoking even synchronous/reentrant effects. Start in this
      // stack so transport EOF cannot revoke already admitted frontend work in a microtask gap.
      if (!state) {
        state = { key: scopeKey, clientId, window: new Map(), running: 0, lastActive: 0 }
        this.scopes.set(scopeKey, state)
      }
      this.touch(state)
      let resolve!: (value: T | PromiseLike<T>) => void
      let reject!: (error: unknown) => void
      const pending = new Promise<T>((accept, fail) => {
        resolve = accept
        reject = fail
      })
      const owner = state
      const entry: LiveEntry = {
        key,
        hash,
        scope: owner,
        canonical,
        bytes: payloadBytes,
        promise: pending
          .then(
            (value) => this.retainTerminal(entry, value, false),
            (error) => {
              throw this.retainTerminal(entry, error, true)
            },
          )
          .finally(() => this.settle(entry)),
      }
      owner.window.set(hash, entry)
      owner.running++
      this.ids++
      this.live++
      this.bytes += payloadBytes
      this.runningBytes += payloadBytes
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

  /** A forgotten scope can never resend safely; its holder must start over with a new clientId. */
  isForgotten(scope: OperationScope): boolean {
    this.prune()
    return this.forgottenScopes.has(digest(JSON.stringify([scope.clientId, scope.controllerToken])))
  }

  /** Release expired results and idle scopes; keep each scope's bounded no-reexecution tombstones. */
  prune(): number {
    const now = this.now()
    let removed = 0
    for (const entry of this.settled) {
      if (now < entry.expiresAt!) break
      this.tombstone(entry)
      removed++
    }
    for (const state of this.scopes.values()) {
      if (now - state.lastActive < this.idleScopeMs) break
      if (!state.running && !this.inUse(state.clientId)) this.forget(state)
    }
    return removed
  }

  private lookup(scopeHash: string, scopeKey: string, key: string, hash: string): LiveEntry | undefined {
    if (this.forgottenScopes.has(scopeHash)) throw forgotten()
    const slot = this.scopes.get(scopeKey)?.window.get(hash)
    if (slot === undefined) return undefined
    if (slot === null || slot.key !== key) throw expired()
    return slot
  }

  /** Tombstone the oldest settled results until entries and bytes fit; running work is never evicted. */
  private reserve(entries: number, bytes: number): boolean {
    for (const entry of this.settled) {
      if (this.live + entries <= this.maxEntries && bytes <= this.maxBytes - this.bytes) break
      this.tombstone(entry)
    }
    return this.live + entries <= this.maxEntries && bytes <= this.maxBytes - this.bytes
  }

  /** Drop tombstones that have at least `size` newer ids in their scope; live entries stay. */
  private trim(state: ScopeState, size: number): void {
    let excess = state.window.size - size
    for (const [hash, slot] of state.window) {
      if (excess-- <= 0) break
      if (slot !== null) continue
      state.window.delete(hash)
      this.ids--
    }
  }

  /** Forget least recently active scopes that cannot resend until the global id cap has room. */
  private forgetIdle(except: string): void {
    for (const state of this.scopes.values()) {
      if (this.ids < this.maxIds) return
      if (state.key !== except && !state.running && !this.inUse(state.clientId)) this.forget(state)
    }
  }

  private forget(state: ScopeState): void {
    for (const slot of state.window.values()) if (slot) this.tombstone(slot)
    this.ids -= state.window.size
    this.scopes.delete(state.key)
    this.forgottenScopes.add(digest(state.key))
    for (const oldest of this.forgottenScopes) {
      if (this.forgottenScopes.size <= this.maxForgotten) break
      this.forgottenScopes.delete(oldest)
    }
  }

  private touch(state: ScopeState): void {
    state.lastActive = this.now()
    // Map order is activity order: idle pruning stops at the first recently active scope.
    this.scopes.delete(state.key)
    this.scopes.set(state.key, state)
  }

  private settle(entry: LiveEntry): void {
    entry.scope.running--
    this.runningBytes -= entry.bytes
    if (this.scopes.get(entry.scope.key) === entry.scope) this.touch(entry.scope)
    if (entry.unretained) {
      this.tombstone(entry)
      return
    }
    entry.expiresAt = Math.min(Number.MAX_SAFE_INTEGER, this.now() + this.retentionMs)
    this.settled.add(entry)
  }

  private tombstone(entry: LiveEntry): void {
    if (entry.scope.window.get(entry.hash) !== entry) return
    entry.scope.window.set(entry.hash, null)
    this.settled.delete(entry)
    this.live--
    this.bytes -= entry.bytes
  }

  /** Retain inert JSON results or simple immutable errors, never arbitrary object graphs. */
  private retainTerminal(entry: LiveEntry, value: unknown, failure: boolean): unknown {
    let retained = value
    try {
      let canonical: string
      if (failure && value instanceof Error) {
        if (!errorPrototypes.has(Object.getPrototypeOf(value))) throw value
        const fields: Record<string, unknown> = Object.create(null)
        for (const key of Reflect.ownKeys(value)) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)
          if (
            typeof key !== "string" ||
            !descriptor ||
            !Object.hasOwn(descriptor, "value") ||
            (descriptor.value !== null && ["object", "function"].includes(typeof descriptor.value))
          )
            throw value
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
      if (!this.reserve(0, bytes)) throw value
      entry.bytes += bytes
      this.bytes += bytes
      this.runningBytes += bytes
      return retained
    } catch {
      // An oversized result, exception graph or serialization failure is not retained. The
      // caller still receives the real outcome; the id becomes a tombstone at settlement.
      entry.unretained = true
      if (failure) throw value
      return retained
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
