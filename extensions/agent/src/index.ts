import {
  type ChildSession,
  defineExtension,
  defineTool,
  type ExtensionAPI,
  type SubagentResult,
  type ToolContext,
  type ToolSession,
  textResult,
} from "@amira/api"
import { type Isolation, loadRoles, type Role, roleModel } from "./roles.ts"
import {
  createWorktree,
  formatStat,
  keepChanges,
  type MergeResult,
  mergeWorktree,
  type RunGit,
  removeWorktree,
  type Worktree,
} from "./worktree.ts"

export * from "./roles.ts"
export * from "./worktree.ts"

export const AGENT_TOOL = "agent"
export const AGENT_RESULT_TOOL = "agent_result"

export interface AgentTask {
  role?: string
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
  prompt: string
  startedAt: number
  /** Settles with the report for the commander; never rejects. */
  report: Promise<string>
  done?: string
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

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
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
  const head = `## ${job.role} · ${r.sessionId} · ${r.status} (${seconds}s, ${tokens} tokens)`
  const lines = [head]
  if (note) lines.push(note)
  if (r.status !== "done" && r.error) lines.push(`Error: ${r.error}`)
  lines.push(r.text || "(no final answer)")
  lines.push(changes)
  return lines.join("\n\n")
}

function taskList(params: unknown): AgentTask[] {
  const p = params as Partial<AgentParams> & Partial<AgentTask>
  if (Array.isArray(p.tasks)) return p.tasks
  // Tolerates a single task given at the top level.
  return typeof p.prompt === "string" ? [p as AgentTask] : []
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
    /** Background jobs by commander session, then by child id. */
    const background = new Map<string, Map<string, Job>>()
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
        else wt = made
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
        prompt: task.prompt,
        startedAt: Date.now(),
        report: Promise.resolve(""),
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
        if (job.orphaned && leftBehind) {
          api.reportError(`sub-agent ${child.id} (${job.role}) ended after its commander stopped: ${changes}`)
        }
        return text
      })()
      return job
    }

    /** Files background jobs under their commander and tells it their ids. */
    const startedInBackground = (commander: string, jobs: Job[], failed: string[]) => {
      const mine = background.get(commander) ?? new Map<string, Job>()
      background.set(commander, mine)
      for (const j of jobs) mine.set(j.child.id, j)
      const started = jobs.map((j) => `${j.child.id} (${j.role})`).join(", ")
      const text = [
        ...(jobs.length
          ? [
              `Started in the background: ${started}. Call ${AGENT_RESULT_TOOL} with these ids to get their results; it waits for them unless wait is false.`,
            ]
          : []),
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
- background: true returns at once with the sub-agents' ids; get their results later with ${AGENT_RESULT_TOOL}.
- The result holds each sub-agent's final answer and what it changed.
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
              required: ["prompt"],
            },
          },
          background: {
            type: "boolean",
            description: `Return right away with the sub-agents' ids instead of waiting; collect the results with ${AGENT_RESULT_TOOL}.`,
          },
        },
        required: ["tasks"],
      },
      concurrency: "parallel",
      async execute(params, ctx) {
        const session = ctx.session
        if (!session?.spawn) return textResult("Sub-agents are not available in this session.", true)
        const tasks = taskList(params)
        if (!tasks.length) return textResult('Give at least one task in "tasks", each with a "prompt".', true)
        const known = roles()
        const unknown = tasks.filter((t) => t.role && !known.has(t.role)).map((t) => t.role)
        if (unknown.length) {
          return textResult(
            `Unknown role${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Known roles: ${[...known.keys()].join(", ")}.`,
            true,
          )
        }
        const jobs: Job[] = []
        const failed: string[] = []
        // Listening before anything starts: starting (making worktrees) can take seconds.
        const stop = () => {
          for (const j of jobs) cancel(j, "the commander's turn was interrupted", !params.background)
        }
        ctx.signal.addEventListener("abort", stop, { once: true })
        try {
          for (const [i, task] of tasks.entries()) {
            if (ctx.signal.aborted) break
            try {
              const job = await start(task, session, ctx)
              jobs.push(job)
              if (ctx.signal.aborted) stop()
            } catch (err) {
              failed.push(
                `Task ${i + 1} (${task.role ?? "agent"}) did not start: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }
          if (params.background) return startedInBackground(session.sessionId, jobs, failed)
          const reports = await Promise.all(jobs.map((j) => j.report))
          return textResult([...failed, ...reports].join("\n\n"), jobs.length === 0)
        } finally {
          ctx.signal.removeEventListener("abort", stop)
        }
      },
    })

    const resultTool = defineTool<{ ids?: string[]; wait?: boolean }>({
      name: AGENT_RESULT_TOOL,
      description: `Gets the results of sub-agents started with ${AGENT_TOOL} and background: true. Waits for them to finish unless wait is false. Without ids, covers every background sub-agent you started whose result you have not collected yet. A result is handed out once.`,
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
        const found = ids.flatMap((id) => {
          const job = mine?.get(id)
          if (!job) parts.push(`${id}: no such background sub-agent (or its result was already collected).`)
          return job ? [job] : []
        })
        if (p.wait !== false) {
          const aborted = new Promise<void>((resolve) =>
            ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
          )
          await Promise.race([Promise.all(found.map((j) => j.report)), aborted])
        }
        for (const job of found) {
          if (job.done !== undefined) {
            parts.push(job.done)
            mine?.delete(job.child.id)
          } else {
            const seconds = Math.round((Date.now() - job.startedAt) / 1000)
            parts.push(
              `## ${job.role} · ${job.child.id} · still running (${seconds}s): ${shorten(job.prompt, 80)}`,
            )
          }
        }
        return textResult(parts.join("\n\n"))
      },
    })

    api.registerTool(agentTool)
    api.registerTool(resultTool)
  })
}

/** The built-in `agent` tool (D12, D27): loaded like any other extension. */
export default createAgentExtension()
