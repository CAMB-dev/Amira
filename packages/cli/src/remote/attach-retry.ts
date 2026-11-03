import type { FrontendConnectionIssue } from "@amira/core"
import type { RemoteAgentPort, RemoteAttachIntent } from "./agent-port.ts"
import { RemoteError } from "./errors.ts"
import { classifyReconnectFailure } from "./reconnect-failure.ts"

type RetryPort = Pick<
  RemoteAgentPort,
  "reconnect" | "status" | "disconnectionReason" | "readOnly" | "subscribeStatus"
>

/** Pause before another attempt after a retryable transport failure. */
const RETRY_MS = 2000
/**
 * workspace_busy means other viewers are loading a snapshot: retry after a short, growing
 * delay, a bounded number of times, then leave it to /reconnect.
 */
export const BUSY_RETRY_MS: readonly number[] = Object.freeze([500, 1000, 2000, 4000, 8000])

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined

/**
 * The attach loop's reconnect policy: automatic retries, the takeover path (watch again at
 * once), workspace_busy backoff and the explicit /reconnect. Reports through setConnectionIssue.
 */
export function attachRetries(deps: {
  port: RetryPort
  /** Model binding after a controller attaches; a viewer never negotiates. */
  negotiate?(): Promise<unknown>
  setConnectionIssue(issue?: FrontendConnectionIssue): void
  /** True when the reason is a takeover, which it then reports. */
  lost(reason: unknown): boolean
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
}) {
  const { port } = deps
  const timers = deps.timers ?? {
    set: (run: () => void, ms: number) => setTimeout(run, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  let stopped = false
  let reconnecting = false
  let blocked = false
  let timer: unknown
  let busyTries = 0
  /** A takeover arrived while an attempt was running; watch again once it has ended. */
  let watchAfter = false

  const cancelTimer = () => {
    if (timer === undefined) return
    timers.clear(timer)
    timer = undefined
  }
  const schedule = (ms: number) => {
    cancelTimer()
    timer = timers.set(() => {
      timer = undefined
      void retry()
    }, ms)
  }
  /** Reports a failure and decides what follows; `now` retries a retryable one at once. */
  const failed = (error: unknown, now = false) => {
    const failure = classifyReconnectFailure(error)
    if (failure.code === "workspace_busy") {
      const delay = BUSY_RETRY_MS[busyTries]
      if (delay === undefined) {
        blocked = true
        deps.setConnectionIssue({
          ...failure,
          recovery:
            "Automatic retries stopped because the workspace stayed busy. Use /reconnect to try again.",
          retryable: false,
        })
        return
      }
      busyTries++
      deps.setConnectionIssue(failure)
      schedule(delay)
      return
    }
    deps.setConnectionIssue(failure)
    blocked = !failure.retryable
    if (!failure.retryable) return
    if (now) void retry()
    else schedule(RETRY_MS)
  }
  /** Registers a takeover once, even mid-attempt; that attempt then ends and this TUI watches. */
  const takenOver = (reason: unknown): boolean => {
    if (watchAfter) return true
    if (!deps.lost(reason)) return false
    if (reconnecting) watchAfter = true
    else void retry("viewer")
    return true
  }
  const resume = () => {
    if (!watchAfter || stopped) return
    watchAfter = false
    void retry("viewer")
  }
  const attempt = async (intent: RemoteAttachIntent | undefined, negotiate: boolean) => {
    reconnecting = true
    try {
      await port.reconnect(intent)
      // Only a controller binds models; a viewer has no model traffic at all.
      if (negotiate && !port.readOnly) await deps.negotiate?.()
      if (port.status !== "connected")
        throw port.disconnectionReason ?? new RemoteError("disconnected", "Remote attachment unavailable")
      busyTries = 0
      deps.setConnectionIssue()
    } finally {
      reconnecting = false
    }
  }
  async function retry(intent?: RemoteAttachIntent): Promise<void> {
    if (stopped || reconnecting || blocked) return
    try {
      await attempt(intent, true)
    } catch (error) {
      if (stopped) return
      if (!takenOver(codeOf(error) === "controller_taken" ? error : port.disconnectionReason)) failed(error)
    }
    resume()
  }
  const offStatus = port.subscribeStatus((status) => {
    if (status !== "disconnected" || stopped) return
    if (takenOver(port.disconnectionReason)) return
    if (reconnecting || blocked) return
    failed(port.disconnectionReason, true)
  })
  return {
    /** An attempt is running. */
    get busy() {
      return reconnecting
    },
    retry,
    /** One attempt with this intent, reporting nothing; rejects when it does not attach. */
    async reconnect(intent: RemoteAttachIntent): Promise<void> {
      cancelTimer()
      try {
        await attempt(intent, false)
      } finally {
        resume()
      }
    },
    /** Back to the usual retries after a failed explicit attempt. */
    restore() {
      blocked = false
      void retry()
    },
    /** /reconnect: what happened, for the command to say. */
    manual(): "in-progress" | "connected" | "started" {
      if (reconnecting) return "in-progress"
      if (port.status === "connected" && !blocked) return "connected"
      cancelTimer()
      blocked = false
      busyTries = 0
      deps.setConnectionIssue()
      void retry()
      return "started"
    },
    stop() {
      stopped = true
      cancelTimer()
      offStatus()
    },
  }
}
