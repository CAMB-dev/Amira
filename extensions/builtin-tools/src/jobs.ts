import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BackgroundJobDetails,
  type BackgroundJobInfo,
  type BackgroundJobRegistry,
  type BackgroundJobWaitResult,
  defineTool,
  formatElapsed,
  type JobListDetails,
  plural,
  type Settings,
  type ToolContext,
  type ToolResult,
  type ToolSession,
  textResult,
} from "@amira/api"
import type { Shell } from "./shell.ts"
import { NOT_CONTAINED_WARNING } from "./shell-notes.ts"
import { MAX_OUTPUT_CHARS } from "./truncate.ts"

/**
 * Background jobs for the model: the shell tools start them (`background: true`), job_output
 * reads what they printed since the last read (optionally waiting for a line), job_stop stops
 * them and job_list lists them. Jobs a sub-agent starts are its own: only it (and the
 * top-level session) sees them, and they are stopped when it ends.
 */

/** How long a background start waits, so a command that fails at once reports it like a normal run. */
export const STARTUP_WAIT_MS = 1500
/** Output a background start returns at most: the end of it. */
const STARTUP_OUTPUT_CHARS = 10_000
export const DEFAULT_WAIT_MS = 30_000
export const MAX_WAIT_MS = 600_000
/** Grace period for a job asked to stop before it is killed (POSIX; Windows kills at once). */
export const STOP_GRACE_MS = 2000

/**
 * How much of a job's output goes to its log, and the host view the extension serves (to forget
 * what the tools keep about jobs it no longer keeps); the extension sets them.
 */
export const jobsConfig: { maxLogBytes?: number; registry?: BackgroundJobRegistry } = {}

/** Applies the `backgroundJobs` settings. */
export function configureJobs(
  settings: Settings["backgroundJobs"] = {},
  registry: BackgroundJobRegistry,
): void {
  // Unset keys go back to the defaults, so a reload after removing one takes effect.
  registry.configure({
    maxRunning: settings.maxRunning,
    bufferChars: settings.bufferChars,
  })
  jobsConfig.registry = registry
  if (settings.maxLogBytes !== undefined) jobsConfig.maxLogBytes = settings.maxLogBytes
  else delete jobsConfig.maxLogBytes
}

/** The reader whose place job_output keeps: each session reads a job's output on its own. */
const readerOf = (ctx: ToolContext) => `model:${ctx.session?.sessionId ?? "-"}`

/** The session that started each job, told when it ends on its own (see watchJobEnds). */
const starters = new Map<string, ToolSession>()
/** Calls that are watching a job right now, which will report its end themselves. */
const watching = new Map<string, number>()

function watch<T>(id: string, run: () => Promise<T>): Promise<T> {
  watching.set(id, (watching.get(id) ?? 0) + 1)
  return run().finally(() => {
    const n = (watching.get(id) ?? 1) - 1
    if (n) watching.set(id, n)
    else watching.delete(id)
  })
}

/**
 * Tells the session that started a job when the job ended without anyone asking it to: in its
 * next turn (it does not wake an idle session; the user sees a notice meanwhile). Not when a
 * tool call watching the job reports the end itself. Returns a function that stops listening.
 */
export function watchJobEnds(registry: BackgroundJobRegistry): () => void {
  return registry.subscribe(({ type, job }) => {
    if (type !== "end") return
    const session = starters.get(job.id)
    starters.delete(job.id)
    if (!session || job.stopRequested || watching.has(job.id)) return
    const notice = session.expectNotice?.()
    if (!notice) return
    const tail = registry.tail(job.id, 2000).trimEnd()
    const text = `Background job ${job.id} (${job.command}) ${endText(job)}. (Sent automatically; the user did not write this message.)${tail ? `\nIts last output:\n${tail}` : ""}`
    notice.deliver(
      {
        role: "user",
        content: [{ type: "text", text }],
        display: { text: `Background job ${job.id} ${endText(job)}: ${job.command}`, origin: "job" },
      },
      { wake: false },
    )
  })
}

/** How a job ended, for sentences: "exited with code 1", "was stopped", "failed to start: …". */
export function endText(job: BackgroundJobInfo): string {
  if (job.status === "failed")
    return job.pid === undefined ? `failed to start: ${job.error}` : `was lost: ${job.error}`
  if (job.status === "stopped") return "was stopped"
  if (job.exitCode === null) return `was killed${job.signal ? ` by ${job.signal}` : ""}`
  return `exited with code ${job.exitCode}`
}

/** The job's state in a sentence, for the model. */
function statusSentence(job: BackgroundJobInfo, now = Date.now()): string {
  if (job.status === "starting" || job.status === "running") {
    const pid = job.pid !== undefined ? `pid ${job.pid}, ` : ""
    return `Job ${job.id} is running (${pid}started ${formatElapsed(now - job.startedAt)} ago).`
  }
  return `Job ${job.id} ${endText(job)}.`
}

const lineCount = (text: string) => (text.trimEnd() === "" ? 0 : text.trimEnd().split("\n").length)

function details(
  job: BackgroundJobInfo,
  output: string,
  waited?: BackgroundJobWaitResult["reason"],
): BackgroundJobDetails {
  return {
    jobId: job.id,
    command: job.command,
    status: job.status,
    exitCode: job.exitCode,
    ...(job.pid !== undefined ? { pid: job.pid } : {}),
    ...(job.logPath ? { logPath: job.logPath } : {}),
    outputLines: lineCount(output),
    ...(waited ? { waited } : {}),
  }
}

/** A note where output was left out: older output only in the log, or the read was capped. */
function droppedNote(job: BackgroundJobInfo, dropped: number): string | undefined {
  if (!dropped) return undefined
  const where = job.logPath ? `; the log file has all of it: ${job.logPath}` : ""
  return `[${dropped} earlier characters are left out${where}]`
}

const failed = (job: BackgroundJobInfo) =>
  job.status === "failed" || (job.status === "exited" && job.exitCode !== 0)

/**
 * The shell tools' `background: true`: starts the command as a job and waits briefly, so a
 * command that fails at once is reported like a normal run; else returns the job's id and the
 * output so far.
 */
export async function startBackground(
  tool: string,
  shell: Shell,
  command: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const registry = ctx.backgroundJobs
  if (!registry) return textResult("Background jobs are unavailable in this host.", true)
  const session = ctx.session
  const { argv, env, cwd, gated, gateLine, viaCmd } = shell.command(command, ctx.cwd)
  let job: BackgroundJobInfo
  try {
    job = registry.start({
      command,
      argv,
      env,
      cwd,
      shell: shell.kind,
      gated,
      ...(gateLine !== undefined ? { gateLine } : {}),
      ...(viaCmd ? { viaCmd } : {}),
      logDir: join(session?.dir ?? join(tmpdir(), "amira"), "jobs"),
      ...(jobsConfig.maxLogBytes !== undefined ? { maxLogBytes: jobsConfig.maxLogBytes } : {}),
      meta: { tool, shell: shell.path },
    })
  } catch (err) {
    if (registry.isLimitError(err)) {
      const live = registry.running().map((j) => `${j.id}: ${j.command}`)
      return textResult(`${err.message}.${live.length ? `\nRunning: ${live.join("; ")}` : ""}`, true)
    }
    return textResult(`Failed to start ${shell.path}: ${(err as Error).message}`, true)
  }
  if (session) starters.set(job.id, session)
  const waited = await watch(job.id, () =>
    registry.waitFor(job.id, { timeoutMs: STARTUP_WAIT_MS, signal: ctx.signal }),
  )
  if (waited.reason === "aborted") {
    // The model never learns the id of a job whose start was interrupted: it must not run on.
    await registry.stop(job.id, 0)
    return textResult("Aborted while the background job was starting; it was stopped.", true)
  }
  const out = registry.readNew(job.id, readerOf(ctx), STARTUP_OUTPUT_CHARS)
  job = registry.get(job.id)!
  const printed = out.text.trimEnd()
  const parts: string[] = []
  if (shell.label) parts.push(`Shell: ${shell.label}`)
  const note = droppedNote(job, out.dropped)
  if (job.status === "running" || job.status === "starting") {
    parts.push(`Started background job ${job.id}${job.pid !== undefined ? ` (pid ${job.pid})` : ""}.`)
    parts.push(printed ? `Output so far:\n${note ? `${note}\n` : ""}${printed}` : "No output yet.")
    parts.push(
      `It keeps running after this call. Read what it prints with job_output (job_id "${job.id}"; to wait for a line such as a ready message, pass wait_for rather than calling it again and again), and stop it with job_stop when it is no longer needed.${job.logPath ? ` Its full output also goes to ${job.logPath}.` : ""}`,
    )
  } else {
    if (note) parts.push(note)
    parts.push(printed || "(no output)")
    parts.push(`The background job ${job.id} already ended: it ${endText(job)}.`)
  }
  if (!job.contained) parts.push(NOT_CONTAINED_WARNING)
  return {
    content: [{ type: "text", text: parts.join("\n\n") }],
    isError: failed(job),
    details: details(job, printed),
  }
}

/** Finds a job the calling session may use, or the error result to return. */
function lookup(jobId: unknown, ctx: ToolContext): BackgroundJobInfo | ToolResult {
  if (typeof jobId !== "string" || !jobId.trim()) return textResult("job_id is required", true)
  const registry = ctx.backgroundJobs
  if (!registry) return textResult("Background jobs are unavailable in this host.", true)
  const job = registry.get(jobId.trim())
  if (job) return job
  const ids = registry.list().map((j) => j.id)
  return textResult(
    `No background job "${jobId}". ${ids.length ? `Known jobs: ${ids.join(", ")}.` : "No background jobs were started."}`,
    true,
  )
}

const isResult = (v: BackgroundJobInfo | ToolResult): v is ToolResult => "content" in v

/**
 * A regular expression from the model, matched case-insensitively per line; text that is not
 * a valid one is looked for literally.
 */
export function waitPattern(text: string): RegExp {
  try {
    return new RegExp(text, "im")
  } catch {
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "im")
  }
}

/** When each session last read each job without new output, to spot polling. */
const emptyReads = new Map<string, number>()
/**
 * Where each session's next wait_for starts looking: after what its last job_output read. The
 * output a background start returned does not count, so a ready line the job printed during
 * that start is still found by the first wait.
 */
const waitFrom = new Map<string, number>()

/** Drops what the maps above keep about jobs the registry no longer keeps, once they grow. */
function forgetGoneJobs() {
  if (waitFrom.size + emptyReads.size < 200) return
  const { registry } = jobsConfig
  for (const map of [waitFrom, emptyReads]) {
    for (const key of [...map.keys()]) {
      if (!registry?.get(key.slice(key.indexOf("\0") + 1))) map.delete(key)
    }
  }
}
const POLL_WINDOW_MS = 5000

function waitSignal(ctx: ToolContext): { signal: AbortSignal; cleanup: () => void } {
  if (!ctx.steerSignal) return { signal: ctx.signal, cleanup: () => {} }
  const combined = new AbortController()
  const abort = () => combined.abort()
  if (ctx.signal.aborted || ctx.steerSignal.aborted) combined.abort()
  else {
    ctx.signal.addEventListener("abort", abort, { once: true })
    ctx.steerSignal.addEventListener("abort", abort, { once: true })
  }
  return {
    signal: combined.signal,
    cleanup: () => {
      ctx.signal.removeEventListener("abort", abort)
      ctx.steerSignal?.removeEventListener("abort", abort)
    },
  }
}

export interface JobOutputParams {
  job_id: string
  wait_for?: string
  timeout?: number
}

export const jobOutputTool = defineTool<JobOutputParams>({
  name: "job_output",
  description: [
    "Read new output/status of a shell background job. wait_for matches each new line case-insensitively (first call includes start output); returns on match, exit or timeout. Without wait_for, timeout waits for exit.",
    "Do not poll: use wait_for/timeout or do other work before checking.",
    `Returns at most ${MAX_OUTPUT_CHARS} chars (new output's tail); log file has all output.`,
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string" },
      wait_for: {
        type: "string",
        description: "Regular expression to await",
      },
      timeout: {
        type: "integer",
        minimum: 0,
        maximum: MAX_WAIT_MS,
        description: `Milliseconds; default ${DEFAULT_WAIT_MS} with wait_for, else 0`,
      },
    },
    required: ["job_id"],
    additionalProperties: false,
  },
  traits: { readOnly: true },
  concurrency: "parallel",
  async execute({ job_id, wait_for, timeout }, ctx) {
    const found = lookup(job_id, ctx)
    if (isResult(found)) return found
    const registry = ctx.backgroundJobs!
    const reader = readerOf(ctx)
    const pattern = typeof wait_for === "string" && wait_for !== "" ? waitPattern(wait_for) : undefined
    const waitMs =
      typeof timeout === "number"
        ? Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(timeout)))
        : pattern
          ? DEFAULT_WAIT_MS
          : 0
    let waited: BackgroundJobWaitResult | undefined
    if (pattern || waitMs > 0) {
      const wait = waitSignal(ctx)
      try {
        waited = await watch(found.id, () =>
          registry.waitFor(found.id, {
            ...(pattern ? { pattern } : {}),
            from: waitFrom.get(`${reader}\0${found.id}`) ?? 0,
            timeoutMs: waitMs,
            signal: wait.signal,
          }),
        )
      } finally {
        wait.cleanup()
      }
    }
    const out = registry.readNew(found.id, reader, MAX_OUTPUT_CHARS)
    waitFrom.set(`${reader}\0${found.id}`, out.to)
    forgetGoneJobs()
    const job = registry.get(found.id)!
    const printed = out.text.trimEnd()
    const parts: string[] = []
    const note = droppedNote(job, out.dropped)
    if (note) parts.push(note)
    parts.push(printed || "(no new output)")
    if (waited?.reason === "match") parts.push(`Matched: ${waited.line}`)
    else if (waited?.reason === "timeout" && pattern)
      parts.push(`No line matched /${wait_for}/ within ${waitMs} ms.`)
    else if (waited?.reason === "exit" && pattern && job.status !== "running")
      parts.push("The job ended before a line matched.")
    else if (waited?.reason === "aborted") parts.push("The wait was aborted.")
    parts.push(statusSentence(job))
    // Polling: nothing new twice in a row, shortly after each other, without waiting.
    const key = `${reader}\0${job.id}`
    if (!printed && !waited && (job.status === "running" || job.status === "starting")) {
      const last = emptyReads.get(key)
      if (last !== undefined && Date.now() - last < POLL_WINDOW_MS)
        parts.push(
          "Nothing new again. Do not poll: pass wait_for (and a timeout) to wait for the line you expect, or continue with other work.",
        )
      emptyReads.set(key, Date.now())
    } else emptyReads.delete(key)
    if (!job.contained) parts.push(NOT_CONTAINED_WARNING)
    return {
      content: [{ type: "text", text: parts.join("\n\n") }],
      isError: failed(job),
      details: details(job, printed, waited?.reason),
    }
  },
})

export interface JobStopParams {
  job_id: string
}

export const jobStopTool = defineTool<JobStopParams>({
  name: "job_stop",
  description:
    "Stop a background job and descendants; returns end status/unread output. Stop unneeded jobs; all stop on Amira exit.",
  parameters: {
    type: "object",
    properties: { job_id: { type: "string" } },
    required: ["job_id"],
    additionalProperties: false,
  },
  traits: { readOnly: false },
  concurrency: "parallel",
  async execute({ job_id }, ctx) {
    const found = lookup(job_id, ctx)
    if (isResult(found)) return found
    const registry = ctx.backgroundJobs!
    const wasLive = found.status === "running" || found.status === "starting"
    const job = await watch(found.id, () => registry.stop(found.id, STOP_GRACE_MS))
    const out = registry.readNew(found.id, readerOf(ctx), STARTUP_OUTPUT_CHARS)
    const printed = out.text.trimEnd()
    const live = job.status === "running" || job.status === "starting"
    const head = !wasLive
      ? `Job ${job.id} had already ended: it ${endText(job)}.`
      : live
        ? `Job ${job.id} was told to stop but has not exited yet.`
        : job.status === "stopped"
          ? `Stopped job ${job.id} (${job.command}).`
          : `Job ${job.id} ${endText(job)} before it was stopped.`
    const parts = [head]
    const note = droppedNote(job, out.dropped)
    if (printed) parts.push(`Output not read before:\n${note ? `${note}\n` : ""}${printed}`)
    return {
      content: [{ type: "text", text: parts.join("\n\n") }],
      isError: live,
      details: details(job, printed),
    }
  },
})

export const jobListTool = defineTool<Record<string, never>>({
  name: "job_list",
  description:
    "List the background jobs: id, status, how long they ran, the command and how much output you have not read yet.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  traits: { readOnly: true },
  concurrency: "parallel",
  async execute(_params, ctx) {
    const registry = ctx.backgroundJobs
    if (!registry) return textResult("Background jobs are unavailable in this host.", true)
    const jobs = registry.list()
    if (!jobs.length) return textResult("No background jobs.")
    const reader = readerOf(ctx)
    const now = Date.now()
    const lines = jobs.map((j) => {
      const live = j.status === "running" || j.status === "starting"
      const time = formatElapsed((j.endedAt ?? now) - j.startedAt)
      const state = live
        ? `running ${time}${j.pid !== undefined ? ` · pid ${j.pid}` : ""}`
        : `${endText(j)} after ${time}`
      const unread = Math.max(0, registry.output(j.id).to - registry.cursor(j.id, reader))
      return `${j.id} · ${state} · ${unread ? `${plural(unread, "character")} unread` : "nothing unread"} · ${j.command}`
    })
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        jobs: jobs.map((j) => ({ jobId: j.id, command: j.command, status: j.status, exitCode: j.exitCode })),
      } satisfies JobListDetails,
    }
  },
})

export const jobTools = [jobOutputTool, jobStopTool, jobListTool]
