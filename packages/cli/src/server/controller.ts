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

/** What the holder's hello advertised; a takeover must not strand a peer that cannot be told. */
export interface ControllerHolder {
  /** Understands roles and a post-welcome controller_taken; legacy holders are never taken over. */
  roles?: boolean
  /** Serves models for this daemon (model.proxy on both sides). */
  servesModels?: boolean
}

export type ControllerState =
  | { state: "attached" }
  | { state: "detached"; graceRemainingMs: number }
  | { state: "none" }

interface HeldLease {
  lease: ControllerLease
  holder: ControllerHolder
  attached: boolean
  tokenExpiresAt: number
  detachedUntil?: number
  /** When this clientId acquired the lease; its own reconnects and retakes keep it. */
  since: number
}

/** A different client cannot take the lease within this long of the last holder change. */
const TAKE_INTERVAL_MS = 1_000

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

  attach({
    clientId,
    controllerToken,
    ...holder
  }: { clientId: string; controllerToken?: string } & ControllerHolder): ControllerLease {
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
      holder: { roles: holder.roles === true, servesModels: holder.servesModels === true },
      attached: true,
      tokenExpiresAt:
        previous?.tokenExpiresAt ?? Math.min(Number.MAX_SAFE_INTEGER, now + this.tokenLifetimeMs),
      since: previous?.since ?? now,
    }
    return lease
  }

  /**
   * Explicit takeover: a fresh lease with a new generation and token, ending any grace. A taker
   * always understands roles. The caller closes the previous holder's connection, if attached.
   */
  take({ clientId, servesModels }: { clientId: string } & Pick<ControllerHolder, "servesModels">): {
    lease: ControllerLease
    previous?: { lease: ControllerLease; attached: boolean }
  } {
    validateIdentity(clientId)
    const now = this.now()
    this.expireDetached(now)
    const previous = this.held
    // A lost welcome leaves the taker's own lease held; taking it again is not a holder change.
    if (previous && previous.lease.clientId !== clientId) {
      if (now - previous.since < TAKE_INTERVAL_MS)
        throw new RemoteReplyError("controller_busy", "Control changed hands less than a second ago")
      if (previous.attached && !previous.holder.roles)
        throw new RemoteReplyError("controller_busy", "A controller already holds this workspace")
      if (previous.attached && previous.holder.servesModels && !servesModels)
        throw new RemoteReplyError(
          "unsupported_capability",
          "The current controller serves models; taking control requires model.proxy",
        )
    }
    if (this.generation === Number.MAX_SAFE_INTEGER)
      throw new RemoteError("limit_exceeded", "Controller generation exhausted")
    const lease: ControllerLease = Object.freeze({
      clientId,
      controllerToken: randomBytes(32).toString("hex"),
      controllerGeneration: ++this.generation,
    })
    this.held = {
      lease,
      holder: { roles: true, servesModels: servesModels === true },
      attached: true,
      tokenExpiresAt: Math.min(Number.MAX_SAFE_INTEGER, now + this.tokenLifetimeMs),
      since: previous?.lease.clientId === clientId ? previous.since : now,
    }
    return { lease, ...(previous && { previous: { lease: previous.lease, attached: previous.attached } }) }
  }

  /**
   * The holder hands control back by reconnecting as a viewer with its live token: the lease
   * ends without grace. Returns the ended lease so its connection, if still open, can be closed.
   */
  release({ clientId, controllerToken }: { clientId: string; controllerToken: string }) {
    validateIdentity(clientId)
    validateIdentity(controllerToken)
    const now = this.now()
    this.expireDetached(now)
    const held = this.held
    if (
      !held ||
      held.lease.clientId !== clientId ||
      held.lease.controllerToken !== controllerToken ||
      now >= held.tokenExpiresAt
    )
      return undefined
    this.held = undefined
    return held.lease
  }

  /** Presence for display; never authority. */
  state(): ControllerState {
    const now = this.now()
    this.expireDetached(now)
    if (!this.held) return { state: "none" }
    if (this.held.attached) return { state: "attached" }
    return { state: "detached", graceRemainingMs: this.held.detachedUntil! - now }
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

  /** Whether clientId holds the lease, attached or within its grace, and so may still resend. */
  holds(clientId: string): boolean {
    this.expireDetached(this.now())
    return this.held?.lease.clientId === clientId
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
