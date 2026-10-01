import path from "node:path"
import {
  type ChildSession,
  type ExtensionAPI,
  formatDuration,
  type PendingNotice,
  type SubagentResult,
  type ToolContext,
  type ToolSession,
} from "@amira/api"
import { formatTokens } from "./agents-command.ts"
import { type Isolation, type Role, roleModel } from "./roles.ts"
import {
  createWorktree,
  formatStat,
  keepChanges,
  type MergeResult,
  mergeWorktree,
  type RunGit,
  releaseWorktree,
  removeWorktree,
  type SweepResult,
  sweepWorktrees,
  type Worktree,
} from "./worktree.ts"

export interface AgentTask {
  role?: string
  /** A few words naming the task, shown to the user: "US market trend". */
  title: string
  prompt: string
  model?: string
  context?: "fresh" | "fork"
  isolation?: Isolation
}

/** What a child did in the shared directory, seen from its tool calls. */
interface Activity {
  files: Set<string>
  commands: number
}

/** A started sub-agent and the report it ends in. */
export interface Job {
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
  /** Changes it made that were not merged: how many files, and the patch that holds them. */
  kept?: { files: number; patch: string }
}

export interface StartChildDeps {
  api: Pick<ExtensionAPI, "home" | "settings" | "ui" | "reportError">
  git: RunGit
  roles: () => Map<string, Role>
  /** Worktrees currently owned by this process. */
  inUse: Set<string>
  /** Repositories whose old worktrees have already been swept in this process. */
  swept: Set<string>
  sweepNotices: (sweep: SweepResult) => void
  serialized<T>(work: () => Promise<T>): Promise<T>
  excludeTools: readonly string[]
}

export function shorten(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** A task's title on one line; empty when it has none. */
export function titleOf(task: AgentTask): string {
  return typeof task.title === "string" ? task.title.replace(/\s+/g, " ").trim() : ""
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
  const paths = new Map<string, string[]>()
  for await (const e of child.events) {
    if (e.sessionId !== child.id) continue
    if (e.type === "tool.execute.start" && e.data.traits?.writesFiles) {
      if (e.data.writtenPaths) paths.set(e.data.toolCallId, e.data.writtenPaths)
    } else if (e.type === "tool.execute.end" && !e.data.rejected && !e.data.result.isError) {
      for (const p of e.data.writtenPaths ?? paths.get(e.data.toolCallId) ?? []) {
        const relative = path.isAbsolute(p) ? path.relative(child.cwd, p) || "." : p
        activity.files.add(relative)
      }
      if (e.data.traits?.shell) activity.commands++
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
  const took = formatDuration(r.durationMs)
  const tokens = formatTokens(r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite)
  const head = `## ${job.title} · ${job.role} · ${r.sessionId} · ${r.status} (${took}, ${tokens} tokens)`
  const lines = [head]
  if (note) lines.push(note)
  if (r.status !== "done" && r.error) lines.push(`Error: ${r.error}`)
  lines.push(r.text || "(no final answer)")
  lines.push(changes)
  return lines.join("\n\n")
}

export async function startChild(
  task: AgentTask,
  session: ToolSession,
  ctx: ToolContext,
  deps: StartChildDeps,
): Promise<Job> {
  const role = task.role ? deps.roles().get(task.role) : undefined
  const isolation = task.isolation ?? role?.isolation ?? "none"
  let wt: Worktree | undefined
  let note: string | undefined
  if (isolation === "worktree") {
    const made = await createWorktree(deps.git, {
      cwd: ctx.cwd,
      home: deps.api.home,
      name: `sa_${crypto.randomUUID().slice(0, 8)}`,
      about: { title: titleOf(task), role: task.role ?? "agent" },
    })
    if ("error" in made) note = `No worktree (${made.error}); it worked in the shared directory.`
    else {
      wt = made
      deps.inUse.add(made.dir)
      // Once per repository and process: clear out what earlier sessions left behind (D62),
      // never without telling the user a day before.
      if (!deps.swept.has(made.root)) {
        deps.swept.add(made.root)
        const sweep = await sweepWorktrees(deps.git, {
          root: made.root,
          home: deps.api.home,
          keep: deps.inUse,
        }).catch(() => undefined)
        if (sweep) deps.sweepNotices(sweep)
      }
    }
  }
  // Making the worktree takes a while; the commander may have been interrupted meanwhile.
  if (ctx.signal.aborted) {
    if (wt) {
      deps.inUse.delete(wt.dir)
      releaseWorktree(wt.dir)
      await removeWorktree(deps.git, wt)
    }
    throw new Error("the commander's turn was interrupted")
  }
  // A child that could not spawn further hides the tools that would try (D15).
  const deep = session.depth + 1 >= session.maxDepth
  const model = roleModel(role, task.model, deps.api.settings.agents)
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
      ...(deep ? { excludeTools: [...deps.excludeTools] } : {}),
      systemPrompt: childInstructions(role, wt),
    })
  } catch (err) {
    if (wt) {
      deps.inUse.delete(wt.dir)
      releaseWorktree(wt.dir)
      await removeWorktree(deps.git, wt)
    }
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
      let unfinished: string | undefined
      try {
        const merged = await deps.serialized(() => {
          // Decided when its turn to merge comes: its commander may have stopped it while
          // it waited in line behind another merge.
          unfinished = job.cancelled
            ? "was stopped along with its commander"
            : r.status !== "done"
              ? `ended with status ${r.status}`
              : undefined
          return unfinished
            ? keepChanges(deps.git, tree)
            : mergeWorktree(deps.git, tree, {
                ...(deps.api.settings.merge?.reviewThreshold
                  ? { threshold: deps.api.settings.merge.reviewThreshold }
                  : {}),
                who: `"${job.title}" (${job.role})`,
                review: (title, diff, options) => deps.api.ui.reviewDiff(title, diff, options),
              })
        })
        changes = mergeLine(merged, tree, unfinished)
        leftBehind = merged.outcome === "kept" || merged.outcome === "partial"
        if (leftBehind) job.kept = { files: merged.stat.files.length, patch: tree.patch }
      } catch (err) {
        changes = `Worktree: merging failed (${err instanceof Error ? err.message : String(err)}); its changes stay in ${tree.dir}.`
        leftBehind = true
        job.kept = { files: 0, patch: tree.patch }
      } finally {
        deps.inUse.delete(tree.dir)
        releaseWorktree(tree.dir)
      }
    }
    const text = reportOf(job, r, changes, note)
    job.done = text
    job.result = r
    if (job.orphaned && leftBehind) {
      deps.api.reportError(
        `sub-agent ${child.id} (${job.role}) ended after its commander stopped: ${changes}`,
      )
    }
    job.onDone?.()
    return text
  })()
  return job
}
