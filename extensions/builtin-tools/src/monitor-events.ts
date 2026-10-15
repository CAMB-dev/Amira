import type {
  BackgroundJobChange,
  BackgroundJobInfo,
  BackgroundJobOperations,
  BackgroundJobSession,
  PendingNotice,
  UserMessage,
} from "@amira/api"
import { endText, jobIsWatched, jobsConfig, waitPattern } from "./jobs.ts"
import { queueMonitorCompletion } from "./monitor-completions.ts"

const NOTICE_BYTES = 4096
const MAX_EVENTS = 200
/** Oversized lines are reported explicitly, never regex-matched as an incomplete prefix/suffix. */
export const MAX_MONITOR_LINE_CHARS = 65_536

/** Production batches for one second at a two-second cadence; tests use a shorter clock. */
export interface MonitorTiming {
  batchMs?: number
  intervalMs?: number
}

/** A job-local stream: independent of retained output, session subscriptions, and ended-job pruning. */
export class MonitorEvents {
  #scope: BackgroundJobSession
  #job: BackgroundJobInfo | undefined
  #expectNotice: () => PendingNotice
  #pending: PendingNotice | undefined
  #pattern: RegExp | undefined
  #partial = ""
  #oversized = false
  #lines: string[] = []
  #bytes = 0
  #omitted = 0
  #events = 0
  #paused = false
  #throttled = false
  #lastSent = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #batchMs: number
  #intervalMs: number
  #closed = false
  #terminalOwned = false
  #terminalWatched = false
  #timedOut = false
  #end!: () => void
  #ended = new Promise<void>((resolve) => {
    this.#end = resolve
  })

  constructor(
    scope: BackgroundJobSession,
    expectNotice: () => PendingNotice,
    pending: PendingNotice | undefined,
    filter: string | undefined,
    timing: MonitorTiming,
  ) {
    this.#scope = scope
    this.#expectNotice = expectNotice
    this.#pending = pending
    this.#pattern = filter ? waitPattern(filter) : undefined
    this.#batchMs = timing.batchMs ?? 1000
    this.#intervalMs = timing.intervalMs ?? 2000
  }

  /** Installed in start options, before even synchronous startup output or failure. */
  observe = ({ type, job, output }: BackgroundJobChange): void => {
    if (this.#closed) return
    this.#job = job
    if (job.stopRequested) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (type === "output" && !job.stopRequested) this.#feed(output ?? "", false)
    if (type === "end") {
      // Capture both facts before waiters settle, scopes close, or the registry prunes it.
      this.#terminalOwned = this.#ownsNotices(job)
      this.#terminalWatched = jobIsWatched(job.id)
      this.#feed("", true)
      // Deliver before registry end subscribers decide whether print mode may finish. A
      // requested stop queues a non-waking notice that print still explicitly drains.
      if (!this.#timedOut) {
        if (this.#terminalOwned) this.#flush(endText(job), !job.stopRequested && !this.#terminalWatched)
        this.#closed = true
      }
      this.#end()
    }
  }

  #feed(text: string, final: boolean) {
    if (this.#paused) return
    let at = 0
    while (at < text.length && !this.#paused) {
      const nl = text.indexOf("\n", at)
      const end = nl < 0 ? text.length : nl
      if (!this.#oversized) {
        if (this.#partial.length + end - at > MAX_MONITOR_LINE_CHARS) {
          this.#partial = ""
          this.#oversized = true
        } else this.#partial += text.slice(at, end)
      }
      if (nl < 0) break
      this.#line()
      at = nl + 1
    }
    if (final && !this.#paused && (this.#partial || this.#oversized)) this.#line()
  }

  #line() {
    const oversized = this.#oversized
    const line = oversized
      ? `An output line exceeded ${MAX_MONITOR_LINE_CHARS} characters and was omitted before filtering. Limit the command's line length to monitor it.`
      : this.#partial.replace(/\r$/, "")
    this.#partial = ""
    this.#oversized = false
    if (!oversized && this.#pattern && !this.#pattern.test(line)) return
    this.#events++
    const bytes = Buffer.byteLength(line) + 1
    if (this.#bytes + bytes <= NOTICE_BYTES - 512) {
      this.#lines.push(line)
      this.#bytes += bytes
    } else this.#omitted++
    if (this.#events >= MAX_EVENTS) {
      this.#paused = true
      this.#throttled = true
    }
    if (!this.#timer && !this.#job?.stopRequested) {
      const delay = Math.max(this.#batchMs, this.#lastSent + this.#intervalMs - Date.now())
      this.#timer = setTimeout(() => this.#flush(), delay)
    }
  }

  #flush(final?: string, wake = true) {
    clearTimeout(this.#timer)
    this.#timer = undefined
    const job = this.#job!
    if (!final && (job.stopRequested || !this.#ownsNotices(job))) return
    const lines = this.#lines.splice(0)
    if (this.#omitted) lines.push(`+${this.#omitted} more lines`)
    if (this.#throttled) {
      lines.push(
        "Monitor notifications were throttled after 200 events. Output notifications are paused; stop this monitor and restart with a narrower filter (for example, errors or a specific readiness message).",
      )
    }
    this.#bytes = 0
    this.#omitted = 0
    this.#throttled = false
    const output = final ? lines.join("\n") : ""
    if (final) lines.push(final)
    if (!lines.length) return
    const head = `Monitor ${job.id}${final ? " ended" : " output"}. (Sent automatically; the user did not write this message.)`
    const notice = this.#pending
    // Renew first so a synchronous wake still sees the monitor's outstanding lifetime lease.
    this.#pending = final ? undefined : this.#expectNotice()
    const body = `${head}\n${lines.join("\n")}`
    const bytes = Buffer.from(body)
    const text =
      bytes.length <= NOTICE_BYTES
        ? body
        : `${bytes.subarray(0, NOTICE_BYTES - 64).toString("utf8")}\n+1 more lines`
    const message: UserMessage = {
      role: "user",
      content: [{ type: "text", text }],
      display: {
        text: `Monitor ${job.id}: ${final?.slice(0, 240) ?? `${lines.length} output lines`}`,
        origin: "job",
      },
    }
    if (notice && final && wake) {
      queueMonitorCompletion(this.#scope, notice, { id: job.id, final, output, single: message })
    } else notice?.deliver(message, { wake: wake && (final !== undefined || !jobIsWatched(job.id)) })
    this.#lastSent = Date.now()
  }

  #ownsNotices(job: BackgroundJobInfo): boolean {
    if (this.#scope.get(job.id)) return true
    // Root notice handles follow handovers, including a stop requested by the replacement.
    // Disposal invalidates the handle itself; a closed child must never notify its commander.
    return job.owner === undefined
  }

  async run(job: BackgroundJobInfo, timeoutMs: number): Promise<void> {
    // Only control this already-authorized job through the host across a root handover.
    // Event transport itself is attached to the job and never depends on this lookup.
    const host = jobsConfig.registry
    const hosted = host?.get(job.id)
    const registry: BackgroundJobOperations =
      host &&
      hosted?.logPath === job.logPath &&
      hosted?.startedAt === job.startedAt &&
      hosted?.command === job.command
        ? host
        : this.#scope
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const timedOut = await Promise.race([
        this.#ended.then(() => false),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => {
            this.#timedOut = true
            resolve(true)
          }, timeoutMs)
        }),
      ])
      if (!timedOut) return
      const current = this.#job!
      const wake = !current.stopRequested && !jobIsWatched(current.id)
      const alreadyEnded = current.status !== "starting" && current.status !== "running"
      const owned = alreadyEnded ? this.#terminalOwned : this.#ownsNotices(current)
      if (!alreadyEnded) this.#job = await registry.stop(job.id, 0)
      if (!owned) return
      const ended = this.#job!
      const stillRunning = ended.status === "starting" || ended.status === "running"
      this.#flush(
        `Timed out after ${timeoutMs} ms; ${stillRunning ? "stop was requested but exit could not be confirmed. Use job_stop to retry." : "the command was stopped."}`,
        wake && !this.#terminalWatched,
      )
    } finally {
      this.#closed = true
      clearTimeout(timeout)
      clearTimeout(this.#timer)
      this.#partial = ""
      this.#lines = []
      this.#pending?.cancel()
      this.#pending = undefined
    }
  }
}
