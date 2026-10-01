import { join } from "node:path"
import type { JobEvent, JobSpec } from "./job-inline.ts"

/**
 * Background jobs (commands that keep running after the call that started them, such as a dev
 * server or a watcher), as Amira keeps track of them: their status, a bounded buffer of their
 * output that readers consume incrementally, waits for a line of output, and stopping them.
 * Every job is contained and dies with Amira (see `startJob`).
 */

/** "starting" until its process exists; "failed" when it never started or Amira lost it. */
export type JobStatus = "starting" | "running" | "exited" | "stopped" | "failed"

export interface JobInfo {
  /** "job1", "job2", … in the order they were started. */
  readonly id: string
  /** What it runs, as shown to people and the model. */
  readonly command: string
  readonly cwd: string
  /**
   * The session that owns it when that is a sub-agent: the job is stopped when the sub-agent
   * ends. Unset for the top-level session's jobs, which run until stopped or Amira exits.
   */
  readonly owner?: string
  /** Free-form facts the starter keeps with it, e.g. which shell runs it. */
  readonly meta: Readonly<Record<string, unknown>>
  readonly startedAt: number
  readonly status: JobStatus
  readonly pid?: number
  /** False when its tree could not be contained, so a stop may miss some of its processes. */
  readonly contained: boolean
  readonly exitCode: number | null
  readonly signal: string | null
  /** Why it failed to start, or how it was lost. */
  readonly error?: string
  readonly endedAt?: number
  /** A stop was asked for; an exit after it is "stopped", not "exited". */
  readonly stopRequested: boolean
  /** Every output character from the start, also those the buffer dropped. */
  readonly outputChars: number
  readonly logPath?: string
  /** Set when the log file could not be written. */
  readonly logError?: string
}

export interface StartJobOptions extends JobSpec {
  command: string
  owner?: string
  meta?: Record<string, unknown>
  /** Without a logPath: write the log to a file of its own in this directory. */
  logDir?: string
}

/** Output from offset `from` up to `to` (offsets count characters since the job started). */
export interface JobOutput {
  text: string
  from: number
  to: number
  /** Characters after the offset asked for that the buffer no longer holds (the log has them). */
  dropped: number
}

export interface WaitOptions {
  /**
   * Resolve once a line of output after `from` matches. Without it, the wait lasts until the
   * job ends or the timeout.
   */
  pattern?: RegExp
  /** The offset to look from. Default: what the buffer holds. */
  from?: number
  timeoutMs: number
  signal?: AbortSignal
}

export interface WaitResult {
  reason: "match" | "exit" | "timeout" | "aborted"
  /** The line that matched. */
  line?: string
}

/** What changed: a job started, its status changed, it printed something, or it ended. */
export interface JobChange {
  type: "start" | "status" | "output" | "end"
  job: JobInfo
}

/** Too many jobs run already (JobRegistryOptions.maxRunning). */
export class JobLimitError extends Error {
  override name = "JobLimitError"
}

export type StartJobFn = (spec: JobSpec, onEvent: (e: JobEvent) => void) => { stop(graceMs: number): void }

export interface JobLimits {
  /** Jobs starting or running at once; start() refuses more. Default 8. */
  maxRunning?: number
  /** Output characters each job keeps in memory; older output only stays in the log. Default 1,000,000. */
  bufferChars?: number
}

export interface JobRegistryOptions extends JobLimits {
  /** Starts the process: `startJob` from this package, or a fake in tests. */
  start: StartJobFn
  /** Ended jobs kept for listing; older ones are forgotten. Default 50. */
  keepEnded?: number
}

export const DEFAULT_MAX_RUNNING = 8
export const DEFAULT_BUFFER_CHARS = 1_000_000
/** How long stop() waits for the job's exit after its grace period before it gives up waiting. */
const STOP_CONFIRM_MS = 5000
/** How long output must pause before a wait looks at an unfinished last line. */
const PARTIAL_LINE_MS = 200

interface Waiter {
  pattern?: RegExp
  /** Offset of the first line not yet looked at in full. */
  scanFrom: number
  done: (r: WaitResult) => void
}

interface Job {
  info: Mutable<JobInfo>
  stop: (graceMs: number) => void
  buffer: string
  /** Offset of buffer[0]. */
  bufferStart: number
  cursors: Map<string, number>
  waiters: Set<Waiter>
  ended: Promise<void>
  end: () => void
  partialTimer?: ReturnType<typeof setTimeout>
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const isLive = (s: JobStatus) => s === "starting" || s === "running"

export class JobRegistry {
  #start: StartJobFn
  #maxRunning: number
  #bufferChars: number
  #keepEnded: number
  #jobs = new Map<string, Job>()
  #next = 1
  #listeners = new Set<(c: JobChange) => void>()

  constructor(opts: JobRegistryOptions) {
    this.#start = opts.start
    this.#maxRunning = opts.maxRunning ?? DEFAULT_MAX_RUNNING
    this.#bufferChars = opts.bufferChars ?? DEFAULT_BUFFER_CHARS
    this.#keepEnded = opts.keepEnded ?? 50
  }

  /** Changes the limits for jobs started from now on (settings). */
  configure(limits: JobLimits): void {
    this.#maxRunning = Math.max(1, Math.floor(limits.maxRunning ?? DEFAULT_MAX_RUNNING))
    this.#bufferChars = Math.max(1000, Math.floor(limits.bufferChars ?? DEFAULT_BUFFER_CHARS))
  }

  get maxRunning(): number {
    return this.#maxRunning
  }

  /** Whether an error came from this registry refusing a live job at its limit. */
  isLimitError(error: unknown): error is JobLimitError {
    return error instanceof JobLimitError
  }

  /**
   * Starts a job and returns at once; it is "starting" until its process exists. Throws
   * JobLimitError when maxRunning jobs run already.
   */
  start(opts: StartJobOptions): JobInfo {
    const live = this.running().length
    if (live >= this.#maxRunning) {
      throw new JobLimitError(
        `${live} background jobs are running, the most allowed (backgroundJobs.maxRunning); stop one first`,
      )
    }
    const { command, owner, meta, logDir, ...spec } = opts
    const id = `job${this.#next++}`
    // Named after the job and the moment, so a later run of Amira in the same session (which
    // counts jobs from 1 again) never writes over an earlier log.
    if (logDir && !spec.logPath) spec.logPath = join(logDir, `${id}-${Date.now().toString(36)}.log`)
    let end = () => {}
    const ended = new Promise<void>((resolve) => {
      end = resolve
    })
    const job: Job = {
      info: {
        id,
        command,
        cwd: spec.cwd,
        ...(owner ? { owner } : {}),
        meta: { ...meta },
        startedAt: Date.now(),
        status: "starting",
        contained: true,
        exitCode: null,
        signal: null,
        stopRequested: false,
        outputChars: 0,
        ...(spec.logPath ? { logPath: spec.logPath } : {}),
      },
      stop: () => {},
      buffer: "",
      bufferStart: 0,
      cursors: new Map(),
      waiters: new Set(),
      ended,
      end,
    }
    this.#jobs.set(id, job)
    this.#emit("start", job)
    try {
      job.stop = this.#start(spec, (e) => this.#onEvent(job, e)).stop
    } catch (err) {
      this.#onEvent(job, {
        type: "exit",
        code: null,
        signal: null,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return this.#copy(job)
  }

  get(id: string): JobInfo | undefined {
    const job = this.#jobs.get(id)
    return job && this.#copy(job)
  }

  /** Every job kept, oldest first. */
  list(): JobInfo[] {
    return [...this.#jobs.values()].map((j) => this.#copy(j))
  }

  /** Jobs starting or running, oldest first. */
  running(): JobInfo[] {
    return this.list().filter((j) => isLive(j.status))
  }

  /** Output from offset `from` (default: as far back as the buffer holds) to now. */
  output(id: string, from = 0): JobOutput {
    const job = this.#need(id)
    const to = job.bufferStart + job.buffer.length
    const start = Math.min(Math.max(from, job.bufferStart), to)
    return {
      text: job.buffer.slice(start - job.bufferStart),
      from: start,
      to,
      dropped: Math.max(0, Math.min(start, to) - Math.max(0, from)),
    }
  }

  /** The last `maxChars` characters of output, starting at a line when it can. */
  tail(id: string, maxChars: number): string {
    const job = this.#need(id)
    if (job.buffer.length <= maxChars) return job.buffer
    const cut = job.buffer.slice(-maxChars)
    const nl = cut.indexOf("\n")
    return nl !== -1 && nl < cut.length - 1 ? cut.slice(nl + 1) : cut
  }

  /** Where `reader` read up to last time (0 before its first read). */
  cursor(id: string, reader: string): number {
    return this.#need(id).cursors.get(reader) ?? 0
  }

  /**
   * The output `reader` has not read yet, and marks it read. Beyond `maxChars` only the end is
   * returned; what was skipped counts as dropped.
   */
  readNew(id: string, reader: string, maxChars = Number.POSITIVE_INFINITY): JobOutput {
    const job = this.#need(id)
    const out = this.output(id, job.cursors.get(reader) ?? 0)
    job.cursors.set(reader, out.to)
    if (out.text.length <= maxChars) return out
    const skip = out.text.length - maxChars
    return { text: out.text.slice(skip), from: out.from + skip, to: out.to, dropped: out.dropped + skip }
  }

  /** Marks everything printed so far as read by `reader`. */
  markRead(id: string, reader: string, to?: number): void {
    const job = this.#need(id)
    job.cursors.set(reader, to ?? job.bufferStart + job.buffer.length)
  }

  /**
   * Waits for a line matching `pattern` in output after `from`, for the job to end, for the
   * timeout or for the signal, whichever comes first. A job that ended already resolves at once
   * (with "match" when its output matches).
   */
  waitFor(id: string, opts: WaitOptions): Promise<WaitResult> {
    const job = this.#need(id)
    return new Promise<WaitResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waiter: Waiter = {
        ...(opts.pattern ? { pattern: opts.pattern } : {}),
        scanFrom: opts.from ?? job.bufferStart,
        done: (r) => {
          clearTimeout(timer)
          opts.signal?.removeEventListener("abort", onAbort)
          job.waiters.delete(waiter)
          resolve(r)
        },
      }
      const onAbort = () => waiter.done({ reason: "aborted" })
      const live = isLive(job.info.status)
      const line = this.#scan(job, waiter, !live)
      if (line !== undefined) return resolve({ reason: "match", line })
      if (!live) return resolve({ reason: "exit" })
      if (opts.signal?.aborted) return resolve({ reason: "aborted" })
      job.waiters.add(waiter)
      this.#schedulePartial(job)
      timer = setTimeout(() => waiter.done({ reason: "timeout" }), Math.max(0, opts.timeoutMs))
      opts.signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  /**
   * Stops a job and its whole tree: asked to stop first where the platform can (POSIX), killed
   * after `graceMs`. Resolves with how it ended, or as it is if it has not confirmed its exit
   * some seconds after the grace period. A job that ended already resolves at once.
   */
  async stop(id: string, graceMs = 2000): Promise<JobInfo> {
    const job = this.#need(id)
    if (!isLive(job.info.status)) return this.#copy(job)
    if (!job.info.stopRequested) {
      job.info.stopRequested = true
      this.#emit("status", job)
      job.stop(graceMs)
    } else if (graceMs === 0) {
      // Asked again without a grace period (e.g. Amira cannot wait any longer): kill it now.
      job.stop(0)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      job.ended,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs + STOP_CONFIRM_MS)
      }),
    ])
    clearTimeout(timer)
    return this.#copy(job)
  }

  /** Stops every live job `which` picks (default all) at the same time. */
  async stopAll(which: (job: JobInfo) => boolean = () => true, graceMs = 2000): Promise<JobInfo[]> {
    const targets = this.running().filter(which)
    return Promise.all(targets.map((j) => this.stop(j.id, graceMs)))
  }

  /** Calls `listener` on every change; returns a function that removes it. */
  subscribe(listener: (change: JobChange) => void): () => void {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  #need(id: string): Job {
    const job = this.#jobs.get(id)
    if (!job) throw new Error(`no background job "${id}"`)
    return job
  }

  #copy(job: Job): JobInfo {
    return { ...job.info, meta: { ...job.info.meta } }
  }

  #emit(type: JobChange["type"], job: Job) {
    if (!this.#listeners.size) return
    const change = { type, job: this.#copy(job) }
    for (const l of [...this.#listeners]) {
      try {
        l(change)
      } catch {
        // A failing listener must not break the others or the job's bookkeeping.
      }
    }
  }

  #onEvent(job: Job, e: JobEvent) {
    const info = job.info
    if (!isLive(info.status)) return
    if (e.type === "spawned") {
      info.pid = e.pid
      info.contained = e.contained
      info.status = "running"
      this.#emit("status", job)
    } else if (e.type === "output") {
      job.buffer += e.data
      info.outputChars += e.data.length
      // Waits look at the new output before the buffer drops anything: a ready line followed by
      // a flood of output in the same chunk is still seen.
      this.#scanAll(job, false)
      this.#trim(job)
      this.#schedulePartial(job)
      this.#emit("output", job)
    } else {
      info.exitCode = e.code
      info.signal = e.signal
      info.endedAt = Date.now()
      if (e.logError) info.logError = e.logError
      if (e.error) info.error = e.error
      info.status = e.error ? "failed" : info.stopRequested ? "stopped" : "exited"
      clearTimeout(job.partialTimer)
      this.#scanAll(job, true)
      for (const w of [...job.waiters]) w.done({ reason: "exit" })
      job.end()
      this.#emit("end", job)
      this.#prune()
    }
  }

  #scanAll(job: Job, partial: boolean) {
    for (const w of [...job.waiters]) {
      const line = this.#scan(job, w, partial)
      if (line !== undefined) w.done({ reason: "match", line })
    }
  }

  /** Waiters look at an unfinished last line once output has paused for a moment. */
  #schedulePartial(job: Job) {
    clearTimeout(job.partialTimer)
    if (!job.waiters.size || !job.buffer || job.buffer.endsWith("\n")) return
    job.partialTimer = setTimeout(() => this.#scanAll(job, true), PARTIAL_LINE_MS)
  }

  /**
   * Cuts the buffer in steps, not on every chunk: a quarter over the limit, back to about the
   * limit, at the start of a line, so the buffer never starts inside one.
   */
  #trim(job: Job) {
    if (job.buffer.length <= this.#bufferChars * 1.25) return
    let drop = job.buffer.length - this.#bufferChars
    const nl = job.buffer.indexOf("\n", drop - 1)
    if (nl !== -1 && nl - drop < this.#bufferChars / 4) drop = nl + 1
    job.buffer = job.buffer.slice(drop)
    job.bufferStart += drop
  }

  /**
   * Looks for the waiter's pattern in the output after its scan point, one whole line at a
   * time: a pattern never spans lines, and a line the scan point falls inside (it was partly
   * read already) is looked at from its start. Returns the matching line.
   */
  #scan(job: Job, w: Waiter, partial = false): string | undefined {
    if (!w.pattern) return undefined
    const offset = Math.max(w.scanFrom, job.bufferStart) - job.bufferStart
    // From the start of the line the scan point is in.
    const lineStart = offset > 0 ? job.buffer.lastIndexOf("\n", offset - 1) + 1 : 0
    let text = job.buffer.slice(lineStart)
    // A line still being written (e.g. "port 30" of "port 3000") is only looked at once it is
    // finished or its output paused (partial).
    if (!partial) text = text.slice(0, text.lastIndexOf("\n") + 1)
    if (!text) return undefined
    let at = 0
    for (const raw of text.split("\n")) {
      const end = at + raw.length
      // The empty piece after a final line break is no line.
      if (end === text.length && raw === "" && text.endsWith("\n")) break
      const line = raw.replace(/\r$/, "")
      w.pattern.lastIndex = 0
      if (w.pattern.test(line)) {
        w.scanFrom = job.bufferStart + lineStart + Math.min(text.length, end + 1)
        return line
      }
      at = end + 1
    }
    const lastNl = text.lastIndexOf("\n")
    if (lastNl !== -1) w.scanFrom = job.bufferStart + lineStart + lastNl + 1
    return undefined
  }

  /**
   * Forgets the jobs that ended longest ago beyond keepEnded; a job that just ended stays, so
   * a call waiting on it still finds it.
   */
  #prune() {
    const ended = [...this.#jobs.values()]
      .filter((j) => !isLive(j.info.status))
      .sort((a, b) => (a.info.endedAt ?? 0) - (b.info.endedAt ?? 0))
    for (const j of ended.slice(0, Math.max(0, ended.length - this.#keepEnded))) this.#jobs.delete(j.info.id)
  }
}
