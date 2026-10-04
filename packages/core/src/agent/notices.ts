// Owns expected/delivered notices, inbox handover and failed-turn retries.
import { type UserMessage, userMessage } from "@amira/ai"
import type { PendingNotice } from "@amira/api"
import { joinMessages } from "./messages.ts"
import type { Emit, Turn, TurnResult } from "./types.ts"

interface NoticeInboxDeps {
  retryMs: number[]
  disposed: () => boolean
  turn: () => Turn | undefined
  holding: () => string | undefined
  /** True while the session owns an abort controller for a turn or hold. */
  busy: () => boolean
  /** Bound to the owning session, preserving the callback's receiver. */
  onIdleNotice: (() => void) | undefined
  prompt: (message: UserMessage) => Promise<TurnResult>
  emit: Emit
}

/** Delivered and expected notices, their replacement inbox and failed-turn resends. */
export class NoticeInbox {
  #deps: NoticeInboxDeps
  /**
   * Delivered notices waiting for a model call. Unlike steering they are never dropped:
   * after an interrupted or failed turn they wait for the next one.
   */
  #notices: UserMessage[] = []
  /** Notices announced and not yet delivered or cancelled. */
  #expected = 0
  #pendingNotices = new Set<{ target: NoticeInbox }>()
  #jobNoticeTarget: NoticeInbox | undefined
  /** The scheduled resend, if any. */
  #retry: { timer: ReturnType<typeof setTimeout>; attempt: number; at: number } | undefined
  /** Resends in a row whose turn failed. */
  #retries = 0
  /** A notice arrived during a manual compaction: it is sent once that ends. */
  #noticedDuringCompaction = false

  constructor(deps: NoticeInboxDeps) {
    this.#deps = deps
  }

  expect(): PendingNotice {
    if (this.#deps.disposed()) return { deliver: () => {}, cancel: () => {} }
    const pending = { target: this }
    this.#pendingNotices.add(pending)
    this.#expected++
    const close = () => {
      if (!pending.target.#pendingNotices.delete(pending)) return false
      pending.target.#expected--
      return true
    }
    return {
      deliver: (message, opts) => {
        if (close()) pending.target.receive(message, opts?.wake !== false)
      },
      cancel: () => void close(),
    }
  }

  /** The inbox that gets this one's notices: its latest replacement after switches, if any. */
  target(): NoticeInbox {
    let target: NoticeInbox = this
    while (target.#jobNoticeTarget) target = target.#jobNoticeTarget
    return target
  }

  /** Moves pending handles to the immediate replacement; delivered notices stay here. */
  handover(next: NoticeInbox): void {
    this.#jobNoticeTarget = next
    for (const pending of this.#pendingNotices) {
      this.#pendingNotices.delete(pending)
      this.#expected--
      pending.target = next
      next.#pendingNotices.add(pending)
      next.#expected++
    }
  }

  get expected(): number {
    return this.#expected
  }

  get waiting(): number {
    return this.#notices.length
  }

  take(): UserMessage[] {
    return this.#notices.splice(0)
  }

  receive(message: UserMessage, wake = true): void {
    if (this.#deps.disposed()) return
    this.#notices.push(message)
    const turn = this.#deps.turn()
    if (turn) this.#deps.emit(turn, "turn.steer", { message, state: "queued" })
    else if (this.#deps.holding()) {
      // A manual compaction (or other held work) runs: it is sent once that ends.
      if (wake) this.#noticedDuringCompaction = true
      this.#deps.emit(undefined, "turn.steer", { message, state: "queued" })
    } else if (!wake) {
      // It waits for the next turn, which the user's next message starts.
      this.#deps.emit(undefined, "turn.steer", { message, state: "queued" })
    } else if (this.#deps.onIdleNotice) this.#deps.onIdleNotice()
    else this.wakeQuietly()
  }

  /** Returns the turn directly, including its rejection, for an owner that decides when to wake. */
  wake(): Promise<TurnResult> | undefined {
    if (this.#deps.disposed() || this.#deps.busy() || this.#deps.holding() || !this.#notices.length)
      return undefined
    return this.#deps.prompt(joinMessages(this.#notices.splice(0)))
  }

  get retry(): { attempt: number; at: number } | undefined {
    return this.#retry && { attempt: this.#retry.attempt, at: this.#retry.at }
  }

  cancelRetry(): void {
    if (!this.#retry) return
    clearTimeout(this.#retry.timer)
    this.#retry = undefined
  }

  /**
   * A turn carrying notices failed before the model answered them (or left some unsent): send
   * them again later, starting a turn, with growing delays. After the last retry fails they
   * wait for the user's next message.
   */
  scheduleRetry(error: string | undefined): void {
    if (this.#deps.disposed()) return
    this.cancelRetry()
    const delays = this.#deps.retryMs
    if (this.#retries >= delays.length) return
    const delayMs = delays[this.#retries]!
    const attempt = this.#retries + 1
    const timer = setTimeout(() => this.#redeliver(), delayMs)
    // Never what keeps a process alive: print and rpc wait for it on their own terms.
    ;(timer as { unref?: () => void }).unref?.()
    this.#retry = { timer, attempt, at: Date.now() + delayMs }
    this.#deps.emit(undefined, "notice.retry", {
      attempt,
      attempts: delays.length,
      delayMs,
      ...(error !== undefined ? { error } : {}),
    })
  }

  #redeliver() {
    if (this.#deps.disposed()) return
    this.#retry = undefined
    this.#retries++
    const message = this.#notices.length
      ? joinMessages(this.#notices.splice(0))
      : userMessage(
          "The previous turn failed before you handled the results of your background sub-agents above. Handle them now. (Sent automatically; the user did not write this message.)",
          {
            text: `◆ sending the sub-agents' results again (retry ${this.#retries} of ${this.#deps.retryMs.length})`,
            origin: "subagent",
          },
        )
    // A turn cancels the timer, so only a manual compaction can be running: the message then
    // waits for it like any notice arriving meanwhile.
    if (this.#deps.holding()) {
      this.#notices.push(message)
      this.#noticedDuringCompaction = true
      this.#deps.emit(undefined, "turn.steer", { message, state: "queued" })
      return
    }
    this.#deps.prompt(message).catch(() => {})
  }

  /** Starts a turn with the waiting notices. */
  wakeQuietly(): void {
    if (this.#deps.disposed() || this.#deps.busy() || !this.#notices.length) return
    this.#deps.prompt(joinMessages(this.#notices.splice(0))).catch(() => {})
  }

  resetRetries(): void {
    this.#retries = 0
  }

  takeNoticedDuringHold(): boolean {
    const noticed = this.#noticedDuringCompaction
    this.#noticedDuringCompaction = false
    return noticed
  }

  clear(): void {
    this.#notices.splice(0)
    this.#pendingNotices.clear()
    this.#expected = 0
    // #jobNoticeTarget stays: a job that asks for its notice after this switch must still reach
    // the replacement session.
  }
}
