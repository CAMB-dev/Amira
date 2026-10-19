import { randomBytes } from "node:crypto"
import { RemoteError, RemoteReplyError } from "../remote/errors.ts"

export interface ControllerLease {
  readonly clientId: string
  readonly controllerToken: string
  readonly controllerGeneration: number
}

export interface ControllerOptions {
  /** Detached credentials reserve the workspace for this long. Defaults to 30 seconds. */
  graceMs?: number
  /** Absolute reconnect-token lifetime; reconnects do not renew it. Defaults to 24 hours. */
  tokenLifetimeMs?: number
  now?: () => number
}

interface HeldLease {
  lease: ControllerLease
  attached: boolean
  tokenExpiresAt: number
  detachedUntil?: number
}

const identifier = /^[a-zA-Z0-9_.:-]+$/

function validateIdentity(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !identifier.test(value))
    throw new RemoteError("invalid_frame", "Invalid controller identity or token")
}

function validateGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RemoteError("invalid_frame", "Invalid controller generation")
}

/**
 * Host-only, single-workspace controller authority. There are no timers or per-client maps.
 * Keep this instance for the workspace lifetime and check assertCurrent before every effect.
 * A reconnect fences the old transport immediately; its eventual detach is a harmless no-op.
 */
export class Controller {
  private held?: HeldLease
  private generation = 0
  private lastTime = 0
  private readonly graceMs: number
  private readonly tokenLifetimeMs: number
  private readonly clock: () => number

  constructor(options: ControllerOptions = {}) {
    this.graceMs = options.graceMs ?? 30_000
    this.tokenLifetimeMs = options.tokenLifetimeMs ?? 24 * 60 * 60 * 1_000
    this.clock = options.now ?? Date.now
    if (!Number.isSafeInteger(this.graceMs) || this.graceMs < 0)
      throw new RangeError("Controller grace must be a nonnegative safe integer")
    if (!Number.isSafeInteger(this.tokenLifetimeMs) || this.tokenLifetimeMs < 1)
      throw new RangeError("Controller token lifetime must be a positive safe integer")
  }

  attach({ clientId, controllerToken }: { clientId: string; controllerToken?: string }): ControllerLease {
    validateIdentity(clientId)
    if (controllerToken !== undefined) validateIdentity(controllerToken)
    const now = this.now()
    this.expireDetached(now)
    const previous = this.held
    if (previous) {
      if (clientId !== previous.lease.clientId || controllerToken !== previous.lease.controllerToken)
        throw new RemoteReplyError("controller_busy", "A controller already holds this workspace")
      if (now >= previous.tokenExpiresAt)
        throw new RemoteReplyError("permission_denied", "Controller reconnect credentials expired")
    } else if (controllerToken !== undefined) {
      // Never reinterpret an expired/unknown resume attempt as a fresh controller acquisition.
      throw new RemoteReplyError("permission_denied", "Controller reconnect credentials are unavailable")
    }
    if (this.generation === Number.MAX_SAFE_INTEGER)
      throw new RemoteError("limit_exceeded", "Controller generation exhausted")
    const lease: ControllerLease = Object.freeze({
      clientId,
      controllerToken: previous?.lease.controllerToken ?? randomBytes(32).toString("hex"),
      controllerGeneration: ++this.generation,
    })
    this.held = {
      lease,
      attached: true,
      tokenExpiresAt:
        previous?.tokenExpiresAt ?? Math.min(Number.MAX_SAFE_INTEGER, now + this.tokenLifetimeMs),
    }
    return lease
  }

  /** Only the current transport can detach; repeated or fenced closes cannot extend grace. */
  detach(clientId: string, controllerGeneration: number): boolean {
    validateIdentity(clientId)
    validateGeneration(controllerGeneration)
    const now = this.now()
    this.expireDetached(now)
    const held = this.held
    if (
      !held?.attached ||
      held.lease.clientId !== clientId ||
      held.lease.controllerGeneration !== controllerGeneration
    )
      return false
    held.attached = false
    held.detachedUntil = Math.min(held.tokenExpiresAt, now + this.graceMs)
    this.expireDetached(now)
    return true
  }

  /** clientId must come from the accepted handshake, not an operation's untrusted payload. */
  assertCurrent(clientId: string, controllerGeneration: number): void {
    validateIdentity(clientId)
    validateGeneration(controllerGeneration)
    this.expireDetached(this.now())
    const held = this.held
    if (
      !held?.attached ||
      held.lease.clientId !== clientId ||
      held.lease.controllerGeneration !== controllerGeneration
    )
      throw new RemoteReplyError("stale_controller", "The controller attachment is no longer current")
  }

  private now(): number {
    const value = this.clock()
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError("Controller clock must return a nonnegative safe integer")
    this.lastTime = Math.max(this.lastTime, value)
    return this.lastTime
  }

  private expireDetached(now: number): void {
    if (this.held && !this.held.attached && now >= this.held.detachedUntil!) this.held = undefined
    // Token expiry disables reconnect, not an attached transport. Even an expired live token
    // cannot authorize takeover: the owner must detach before a fresh acquisition is possible.
  }
}
