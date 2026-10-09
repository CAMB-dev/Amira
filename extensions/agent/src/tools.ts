import {
  DEFAULT_SUBAGENT_BACKGROUND,
  defineTool,
  type ExtensionAPI,
  MAX_TITLE_CHARS,
  type PendingNotice,
  type ToolResult,
  textResult,
} from "@amira/api"
import type { Role } from "./roles.ts"
import { type AgentTask, type Job, type StartChildDeps, shorten, startChild, titleOf } from "./start-child.ts"

export const AGENT_TOOL = "agent"
export const AGENT_RESULT_TOOL = "agent_result"

export interface AgentParams {
  tasks: AgentTask[]
  background?: boolean
}

export const AGENT_PARAMETERS = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
            maxLength: MAX_TITLE_CHARS,
            description: "3–6-word task title for the user.",
          },
          role: { type: "string" },
          prompt: { type: "string" },
          model: {
            type: "string",
            description: '"provider/model"; default: role model or yours.',
          },
          context: {
            type: "string",
            enum: ["fresh", "fork"],
          },
          isolation: {
            type: "string",
            enum: ["none", "worktree"],
            description: "Default: role isolation or none.",
          },
        },
        required: ["title", "prompt"],
      },
    },
    background: { type: "boolean" },
  },
  required: ["tasks"],
}

export const AGENT_RESULT_PARAMETERS = {
  type: "object",
  properties: {
    ids: { type: "array", items: { type: "string" }, description: "Sub-agent ids; default all." },
    wait: { type: "boolean", description: "Wait for unfinished ones (default true)." },
  },
}

export interface BackgroundBatch {
  jobs: Job[]
  timer: ReturnType<typeof setTimeout>
}

export interface AgentToolDeps {
  api: Pick<ExtensionAPI, "settings">
  roles: () => Map<string, Role>
  child: StartChildDeps
  background: Map<string, Map<string, Job>>
  adopt(commander: string, job: Job, notice: PendingNotice | undefined): void
  startedInBackground(jobs: Job[], failed: string[], auto: boolean): ToolResult
  cancel(job: Job, reason: string, orphan: boolean): void
}

export interface ResultToolDeps {
  api: Pick<ExtensionAPI, "settings">
  background: Map<string, Map<string, Job>>
  batches: Map<string, BackgroundBatch>
  delivered: Set<string>
  finished(commander: string, job: Job): void
}

export function taskList(params: unknown): AgentTask[] {
  const p = params as Partial<AgentParams> & Partial<AgentTask>
  if (Array.isArray(p.tasks)) return p.tasks
  // Tolerates a single task given at the top level.
  return typeof p.prompt === "string" ? [p as AgentTask] : []
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

/** Whether `session` runs sub-agents in the background whatever the call says (D79). */
function mainAlwaysBackground(
  api: Pick<ExtensionAPI, "settings">,
  session: { expectNotice?: unknown; depth: number },
) {
  return (
    session.depth === 0 &&
    session.expectNotice !== undefined &&
    (api.settings.subagents?.background ?? DEFAULT_SUBAGENT_BACKGROUND) !== false
  )
}

export function agentTool(deps: AgentToolDeps) {
  return defineTool<AgentParams>({
    name: AGENT_TOOL,
    get description() {
      const list = [...deps.roles().values()].map(
        (r) => `- ${r.name}: ${r.description || "(no description)"}`,
      )
      return `Delegate self-contained tasks to sub-agents in parallel (limited slots). Results include final answers and changes. Reviewer: large/risky changes only.
Fresh (default) sees only prompt: give complete goal, paths, constraints and report requirements. Fork also sees this conversation.
Worktree isolates edits in a git worktree and auto-merges into your working tree; conflicts go to user for review. Choose it for concurrent coders touching the same files.
${
  (deps.api.settings.subagents?.background ?? DEFAULT_SUBAGENT_BACKGROUND) === false
    ? `Calls wait by default. background:true returns ids immediately; main results arrive automatically as messages; children must collect ${AGENT_RESULT_TOOL} before finishing.`
    : `Main always backgrounds, ignoring background, returning ids immediately. Results arrive automatically as messages in a new turn: do other work or end your turn, never wait; summarize/follow up then. ${AGENT_RESULT_TOOL} only reports progress. Child calls wait by default; background:true returns ids and requires collecting ${AGENT_RESULT_TOOL} before finishing.`
}
Roles:
${list.join("\n")}`
    },
    parameters: AGENT_PARAMETERS,
    traits: { readOnly: true },
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
      const known = deps.roles()
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
      const alwaysBackground = mainAlwaysBackground(deps.api, session)
      const bg = alwaysBackground || (params.background ?? false)
      const jobs: Job[] = []
      const failed: string[] = []
      // Listening before anything starts: starting (making worktrees) can take seconds. An
      // interrupt stops waiting sub-agents; background ones keep running.
      const stop = () => {
        if (!bg) for (const j of jobs) deps.cancel(j, "the commander's turn was interrupted", true)
      }
      ctx.signal.addEventListener("abort", stop, { once: true })
      try {
        for (const [i, task] of tasks.entries()) {
          if (ctx.signal.aborted) break
          try {
            const job = await startChild(task, session, ctx, deps.child)
            jobs.push(job)
            if (bg) deps.adopt(session.sessionId, job, auto ? session.expectNotice?.() : undefined)
            if (ctx.signal.aborted) stop()
          } catch (err) {
            failed.push(
              `Task ${i + 1} (${task.role ?? "agent"}: ${titleOf(task)}) did not start: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        if (bg) return deps.startedInBackground(jobs, failed, auto)
        const reports = await Promise.all(jobs.map((j) => j.report))
        return textResult([...failed, ...reports].join("\n\n"), jobs.length === 0)
      } finally {
        ctx.signal.removeEventListener("abort", stop)
      }
    },
  })
}

export function resultTool(deps: ResultToolDeps) {
  return defineTool<{ ids?: string[]; wait?: boolean }>({
    name: AGENT_RESULT_TOOL,
    description: `Collect background ${AGENT_TOOL} results once; results already delivered as messages are not repeated. Omitted ids: all your unreceived results. Waits unless wait:false. Main: results arrive automatically; never waits, only reports progress.`,
    parameters: AGENT_RESULT_PARAMETERS,
    traits: { readOnly: true },
    concurrency: "parallel",
    async execute(p, ctx) {
      const mine = ctx.session ? deps.background.get(ctx.session.sessionId) : undefined
      const ids = p.ids?.length ? p.ids : [...(mine?.keys() ?? [])]
      if (!ids.length) return textResult("There are no background sub-agents to collect.")
      const parts: string[] = []
      const batched = (id: string) =>
        [...deps.batches.values()].some((b) => b.jobs.some((j) => j.child.id === id))
      const gone = (id: string) =>
        batched(id)
          ? `${id}: it has ended; its result is on its way to you as a message.`
          : deps.delivered.has(id)
            ? `${id}: its result was already sent to you as a message.`
            : `${id}: no such background sub-agent (or its result was already collected).`
      const found = ids.flatMap((id) => {
        const job = mine?.get(id)
        if (!job) parts.push(gone(id))
        return job ? [job] : []
      })
      // Waiting here would block the main session, whose results come by themselves anyway.
      const wait = p.wait !== false && !(ctx.session && mainAlwaysBackground(deps.api, ctx.session))
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
          if (job.done !== undefined && mine?.has(job.child.id)) deps.finished(commander, job)
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
}
