import {
  type ChildSession,
  defineExtension,
  defineTool,
  type ExtensionAPI,
  MAX_TITLE_CHARS,
  type PendingNotice,
  type SubagentResult,
  type ToolContext,
  type ToolPresenter,
  type ToolSession,
  textResult,
  type UserMessage,
} from "@amira/api"
import { agentsCommand, formatTokens } from "./agents-command.ts"
import { type Isolation, loadRoles, type Role, roleModel } from "./roles.ts"
import {
  createWorktree,
  formatStat,
  keepChanges,
  type MergeResult,
  mergeWorktree,
  type RunGit,
  removeWorktree,
  sweepWorktrees,
  type Worktree,
} from "./worktree.ts"

export * from "./agents-command.ts"
export * from "./roles.ts"
export * from "./worktree.ts"

export const AGENT_TOOL = "agent"
export const AGENT_RESULT_TOOL = "agent_result"

export interface AgentTask {
  role?: string
  /** A few words naming the task, shown to the user: "US market trend". */
  title: string
  prompt: string
  model?: string
  context?: "fresh" | "fork"
  isolation?: Isolation
}

interface AgentParams {
  tasks: AgentTask[]
  background?: boolean
}

/** What a child did in the shared directory, seen from its tool calls. */
interface Activity {
  files: Set<string>
  commands: number
}

/** A started sub-agent and the report it ends in. */
interface Job {
  child: ChildSession
  role: string
  title: string
  prompt: string
  startedAt: number
  /** Settles with the report for the commander; never rejects. */
  report: Promise<string>
  done?: string
  /** How it ended, once it did. */
  result?: SubagentResult
  /** Called once the report is done. */
  onDone?: () => void
  /** Where its report goes by itself when it finishes in the background (top-level commanders). */
  notice?: PendingNotice
  /** agent_result calls waiting for it: they hand the report out, so it is not also sent. */
  waiters: number
  /** Stopped by its commander: its worktree changes are kept for review, never merged. */
  cancelled?: boolean
  /** Nobody will read its report any more, so what it leaves behind is reported as an error. */
  orphaned?: boolean
}

/** Stops a job whose commander no longer wants it. */
function cancel(job: Job, reason: string, orphan: boolean): void {
  job.cancelled = true
  if (orphan) job.orphaned = true
  job.child.abort(reason)
}

const WRITE_TOOLS = new Set(["write", "edit"])
const SHELL_TOOLS = new Set(["bash", "powershell"])

/** Runs git through the host (a Worker thread; via cmd.exe on Windows, where direct spawns can stall). */
export function hostGit(api: Pick<ExtensionAPI, "runCommand">): RunGit {
  return async (args, cwd, stdoutOnly = false) => {
    const r = await api.runCommand(["git", ...args], {
      cwd,
      timeoutMs: 120_000,
      signal: new AbortController().signal,
      stdoutOnly,
      viaCmd: true,
    })
    return { output: r.output, ok: r.exitCode === 0 }
  }
}

/** One worktree merge at a time, so two children never patch the same checkout at once. */
let mergeChain: Promise<unknown> = Promise.resolve()
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = mergeChain.then(work, work)
  mergeChain = next.catch(() => {})
  return next
}

function shorten(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function childInstructions(role: Role | undefined, wt: Worktree | undefined): string {
  const parts = [
    "# Sub-agent",
    "You are a sub-agent: a commander agent gave you the task in the user message. Work on your own; nobody will answer questions, so make reasonable assumptions and state them. Your final reply is returned to the commander as your result and is all it sees of your work, so make it complete and self-contained.",
  ]
  if (wt) {
    parts.push(
      `You work in your own git worktree (${wt.cwd}). When you finish, everything you changed there is merged into the commander's working tree. Do not push, switch branches or remove the worktree.`,
    )
  }
  if (role?.prompt) parts.push(role.prompt)
  return parts.join("\n\n")
}

/** Follows a child's events for the files it wrote and the commands it ran. */
async function watch(child: ChildSession, activity: Activity): Promise<void> {
  const paths = new Map<string, string>()
  for await (const e of child.events) {
    if (e.sessionId !== child.id) continue
    if (e.type === "tool.execute.start" && WRITE_TOOLS.has(e.data.name)) {
      const p = e.data.args.path
      if (typeof p === "string") paths.set(e.data.toolCallId, p)
    } else if (e.type === "tool.execute.end" && !e.data.rejected && !e.data.result.isError) {
      const p = paths.get(e.data.toolCallId)
      if (p) activity.files.add(p)
      if (SHELL_TOOLS.has(e.data.name)) activity.commands++
    }
  }
}

function changesLine(activity: Activity): string {
  const parts: string[] = []
  if (activity.files.size) parts.push(`changed ${[...activity.files].join(", ")}`)
  if (activity.commands)
    parts.push(`ran ${activity.commands} shell command${activity.commands === 1 ? "" : "s"}`)
  return parts.length ? `Changes: ${parts.join("; ")}.` : "Changes: none."
}

function mergeLine(m: MergeResult, wt: Worktree, unfinished?: string): string {
  const line = outcomeLine(m, wt, unfinished)
  return m.cleanup
    ? `${line} The worktree could not be removed (${shorten(m.cleanup, 200)}); it stays at ${wt.dir} and is deleted later.`
    : line
}

function outcomeLine(m: MergeResult, wt: Worktree, unfinished?: string): string {
  const files = m.stat.files.length ? ` (${m.stat.files.join(", ")})` : ""
  if (unfinished && m.outcome === "kept") {
    return `Worktree: NOT merged because the sub-agent ${unfinished}; its work may be incomplete. Its changes, ${formatStat(m.stat)}${files}, stay in ${wt.dir}; the patch is ${wt.patch}. Check them before using any (e.g. read the patch and apply what is right), then remove the worktree with git worktree remove.`
  }
  switch (m.outcome) {
    case "empty":
      return "Worktree: no changes."
    case "merged":
      return `Worktree: merged into the working tree, ${formatStat(m.stat)}${files}.`
    case "discarded":
      return `Worktree: the user discarded its changes, ${formatStat(m.stat)}${files}.`
    case "partial":
      return `Worktree: applied what fit, ${formatStat(m.stat)}${files}. Rejected hunks are in .rej files next to: ${m.rejected?.join(", ") || "(none reported)"}. The worktree stays at ${wt.dir}.`
    case "kept":
      return `Worktree: NOT merged${m.conflict ? ` (conflict: ${shorten(m.conflict, 300)})` : ""}. Its changes, ${formatStat(m.stat)}${files}, stay in ${wt.dir}; the patch is ${wt.patch}. Resolve it yourself (e.g. read the patch and apply the edits), then remove the worktree with git worktree remove.`
  }
}

function reportOf(job: Job, r: SubagentResult, changes: string, note?: string): string {
  const seconds = (r.durationMs / 1000).toFixed(1)
  const tokens = formatTokens(r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite)
  const head = `## ${job.title} · ${job.role} · ${r.sessionId} · ${r.status} (${seconds}s, ${tokens} tokens)`
  const lines = [head]
  if (note) lines.push(note)
  if (r.status !== "done" && r.error) lines.push(`Error: ${r.error}`)
  lines.push(r.text || "(no final answer)")
  lines.push(changes)
  return lines.join("\n\n")
}

/** How long a finished background report waits for others finishing close by, to go as one message. */
export const BATCH_MS = 300

const ENDED: Record<SubagentResult["status"], string> = {
  done: "finished",
  error: "failed",
  aborted: "stopped",
}

/**
 * The message that brings background reports to their commander: the reports for the model,
 * one short line each for the transcript ("◆ US market trend finished · explorer · 41s · 12.3k tok").
 */
function noticeMessage(jobs: Pick<Job, "role" | "title" | "done" | "result">[]): UserMessage {
  const lines = jobs.map((j) => {
    const r = j.result
    if (!r) return `◆ ${j.title} finished · ${j.role}`
    const u = r.usage
    const tokens = formatTokens(u.input + u.output + u.cacheRead + u.cacheWrite)
    return `◆ ${j.title} ${ENDED[r.status]} · ${j.role} · ${Math.round(r.durationMs / 1000)}s · ${tokens} tok`
  })
  const head =
    jobs.length === 1
      ? "A sub-agent you started in the background has ended. Its report follows."
      : `${jobs.length} sub-agents you started in the background have ended. Their reports follow.`
  const text = `${head} (Sent automatically; the user did not write this message.)\n\n${jobs.map((j) => j.done ?? "").join("\n\n")}`
  return {
    role: "user",
    content: [{ type: "text", text }],
    display: { text: lines.join("\n"), origin: "subagent" },
  }
}

function taskList(params: unknown): AgentTask[] {
  const p = params as Partial<AgentParams> & Partial<AgentTask>
  if (Array.isArray(p.tasks)) return p.tasks
  // Tolerates a single task given at the top level.
  return typeof p.prompt === "string" ? [p as AgentTask] : []
}

/** A task's title on one line; empty when it has none. */
function titleOf(task: AgentTask): string {
  return typeof task.title === "string" ? task.title.replace(/\s+/g, " ").trim() : ""
}

/** What is wrong with a task's title, if anything. */
function titleProblem(task: AgentTask, i: number): string | undefined {
  const title = titleOf(task)
  if (!title)
    return `Task ${i + 1} has no "title": give each task a title of 3–6 words naming it for the user, e.g. "US market trend".`
  if (title.length > MAX_TITLE_CHARS)
    return `Task ${i + 1}'s "title" is ${title.length} characters long; keep it to 3–6 words (at most ${MAX_TITLE_CHARS} characters) and put the details in "prompt".`
  return undefined
}

export interface AgentExtensionOptions {
  /** Replaces git, for tests. */
  git?: RunGit
}

export function createAgentExtension(opts: AgentExtensionOptions = {}) {
  return defineExtension((api: ExtensionAPI) => {
    const git = opts.git ?? hostGit(api)
    const dirs = { home: api.home, cwd: api.cwd }
    const reported = new Set<string>()
    const swept = new Set<string>()
    /** Background jobs by commander session, then by child id. */
    const background = new Map<string, Map<string, Job>>()
    /** Reports waiting a moment to be sent together, by commander session. */
    const batches = new Map<string, { jobs: Job[]; timer: ReturnType<typeof setTimeout> }>()
    /** Ids of background sub-agents whose report was sent to their commander as a message. */
    const delivered = new Set<string>()
    let cached: { at: number; roles: Map<string, Role> } | undefined

    const roles = (): Map<string, Role> => {
      if (cached && Date.now() - cached.at < 2000) return cached.roles
      const found = loadRoles(dirs)
      for (const p of found.problems) {
        if (reported.has(p)) continue
        reported.add(p)
        api.reportError(`skipped agent role ${p}`)
      }
      cached = { at: Date.now(), roles: found.roles }
      return found.roles
    }

    const start = async (task: AgentTask, session: ToolSession, ctx: ToolContext): Promise<Job> => {
      const role = task.role ? roles().get(task.role) : undefined
      const isolation = task.isolation ?? role?.isolation ?? "none"
      let wt: Worktree | undefined
      let note: string | undefined
      if (isolation === "worktree") {
        const made = await createWorktree(git, {
          cwd: ctx.cwd,
          home: api.home,
          name: `sa_${crypto.randomUUID().slice(0, 8)}`,
        })
        if ("error" in made) note = `No worktree (${made.error}); it worked in the shared directory.`
        else {
          wt = made
          // Once per repository and process: clear out what earlier sessions left behind (D62).
          if (!swept.has(made.root)) {
            swept.add(made.root)
            await sweepWorktrees(git, { root: made.root, home: api.home }).catch(() => [])
          }
        }
      }
      // Making the worktree takes a while; the commander may have been interrupted meanwhile.
      if (ctx.signal.aborted) {
        if (wt) await removeWorktree(git, wt)
        throw new Error("the commander's turn was interrupted")
      }
      // A child that could not spawn further hides the tools that would try (D15).
      const deep = session.depth + 1 >= session.maxDepth
      const model = roleModel(role, task.model, api.settings.agents)
      let child: ChildSession
      try {
        child = session.spawn!({
          ...(task.role ? { role: task.role } : {}),
          title: titleOf(task),
          prompt: task.prompt,
          ...(model ? { model } : {}),
          ...(task.context ? { context: task.context } : {}),
          ...(wt ? { cwd: wt.cwd } : {}),
          ...(role?.tools ? { tools: role.tools } : {}),
          ...(deep ? { excludeTools: [AGENT_TOOL, AGENT_RESULT_TOOL] } : {}),
          systemPrompt: childInstructions(role, wt),
        })
      } catch (err) {
        if (wt) await removeWorktree(git, wt)
        throw err
      }
      const activity: Activity = { files: new Set(), commands: 0 }
      const watching = watch(child, activity).catch(() => {})
      const job: Job = {
        child,
        role: task.role ?? "agent",
        title: titleOf(task),
        prompt: task.prompt,
        startedAt: Date.now(),
        report: Promise.resolve(""),
        waiters: 0,
      }
      job.report = (async () => {
        const r = await child.result()
        await watching
        let changes = changesLine(activity)
        let leftBehind = false
        if (wt) {
          const tree = wt
          // Only a child that finished its task is merged; half-done work is kept for review.
          const unfinished = job.cancelled
            ? "was stopped along with its commander"
            : r.status !== "done"
              ? `ended with status ${r.status}`
              : undefined
          try {
            const merged = await serialized(() =>
              unfinished
                ? keepChanges(git, tree)
                : mergeWorktree(git, tree, {
                    ...(api.settings.merge?.reviewThreshold
                      ? { threshold: api.settings.merge.reviewThreshold }
                      : {}),
                    review: (title, diff, options) => api.ui.reviewDiff(title, diff, options),
                  }),
            )
            changes = mergeLine(merged, tree, unfinished)
            leftBehind = merged.outcome === "kept" || merged.outcome === "partial"
          } catch (err) {
            changes = `Worktree: merging failed (${err instanceof Error ? err.message : String(err)}); its changes stay in ${tree.dir}.`
            leftBehind = true
          }
        }
        const text = reportOf(job, r, changes, note)
        job.done = text
        job.result = r
        if (job.orphaned && leftBehind) {
          api.reportError(`sub-agent ${child.id} (${job.role}) ended after its commander stopped: ${changes}`)
        }
        job.onDone?.()
        return text
      })()
      return job
    }

    /**
     * Files a background job under its commander. With a notice its report is sent to the
     * commander by itself when it finishes; without one it waits for agent_result.
     */
    const adopt = (commander: string, job: Job, notice: PendingNotice | undefined) => {
      const mine = background.get(commander) ?? new Map<string, Job>()
      background.set(commander, mine)
      mine.set(job.child.id, job)
      if (!notice) return
      job.notice = notice
      job.onDone = () => finished(commander, job)
      if (job.done !== undefined) finished(commander, job)
    }

    /** A background job's report is ready: send it, unless an agent_result call is waiting for it. */
    const finished = (commander: string, job: Job) => {
      if (!job.notice || job.waiters > 0) return
      background.get(commander)?.delete(job.child.id)
      delivered.add(job.child.id)
      let batch = batches.get(commander)
      if (!batch) {
        batch = { jobs: [], timer: setTimeout(() => flush(commander), BATCH_MS) }
        batches.set(commander, batch)
      }
      batch.jobs.push(job)
    }

    /** Sends the reports that finished close together as one message. */
    const flush = (commander: string) => {
      const batch = batches.get(commander)
      if (!batch) return
      batches.delete(commander)
      const [first, ...rest] = batch.jobs
      first?.notice?.deliver(noticeMessage(batch.jobs))
      for (const j of rest) j.notice?.cancel()
    }

    /** Tells the commander the ids of the jobs it started in the background. */
    const startedInBackground = (jobs: Job[], failed: string[], auto: boolean) => {
      const started = jobs.map((j) => `${j.child.id} (${j.role}: ${j.title})`).join(", ")
      const next = auto
        ? `Their results come to you by themselves, as a message, when they finish: do not wait or poll for them. Go on with other work, or end your turn if there is nothing else to do now. Call ${AGENT_RESULT_TOOL} only when you cannot go on without a result.`
        : `Call ${AGENT_RESULT_TOOL} with these ids to get their results before you finish; it waits for them unless wait is false.`
      const text = [
        ...(jobs.length ? [`Started in the background: ${started}. ${next}`] : []),
        ...failed,
      ].join("\n")
      return textResult(text, jobs.length === 0)
    }

    const agentTool = defineTool<AgentParams>({
      name: AGENT_TOOL,
      get description() {
        const list = [...roles().values()].map((r) => `- ${r.name}: ${r.description || "(no description)"}`)
        return `Delegates work to sub-agents: separate agents with their own context that do one task and report back. Use them for self-contained work such as research across many files (explorer), implementing a well-specified change (coder) or reviewing code (reviewer), and to do independent tasks in parallel.
- Several tasks in one call run in parallel (a few at a time; the rest wait their turn).
- A sub-agent sees only its prompt (context "fresh", the default), so write complete instructions: the goal, relevant paths, constraints and what to report back. context "fork" gives it this whole conversation instead.
- isolation "worktree" runs it in its own git worktree; when it finishes its changes are merged into the working tree (a conflict goes to the user for review). Use it for coders that may touch the same files as others.
${
  api.settings.subagents?.background === false
    ? `- The call waits for the sub-agents and returns their results. background: true returns at once with their ids instead: in the main session their results then come to you by themselves as a message when they finish; a sub-agent must collect them with ${AGENT_RESULT_TOOL} before it finishes.`
    : `- In the main session sub-agents always run in the background: the call returns at once with their ids, and when they finish their results come to you by themselves as a message, in a new turn of your own. Do your summary or follow-up work then, even when you need the results to answer: end your turn now (or go on with other work) instead of waiting; background is ignored there and ${AGENT_RESULT_TOOL} only reports progress. A sub-agent's calls wait by default; with background: true it must collect the results with ${AGENT_RESULT_TOOL} before it finishes.`
}
- A result holds each sub-agent's final answer and what it changed.
Roles:
${list.join("\n")}`
      },
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            description: "The sub-agents to run, each with its own task.",
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  maxLength: MAX_TITLE_CHARS,
                  description:
                    'A title of 3–6 words naming the task for the user, e.g. "US market trend" or "Add status bar test".',
                },
                role: { type: "string", description: "Role name (see the list above)." },
                prompt: { type: "string", description: "The complete task for the sub-agent." },
                model: {
                  type: "string",
                  description: 'Optional "provider/model" to run it on; default: the role\'s model or yours.',
                },
                context: {
                  type: "string",
                  enum: ["fresh", "fork"],
                  description: "fresh (default): only the prompt; fork: this whole conversation too.",
                },
                isolation: {
                  type: "string",
                  enum: ["none", "worktree"],
                  description:
                    "worktree: work in a separate git worktree and merge back. Default: the role's, else none.",
                },
              },
              required: ["title", "prompt"],
            },
          },
          background: {
            type: "boolean",
            description:
              "true: return right away with the sub-agents' ids; false: wait for their results. Ignored in the main session, which always runs them in the background (see above).",
          },
        },
        required: ["tasks"],
      },
      concurrency: "parallel",
      async execute(params, ctx) {
        const session = ctx.session
        if (!session?.spawn) return textResult("Sub-agents are not available in this session.", true)
        const tasks = taskList(params)
        if (!tasks.length) {
          return textResult('Give at least one task in "tasks", each with a "title" and a "prompt".', true)
        }
        const untitled = tasks.flatMap((t, i) => titleProblem(t, i) ?? [])
        if (untitled.length) return textResult(untitled.join("\n"), true)
        const known = roles()
        const unknown = tasks.filter((t) => t.role && !known.has(t.role)).map((t) => t.role)
        if (unknown.length) {
          return textResult(
            `Unknown role${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Known roles: ${[...known.keys()].join(", ")}.`,
            true,
          )
        }
        // Results can be sent by themselves only to a session that can be woken: the main one,
        // or a persistent sub-agent.
        const auto = session.expectNotice !== undefined
        // The main session never waits (the user keeps talking to it), whatever the model asks.
        const alwaysBackground = mainAlwaysBackground(session)
        const bg = alwaysBackground || (params.background ?? false)
        const jobs: Job[] = []
        const failed: string[] = []
        // Listening before anything starts: starting (making worktrees) can take seconds. An
        // interrupt stops waiting sub-agents; background ones keep running.
        const stop = () => {
          if (!bg) for (const j of jobs) cancel(j, "the commander's turn was interrupted", true)
        }
        ctx.signal.addEventListener("abort", stop, { once: true })
        try {
          for (const [i, task] of tasks.entries()) {
            if (ctx.signal.aborted) break
            try {
              const job = await start(task, session, ctx)
              jobs.push(job)
              if (bg) adopt(session.sessionId, job, auto ? session.expectNotice?.() : undefined)
              if (ctx.signal.aborted) stop()
            } catch (err) {
              failed.push(
                `Task ${i + 1} (${task.role ?? "agent"}: ${titleOf(task)}) did not start: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }
          if (bg) return startedInBackground(jobs, failed, auto)
          const reports = await Promise.all(jobs.map((j) => j.report))
          return textResult([...failed, ...reports].join("\n\n"), jobs.length === 0)
        } finally {
          ctx.signal.removeEventListener("abort", stop)
        }
      },
    })

    /** Whether `session` runs sub-agents in the background whatever the call says (D79). */
    const mainAlwaysBackground = (session: { expectNotice?: unknown; depth: number }) =>
      session.depth === 0 &&
      session.expectNotice !== undefined &&
      api.settings.subagents?.background !== false

    const resultTool = defineTool<{ ids?: string[]; wait?: boolean }>({
      name: AGENT_RESULT_TOOL,
      description: `Gets the results of sub-agents started in the background with ${AGENT_TOOL}. Waits for them to finish unless wait is false. Without ids, covers every background sub-agent you started whose result you have not received yet. A result is handed out once: one that already came to you as a message is not repeated. In the main session results come by themselves and this never waits: it only reports which are still running.`,
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Sub-agent ids; default all." },
          wait: { type: "boolean", description: "Wait for unfinished ones (default true)." },
        },
      },
      concurrency: "parallel",
      async execute(p, ctx) {
        const mine = ctx.session ? background.get(ctx.session.sessionId) : undefined
        const ids = p.ids?.length ? p.ids : [...(mine?.keys() ?? [])]
        if (!ids.length) return textResult("There are no background sub-agents to collect.")
        const parts: string[] = []
        const batched = (id: string) =>
          [...batches.values()].some((b) => b.jobs.some((j) => j.child.id === id))
        const gone = (id: string) =>
          batched(id)
            ? `${id}: it has ended; its result is on its way to you as a message.`
            : delivered.has(id)
              ? `${id}: its result was already sent to you as a message.`
              : `${id}: no such background sub-agent (or its result was already collected).`
        const found = ids.flatMap((id) => {
          const job = mine?.get(id)
          if (!job) parts.push(gone(id))
          return job ? [job] : []
        })
        // Waiting here would block the main session, whose results come by themselves anyway.
        const wait = p.wait !== false && !(ctx.session && mainAlwaysBackground(ctx.session))
        if (wait) {
          // The turn may have been interrupted before this tool even started.
          const aborted = new Promise<void>((resolve) => {
            if (ctx.signal.aborted) resolve()
            else ctx.signal.addEventListener("abort", () => resolve(), { once: true })
          })
          // While this call waits for a job, its report is handed out here, not sent.
          for (const j of found) j.waiters++
          try {
            await Promise.race([Promise.all(found.map((j) => j.report)), aborted])
          } finally {
            for (const j of found) j.waiters--
          }
        }
        const commander = ctx.session?.sessionId
        if (ctx.signal.aborted && commander) {
          // This result may never reach the model: reports that ended meanwhile go as a notice.
          for (const job of found)
            if (job.done !== undefined && mine?.has(job.child.id)) finished(commander, job)
          return textResult("Interrupted; finished results come to you as a message.", true)
        }
        for (const job of found) {
          if (!mine?.has(job.child.id)) {
            // Another call collected it meanwhile.
            parts.push(gone(job.child.id))
          } else if (job.done !== undefined) {
            parts.push(job.done)
            mine.delete(job.child.id)
            job.notice?.cancel()
          } else {
            const seconds = Math.round((Date.now() - job.startedAt) / 1000)
            parts.push(
              `## ${job.title} · ${job.role} · ${job.child.id} · still running (${seconds}s): ${shorten(job.prompt, 80)}`,
            )
          }
        }
        return textResult(parts.join("\n\n"))
      },
    })

    /** Stops `commander`'s uncollected background jobs and forgets them: nobody will ask for them. */
    const dropBackground = (commander: string, reason: string) => {
      const batch = batches.get(commander)
      if (batch) {
        clearTimeout(batch.timer)
        batches.delete(commander)
        for (const j of batch.jobs) j.notice?.cancel()
      }
      const mine = background.get(commander)
      if (!mine) return
      background.delete(commander)
      for (const j of mine.values()) {
        j.notice?.cancel()
        j.notice = undefined
        if (j.done === undefined) cancel(j, reason, true)
      }
    }
    api.on("turn.end", (e) => {
      // A sub-agent's one turn is its whole life, so its background jobs end with it. The main
      // session's keep running through an interrupt (Esc stops only the turn).
      if (e.parentSessionId !== undefined) dropBackground(e.sessionId, "its commander finished")
    })
    api.on("session.start", (e) => {
      // Another conversation took over (/clear, /resume): nobody will read the old one's results.
      if (e.parentSessionId !== undefined) return
      for (const commander of [...background.keys(), ...batches.keys()]) {
        if (commander !== e.sessionId) dropBackground(commander, "its commander's session was closed")
      }
    })
    api.on("session.end", () => {
      for (const commander of [...background.keys(), ...batches.keys()]) {
        dropBackground(commander, "the session ended")
      }
    })

    api.registerTool(agentTool)
    api.registerTool(resultTool)
    api.registerToolRenderer(AGENT_TOOL, agentPresenter)
    api.registerCommand(agentsCommand())
  })
}

/**
 * Shows an agent call by how many sub-agents it starts; frontends show each one under the
 * call (title, role, time, tokens, what it does), so the result line only sums them up.
 */
export const agentPresenter: ToolPresenter<AgentParams> = {
  summary(args) {
    const n = taskList(args).length
    return `· ${n} sub-agent${n === 1 ? "" : "s"}${args.background ? ` · background` : ""}`
  },
  result(call) {
    if (call.result.isError) return undefined
    if (call.text.startsWith("Started in the background")) return "started in the background"
    const reports = call.text.split("\n").filter((l) => l.startsWith("## ")).length
    if (reports > 1) return `${reports} reports`
    return call.text.split("\n")[0]?.replace(/^#+\s*/, "") || undefined
  },
}

/** The built-in `agent` tool (D12, D27): loaded like any other extension. */
export default createAgentExtension()
