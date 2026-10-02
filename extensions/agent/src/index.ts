import {
  defineExtension,
  type ExtensionAPI,
  formatElapsed,
  type PendingNotice,
  plural,
  type SubagentResult,
  textResult,
  USER_STOP_REASON,
  type UserMessage,
} from "@amira/api"
import { agentsCommand, formatTokens } from "./agents-command.ts"
import { keptWorktrees, sweepNotices } from "./kept-worktrees.ts"
import { agentPresenter } from "./presenter.ts"
import { roles } from "./roles-cache.ts"
import { type Job, type StartChildDeps, shorten } from "./start-child.ts"
import { subagentView } from "./subagent-view.ts"
import { AGENT_RESULT_TOOL, AGENT_TOOL, agentTool, type BackgroundBatch, resultTool } from "./tools.ts"
import { gitWorkspaceProvider } from "./workspace.ts"
import type { RunGit } from "./worktree.ts"

export * from "./agents-command.ts"
export * from "./roles.ts"
export type { AgentTask } from "./start-child.ts"
export * from "./worktree.ts"
export { AGENT_RESULT_TOOL, AGENT_TOOL, agentPresenter }

/** Stops a job whose commander no longer wants it. */
function cancel(job: Job, reason: string, orphan: boolean): void {
  job.cancelled = true
  if (orphan) job.orphaned = true
  job.child.abort(reason)
}

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

/** How long a finished background report waits for others finishing close by, to go as one message. */
export const BATCH_MS = 300

/** How a sub-agent ended, as its line in the transcript marks it: done, failed, stopped. */
const ENDED: Record<SubagentResult["status"], string> = {
  done: "✓",
  error: "✗",
  aborted: "⊘",
}

/** Why it ended other than finishing, for the user's line: the error, or a stop not the user's own. */
function endReason(r: SubagentResult): string | undefined {
  if (r.status === "error") return r.error ? shorten(r.error, 100) : undefined
  if (r.status === "aborted")
    return r.error && r.error !== USER_STOP_REASON ? shorten(r.error, 100) : undefined
  return r.note ? shorten(r.note, 100) : undefined
}

/**
 * The message that brings background reports to their commander: the reports for the model,
 * short lines for the transcript, shaped like a sub-agent's end line under its call
 * ("◆ US market trend ✓ explorer · 41s · 12k tok", why it failed or stopped after it), and
 * where changes it made that were not merged are ("changes kept: 3 files · <patch>").
 */
function noticeMessage(jobs: Pick<Job, "role" | "title" | "done" | "result" | "kept">[]): UserMessage {
  const lines = jobs.flatMap((j) => {
    const r = j.result
    if (!r) return [`◆ ${j.title} ✓ ${j.role}`]
    const u = r.usage
    const tokens = formatTokens(u.input + u.output + u.cacheRead + u.cacheWrite)
    // Why it failed or stopped: its error (not the user's own stop), else the stop's note.
    const why =
      endReason(r) ??
      (r.status === "error"
        ? "failed"
        : r.status === "aborted"
          ? r.note
            ? shorten(r.note, 100)
            : "stopped"
          : "")
    const head = `◆ ${j.title} ${ENDED[r.status]} ${j.role} · ${formatElapsed(r.durationMs)} · ${tokens} tok${why ? ` · ${why}` : ""}`
    const kept = j.kept
      ? [`  changes kept: ${j.kept.files ? `${plural(j.kept.files, "file")} · ` : ""}${j.kept.patch}`]
      : []
    return [head, ...kept]
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

export interface AgentExtensionOptions {
  /** Replaces git, for tests. */
  git?: RunGit
}

export function createAgentExtension(opts: AgentExtensionOptions = {}) {
  return defineExtension((api: ExtensionAPI) => {
    api.registerWorkspaceProvider(gitWorkspaceProvider(api))
    const git = opts.git ?? hostGit(api)
    const dirs = { home: api.home, cwd: api.cwd }
    const reported = new Set<string>()
    const swept = new Set<string>()
    /** Background jobs by commander session, then by child id. */
    const background = new Map<string, Map<string, Job>>()
    /** Reports waiting a moment to be sent together, by commander session. */
    const batches = new Map<string, BackgroundBatch>()
    /** Ids of background sub-agents whose report was sent to their commander as a message. */
    const delivered = new Set<string>()
    /** Worktrees sub-agents of this process work in now: the sweep and /agents leave them alone. */
    const inUse = new Set<string>()
    const getRoles = roles({ api, dirs, reported })
    const notifySweep = sweepNotices(api)
    const kept = keptWorktrees({ api, git, inUse, serialized })
    const childDeps: StartChildDeps = {
      api,
      git,
      roles: getRoles,
      inUse,
      swept,
      sweepNotices: notifySweep,
      serialized,
      excludeTools: [AGENT_TOOL, AGENT_RESULT_TOOL],
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
      // Sub-agents the user stopped by hand do not start a turn: their reports wait for the
      // user's next message.
      const byUser = batch.jobs.every(
        (j) => j.result?.status === "aborted" && j.result.error === USER_STOP_REASON,
      )
      first?.notice?.deliver(noticeMessage(batch.jobs), byUser ? { wake: false } : undefined)
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

    const agent = agentTool({
      api,
      roles: getRoles,
      child: childDeps,
      background,
      adopt,
      startedInBackground,
      cancel,
    })
    const result = resultTool({ api, background, batches, delivered, finished })

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
    api.on("subagent.end", (e) => {
      // A sub-agent's background jobs end with it, not with its turn: a persistent one goes
      // idle between turns and is woken by their reports. The main session's keep running
      // through an interrupt (Esc stops only the turn).
      dropBackground(e.data.childSessionId, "its commander finished")
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

    api.registerTool(agent)
    api.registerTool(result)
    api.registerToolRenderer(AGENT_TOOL, agentPresenter)
    api.registerCommand(agentsCommand({ worktrees: kept }))
    api.registerView(subagentView(api))
  })
}

/** The built-in `agent` tool (D12, D27): loaded like any other extension. */
export default createAgentExtension()
