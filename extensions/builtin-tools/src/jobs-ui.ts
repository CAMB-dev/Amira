import type { BackgroundJobInfo as JobInfo, BackgroundJobRegistry as JobRegistry } from "@amira/api"
import {
  type BackgroundJobDetails,
  type CommandCandidate,
  type CommandContext,
  type CommandDefinition,
  clip,
  type ExtensionAPI,
  formatElapsed,
  type JobListDetails,
  type PanelDefinition,
  plural,
  type SelectSection,
  type ToolPresenter,
  type ViewDefinition,
  type ViewLine,
} from "@amira/api"
import {
  configureJobs,
  endText,
  type JobOutputParams,
  type JobStopParams,
  STOP_GRACE_MS,
  watchJobEnds,
} from "./jobs.ts"

/**
 * Background jobs for the user: a live panel while jobs run, /jobs to list them with their
 * output and stop them, a notice when one ends on its own, and the clean-up: a sub-agent's jobs
 * stop when it ends, and every job when Amira exits.
 */

export const JOB_VIEW = "background-job"
/** Output lines the job view and a printed job show at most. */
const VIEW_LINES = 500
const PRINT_LINES = 40
/** Output alone redraws the screen at most this often (for the panel's last line and times). */
const OUTPUT_RENDER_MS = 1000

const isLive = (j: JobInfo) => j.status === "running" || j.status === "starting"

/** How it is doing: "running 3m 12s", "exited with code 1 after 4s". */
export function jobState(job: JobInfo, now: number): string {
  const time = formatElapsed((job.endedAt ?? now) - job.startedAt)
  return isLive(job) ? `running ${time}` : `${endText(job)} after ${time}`
}

/** The last line of output that is not blank, or "" (for one-line summaries). */
export function lastLine(registry: JobRegistry, id: string): string {
  const lines = registry.tail(id, 2000).split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences would garble a summary
    const text = lines[i]!.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim()
    if (text) return text
  }
  return ""
}

/** "job1 · running 3m 12s · npm run dev", as lists show a job. */
export function jobRow(job: JobInfo, now: number, commandCells = 60): string {
  return `${job.id} · ${jobState(job, now)} · ${clip(job.command.replace(/\s+/g, " ").trim(), commandCells)}`
}

/**
 * The live panel: while jobs run, a summary and one row per job: its id and time first (they
 * must not be cut), then the command and its last line of output. Folded, only the summary.
 */
export function jobsPanel(registry: JobRegistry): PanelDefinition {
  return {
    id: "background-jobs",
    order: 10,
    render({ width, now, collapsed }) {
      const live = registry.running()
      if (!live.length) return []
      const lines: ViewLine[] = [
        { kind: "muted", text: `${plural(live.length, "background job")} running · /jobs to see or stop` },
      ]
      if (collapsed) return lines
      for (const j of live) {
        const head = `● ${j.id} ${formatElapsed(now - j.startedAt)} · `
        const room = Math.max(10, width - head.length)
        const command = clip(j.command.replace(/\s+/g, " ").trim(), Math.max(10, Math.floor(room * 0.5)))
        const last = lastLine(registry, j.id)
        lines.push({ kind: "text", text: `${head}${command}${last ? ` · ${last}` : ""}` })
      }
      return lines
    },
  }
}

/** The output of one job as lines: its end, with how much came before. */
function outputLines(registry: JobRegistry, id: string, max: number): ViewLine[] {
  const out = registry.output(id)
  const lines = out.text.replace(/\r?\n$/, "").split(/\r?\n/)
  if (!out.text) return [{ kind: "muted", text: "(no output yet)" }]
  const shown = lines.slice(-max)
  const earlier = lines.length - shown.length
  return [
    ...(earlier || out.from > 0
      ? [
          {
            kind: "muted" as const,
            text: `… earlier output${earlier ? `: ${plural(earlier, "line")}` : ""} not shown`,
          },
        ]
      : []),
    ...shown.map((text) => ({ kind: "text" as const, text })),
  ]
}

/** The job's facts under the view's title: its state, process, working directory and log. */
function headerLines(job: JobInfo, now: number): ViewLine[] {
  const pid = job.pid !== undefined ? ` · pid ${job.pid}` : ""
  return [
    {
      kind: isLive(job) ? "accent" : job.status === "exited" && job.exitCode === 0 ? "success" : "warning",
      text: `${jobState(job, now)}${pid}`,
    },
    { kind: "muted", text: `in ${job.cwd}` },
    ...(job.logPath ? [{ kind: "muted" as const, text: `log: ${job.logPath}` }] : []),
  ]
}

/** The live view on one job: its output as it grows, x to stop it. */
export function jobView(registry: JobRegistry): ViewDefinition<{ id: string }> {
  return {
    kind: JOB_VIEW,
    title: ({ id }) => {
      const job = registry.get(id)
      return job ? `${job.id} · ${job.command.replace(/\s+/g, " ").trim()}` : id
    },
    header: ({ id }, { now }) => {
      const job = registry.get(id)
      return job ? headerLines(job, now) : [{ kind: "muted", text: "This job is no longer kept." }]
    },
    render: ({ id }) => (registry.get(id) ? outputLines(registry, id, VIEW_LINES) : []),
    keys: [
      {
        key: "x",
        label: "stop",
        async run({ id }, view) {
          const job = registry.get(id)
          if (!job || !isLive(job)) return
          if (!(await view.confirm(`Stop ${job.id}?`, { yes: "stops it", no: "keeps it running" }))) return
          await registry.stop(id, STOP_GRACE_MS)
          view.requestRender()
        },
      },
    ],
  }
}

/** A job by id ("job2") or list number ("2"). */
function findJob(list: JobInfo[], ref: string): JobInfo | undefined {
  const n = Number(ref)
  if (Number.isInteger(n) && n >= 1 && String(n) === ref) return list[n - 1]
  return list.find((j) => j.id === ref)
}

/** Prints a job: its row, facts and the end of its output. */
function printJob(ctx: CommandContext, registry: JobRegistry, job: JobInfo) {
  const now = Date.now()
  const lines = [
    jobRow(job, now, 200),
    ...headerLines(job, now)
      .slice(1)
      .map((l) => l.text),
    "",
    ...outputLines(registry, job.id, PRINT_LINES).map((l) => l.text),
  ]
  ctx.print(lines.join("\n"))
}

async function stopJobs(ctx: CommandContext, registry: JobRegistry, list: JobInfo[], ref: string) {
  if (ref === "all") {
    const live = list.filter(isLive)
    if (!live.length) return ctx.print("No background job is running.")
    await registry.stopAll((j) => live.some((l) => l.id === j.id), STOP_GRACE_MS)
    return ctx.print(`Stopped ${plural(live.length, "background job")}.`)
  }
  const job = findJob(list, ref)
  if (!job) throw new Error(`no background job "${ref}"; /jobs lists them`)
  if (!isLive(job)) return ctx.print(`${job.id} is not running: it ${endText(job)}.`)
  const ended = await registry.stop(job.id, STOP_GRACE_MS)
  ctx.print(isLive(ended) ? `${job.id} was told to stop but has not exited yet.` : `Stopped ${job.id}.`)
}

/**
 * /jobs: the background jobs. Without arguments a list: Enter opens the live view on a job
 * (prints its output where the frontend has no views), x stops it, p prints it. `/jobs <n|id>`
 * prints one; `/jobs stop <n|id|all>` stops one or every running one.
 */
export function jobsCommand(registry: JobRegistry): CommandDefinition {
  return {
    name: "jobs",
    description: "Show the background jobs, their output, and stop them",
    args: {
      hint: "[<n>|<id>|stop <n>|<id>|all]",
      complete(prefix) {
        const list = registry.list()
        const now = Date.now()
        const stopping = /^stop\s+(.*)$/.exec(prefix)
        if (stopping) {
          const live = list.filter(isLive)
          return live.length
            ? [
                ...live.map((j) => ({ value: `stop ${j.id}`, description: jobRow(j, now) })),
                { value: "stop all", description: "Stop every running job" },
              ]
            : []
        }
        const out: CommandCandidate[] = list.map((j) => ({ value: j.id, description: jobRow(j, now) }))
        if (list.some(isLive)) out.push({ value: "stop", description: "Stop a running job" })
        return out
      },
    },
    async run(args, ctx) {
      const list = registry.list()
      if (!list.length)
        return ctx.print("No background jobs. The shell tools start them with background: true.")
      const stopping = /^stop(?:\s+(.*))?$/.exec(args)
      if (stopping) {
        const ref = stopping[1]?.trim()
        if (!ref) throw new Error("say which job to stop: /jobs stop <n|id|all>")
        return stopJobs(ctx, registry, list, ref)
      }
      if (args) {
        const job = findJob(list, args)
        if (!job) throw new Error(`no background job "${args}"; /jobs lists them`)
        return printJob(ctx, registry, job)
      }
      const now = Date.now()
      // The list numbers them itself; a digit picks that one.
      const rows = list.map((j) => jobRow(j, now))
      if (ctx.frontend === "print") return ctx.print(rows.map((r, i) => `${i + 1}. ${r}`).join("\n"))
      const sections: SelectSection[] = [
        {
          at: 0,
          choose: ctx.openView ? "open" : "print",
          keys: [{ key: "x", label: "stop" }, ...(ctx.openView ? [{ key: "p", label: "print" }] : [])],
        },
      ]
      const pick = await ctx.ui.choose("Background jobs", rows, {
        sections,
        descriptions: list.map((j) => lastLine(registry, j.id)),
        signal: ctx.signal,
      })
      if (!pick) return
      const chosen = list[rows.indexOf(pick.option)]
      if (!chosen) return
      if (pick.key === "x") return stopJobs(ctx, registry, list, chosen.id)
      const job = registry.get(chosen.id)
      if (!job) return ctx.print(`${chosen.id} is no longer kept.`)
      if (pick.key !== "p" && ctx.openView?.({ kind: JOB_VIEW, data: { id: job.id } })) return
      printJob(ctx, registry, job)
    },
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "")

function jobDetails<D>(result: { details?: unknown }, key: string): D | undefined {
  const d = result.details
  return d && typeof d === "object" && key in d ? (d as D) : undefined
}

/** "running", "exit 1", "stopped": a job's state in a tool call's result line. */
function shortState(d: BackgroundJobDetails): string {
  if (d.status === "running" || d.status === "starting") return "running"
  if (d.status === "exited") return d.exitCode === 0 ? "exited" : `exit ${d.exitCode}`
  return d.status
}

const outputBody = (text: string, detail: string, max = 3): ViewLine[] => {
  // The tool's own sentences come after the output; the presenter shows the output's end only.
  const lines = text.split("\n\n")[0]?.split("\n") ?? []
  if (detail === "full") return lines.map((t) => ({ kind: "code", text: t }))
  if (detail !== "summary") return []
  const tail = lines.filter((l) => l.trim() && l !== "(no new output)").slice(-max)
  return tail.map((t) => ({ kind: "code", text: t }))
}

export const jobOutputPresenter: ToolPresenter<JobOutputParams, BackgroundJobDetails> = {
  summary: (args) => `${str(args.job_id)}${args.wait_for ? ` · wait for /${str(args.wait_for)}/` : ""}`,
  result(call) {
    const d = jobDetails<BackgroundJobDetails>(call.result, "jobId")
    if (!d) return undefined
    const matched = d.waited === "match" ? "matched · " : d.waited === "timeout" ? "no match · " : ""
    return `${matched}${d.outputLines ? plural(d.outputLines, "new line") : "nothing new"} · ${shortState(d)}`
  },
  body: (call, { detail }) => (call.result.isError ? [] : outputBody(call.text, detail)),
}

export const jobStopPresenter: ToolPresenter<JobStopParams, BackgroundJobDetails> = {
  summary: (args) => str(args.job_id),
  result(call) {
    const d = jobDetails<BackgroundJobDetails>(call.result, "jobId")
    return d ? shortState(d) : undefined
  },
  body: () => [],
}

export const jobListPresenter: ToolPresenter<Record<string, never>, JobListDetails> = {
  summary: () => "",
  result(call) {
    const d = jobDetails<JobListDetails>(call.result, "jobs")
    if (!d) return call.text.startsWith("No background") ? "none" : undefined
    const live = d.jobs.filter((j) => j.status === "running" || j.status === "starting").length
    return `${plural(d.jobs.length, "job")}${live ? ` · ${live} running` : ""}`
  },
  body: (call, { detail }) =>
    detail === "full" ? call.text.split("\n").map((text) => ({ kind: "text" as const, text })) : [],
}

/** Subscriptions of the extension loaded last; a reload replaces them. */
const unsubscribe: (() => void)[] = []

/**
 * Adds everything above to the extension's registrations and starts the clean-up, for the
 * jobs in `registry` (the tools' own by default; tests pass another without changing the tools').
 */
export function registerJobs(api: ExtensionAPI, registry: JobRegistry = api.backgroundJobs): void {
  for (const off of unsubscribe.splice(0)) off()
  configureJobs(api.settings.backgroundJobs, registry)
  let lastOutputRender = 0
  unsubscribe.push(
    watchJobEnds(registry),
    registry.subscribe(({ type, job }) => {
      if (type === "output") {
        const now = Date.now()
        if (now - lastOutputRender < OUTPUT_RENDER_MS) return
        lastOutputRender = now
      }
      if (type === "end" && !job.stopRequested) {
        const failed = job.status === "failed" || job.exitCode !== 0
        api.notify(`Background job ${job.id} ${endText(job)}: ${job.command}`, failed ? "warning" : "info")
      }
      api.requestRender()
    }),
  )
  api.registerPanel(jobsPanel(registry))
  api.registerCommand(jobsCommand(registry))
  api.registerView(jobView(registry))
  // The session host stops a sub-agent's jobs when its owner ends.
  // Every job ends with Amira: asked to stop first, killed when the exit cannot wait longer.
  api.onExit(async (signal) => {
    if (!registry.running().length) return
    const onAbort = () => void registry.stopAll(() => true, 0)
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      await registry.stopAll(() => true, STOP_GRACE_MS)
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  })
}
