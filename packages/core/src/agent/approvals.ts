// Owns approval/question routing and per-turn blocked waits.
import type { ApprovalRequest, AskOutcome, AskQuestion, AskRequest } from "@amira/api"
import type { Permissions, PermissionVerdict } from "../permissions/policy.ts"
import { approvalPermission } from "./permission-text.ts"
import type { ApprovalDecision, Approver, Asker } from "./types.ts"

/** Per-call monotonic timing, populated only when a real approver is asked. */
export interface ApprovalTiming {
  /** performance.now() at entry into the approval wait. */
  startedAt?: number
  /** performance.now() when the wait settled; absent while it is still pending. */
  endedAt?: number
}

/** Snapshot even an abandoned wait, whose approver may ignore abort and never settle. */
export function approvalWaitMs(timing: ApprovalTiming | undefined): number | undefined {
  if (timing?.startedAt === undefined) return undefined
  return Math.round((timing.endedAt ?? performance.now()) - timing.startedAt)
}

/** The original turn object, never a copy: identity guards late wait cleanup. */
interface ApprovalTurn {
  id: string
  signal: AbortSignal
}

/** Only the session capabilities used by approval/question routing and blocked waits. */
interface ApprovalGateDeps {
  sessionId: string
  depth: number
  approve: Approver | undefined
  inheritedApprover: Approver | undefined
  ask: Asker | undefined
  /** Preserve the owning session receiver only for direct commander forwarding. */
  forwardAsk: Asker | undefined
  /** Resolve through the session's public getter, including overrides returning undefined. */
  resolvePermissionApprover: () => Approver | undefined
  /** Keep the live policy object: the approver and mode may change between requests. */
  permissions: Pick<Permissions, "approver" | "mode">
  isCurrentTurn: (turn: ApprovalTurn) => boolean
  /** Synchronously set blocked status and emit on every entry, even when already blocked. */
  blocked: (turn: ApprovalTurn, reason: string, pending: number) => void
  /** Use the session's ordinary deduplicated status setter. */
  working: (turn: ApprovalTurn) => void
}

/** The rewritten call arguments, after the caller has awaited the permission policy. */
interface ApprovalCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/**
 * Approval and question routing for one session, plus the count of calls waiting on an answer.
 *
 * - approve() builds the request and starts the wait synchronously, returning the wait's promise
 *   directly. The caller keeps the policy await, abort/dismissal handling, approval attribution
 *   and rejection at their original await sites, so no await or microtask boundary is added.
 * - askFromTool() shares the blocked count; askQuestions() forwards a commander's questions
 *   directly, with no wait, error conversion or promise wrapper.
 * - hasAsker says whether the session exposes askUser at all. permissionApprover never falls
 *   back to a child's parent-model approver.
 *
 * Every wait emits blocked, then calls its callback synchronously. Waits are counted per turn:
 * only the last settled wait of the current, non-aborted turn restores working. A wait its turn
 * abandoned (an approver that ignores abort) stays out of the next turn's count, whenever it
 * settles.
 */
export class ApprovalGate {
  #deps: ApprovalGateDeps
  /** Per turn, how many of its tool calls wait for approval or an answer. */
  #blocked = new WeakMap<ApprovalTurn, { calls: number }>()

  constructor(deps: ApprovalGateDeps) {
    this.#deps = deps
  }

  get hasAsker(): boolean {
    return !!this.#deps.ask
  }

  /** Build the request after the policy await, without adding a promise boundary. */
  approve(
    turn: ApprovalTurn,
    call: ApprovalCall,
    policy: PermissionVerdict,
    asks: string[] | undefined,
    timing?: ApprovalTiming,
  ): Promise<ApprovalDecision> {
    const asking = policy.decision === "ask"
    const reasons = [...(asking ? [policy.reason] : []), ...(asks ?? [])]
    const request: ApprovalRequest = {
      sessionId: this.#deps.sessionId,
      toolCallId: call.id,
      name: call.name,
      args: call.args,
      reason: reasons.join("; "),
      ...(asking ? { permission: approvalPermission(policy, this.#deps.permissions.mode) } : {}),
    }
    // A permission question goes to the user, also from a sub-agent (whose interceptors'
    // questions go to its parent); the user's answer covers the interceptors' reasons too.
    return this.#askApproval(
      turn,
      request,
      asking ? this.#deps.resolvePermissionApprover() : this.#deps.approve,
      timing,
    )
  }

  /**
   * Waits for the approver while the session shows as blocked (D44: with the number of calls
   * waiting). A missing or failing approver denies.
   */
  async #askApproval(
    turn: ApprovalTurn,
    request: ApprovalRequest,
    approve: Approver | undefined,
    timing: ApprovalTiming | undefined,
  ): Promise<ApprovalDecision> {
    if (!approve) return { approved: false, reason: "it needs approval and nobody can approve it here" }
    try {
      return await this.#waitBlocked(
        turn,
        `approval for ${request.name}`,
        () => approve(request, turn.signal),
        timing,
      )
    } catch (err) {
      return {
        approved: false,
        reason: `approval failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Who answers the permission policy's questions: the user of the tree (Permissions.approver),
   * else the one handed down from the top-level session, else a top-level session's own approver.
   * Never a parent's model: a model cannot widen what its sub-agents may do.
   */
  get permissionApprover(): Approver | undefined {
    const { permissions, inheritedApprover, depth, approve } = this.#deps
    return permissions.approver ?? inheritedApprover ?? (depth === 0 ? approve : undefined)
  }

  /** A tool's questions (ToolSession.askUser), asked while the session shows as blocked. */
  async askFromTool(turn: ApprovalTurn, toolCallId: string, questions: AskQuestion[], signal?: AbortSignal) {
    const ask = this.#deps.ask
    if (!ask) return { unavailable: "nobody can answer questions here" }
    const both = signal && signal !== turn.signal ? AbortSignal.any([turn.signal, signal]) : turn.signal
    const request: AskRequest = { sessionId: this.#deps.sessionId, toolCallId, questions }
    const who = this.#deps.depth === 0 ? "the user" : "the commander"
    try {
      return await this.#waitBlocked(turn, `question for ${who}`, () => ask(request, both))
    } catch (err) {
      return { unavailable: `asking failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** Forward a commander's questions as-is, including promise identity and synchronous throws. */
  askQuestions(request: AskRequest, signal: AbortSignal): Promise<AskOutcome> {
    return this.#deps.forwardAsk
      ? this.#deps.forwardAsk(request, signal)
      : Promise.resolve({ unavailable: "nobody can answer questions here" })
  }

  /**
   * Waits for `wait` while the session shows as blocked (D44: with the number of calls waiting,
   * for approval or for an answer).
   */
  async #waitBlocked<T>(
    turn: ApprovalTurn,
    reason: string,
    wait: () => Promise<T>,
    timing?: ApprovalTiming,
  ): Promise<T> {
    if (timing) timing.startedAt = performance.now()
    // Each turn has its own count: a wait of another turn (abandoned, or late) never touches it.
    const entry = this.#blocked.get(turn) ?? { calls: 0 }
    this.#blocked.set(turn, entry)
    entry.calls++
    // Only the current turn shows as blocked: a late wait of an ended turn must not mark the
    // session blocked, since nothing of that turn would bring it back to working.
    if (this.#deps.isCurrentTurn(turn) && !turn.signal.aborted) this.#deps.blocked(turn, reason, entry.calls)
    try {
      return await wait()
    } finally {
      if (timing) timing.endedAt = performance.now()
      entry.calls--
      // A wait that ends after its turn did (aborted, abandoned) must not wake the session.
      const live = this.#deps.isCurrentTurn(turn) && !turn.signal.aborted
      if (entry.calls === 0 && live) this.#deps.working(turn)
    }
  }
}
