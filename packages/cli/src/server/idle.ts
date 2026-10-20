/** A true-idle deadline, independent of provider/reconnect and approval deadlines. */
export class IdleDeadline {
  private since?: number
  private revision?: number

  constructor(readonly timeoutMs: number) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)
      throw new RangeError("Idle timeout must be a nonnegative timer-safe integer")
  }

  sample(now: number, state: { idle: boolean; revision: number }): boolean {
    if (!this.timeoutMs || !state.idle) {
      this.since = undefined
      this.revision = state.revision
      return false
    }
    if (this.since === undefined || this.revision !== state.revision) this.since = now
    this.revision = state.revision
    return now - this.since >= this.timeoutMs
  }
}
