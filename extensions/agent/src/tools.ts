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
      return `Delegates work to sub-agents: separate agents with their own context that do one task and report back. Use them for self-contained work such as research across many files (explorer), implementing a well-specified change (coder) or reviewing code (reviewer), and to do independent tasks in parallel. Use a reviewer only when the change is large or risky, not for small or mechanical edits.
- Several tasks in one call run in parallel (a few at a time; the rest wait their turn).
- A sub-agent sees only its prompt (context "fresh", the default), so write complete instructions: the goal, relevant paths, constraints and what to report back. context "fork" gives it this whole conversation instead.
- isolation "worktree" runs it in its own git worktree; when it finishes its changes are merged into the working tree (a conflict goes to the user for review). Use it for coders that may touch the same files as others.
${
  (deps.api.settings.subagents?.background ?? DEFAULT_SUBAGENT_BACKGROUND) === false
    ? `- The call waits for the sub-agents and returns their results. background: true returns at once with their ids instead: in the main session their results then come to you by themselves as a message when they finish; a sub-agent must collect them with ${AGENT_RESULT_TOOL} before it finishes.`
    : `- In the main session sub-agents always run in the background: the call returns at once with their ids, and when they finish their results come to you by themselves as a message, in a new turn of your own. Do your summary or follow-up work then, even when you need the results to answer: end your turn now (or go on with other work) instead of waiting; background is ignored there and ${AGENT_RESULT_TOOL} only reports progress. A sub-agent's calls wait by default; with background: true it must collect the results with ${AGENT_RESULT_TOOL} before it finishes.`
}
- A result holds each sub-agent's final answer and what it changed.
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
    description: `Gets the results of sub-agents started in the background with ${AGENT_TOOL}. Waits for them to finish unless wait is false. Without ids, covers every background sub-agent you started whose result you have not received yet. A result is handed out once: one that already came to you as a message is not repeated. In the main session results come by themselves and this never waits: it only reports which are still running.`,
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
