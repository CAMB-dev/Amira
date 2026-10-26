import {
  AGENT_STATUS_BADGES,
  type AgentStatusState,
  agentStatusState,
  type BackgroundJobInfo,
  type BackgroundJobRegistry,
  type CommandContext,
  type CommandDefinition,
  clip,
  type ExtensionAPI,
  formatElapsed,
  type PanelDefinition,
  type PanelLine,
  type PanelRenderOptions,
  plural,
  type SessionControl,
  type SubagentInfo,
  subagentTranscriptText,
  type ViewSegment,
} from "@amira/api"
import { STOP_GRACE_MS } from "./jobs.ts"
import { JOB_VIEW, jobsCommand, lastLine } from "./jobs-ui.ts"

interface Task {
  kind: "job" | "monitor" | "agent"
  id: string
  /** How the shared status badge shows it. */
  state: AgentStatusState
  startedAt?: number
  /** Set once it has ended, so its time stops there. */
  endedAt?: number
  label: string
  last: string
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
const liveAgent = (s: SubagentInfo) =>
  s.status === "running" || s.status === "queued" || s.status === "idle" || s.status === "paused"

function agentLast(session: SessionControl, id: string): string {
  const messages = session.subagentMessages(id) ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === "user") break
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
    const last = text.split(/\r?\n/).findLast((l) => l.trim())
    if (last) return oneLine(last)
  }
  return ""
}

function jobKind(job: BackgroundJobInfo): "job" | "monitor" {
  return job.kind === "monitor" ? "monitor" : "job"
}

function tasks(
  registry: BackgroundJobRegistry,
  session?: SessionControl,
  streams?: Map<string, string>,
): Task[] {
  return [
    ...registry.running().map((job) => ({
      kind: jobKind(job),
      id: job.id,
      state: "working" as const,
      startedAt: job.startedAt,
      label: oneLine(typeof job.meta.description === "string" ? job.meta.description : job.command),
      last: lastLine(registry, job.id),
    })),
    ...(session
      ?.subagents()
      .filter(liveAgent)
      .map((agent) => ({
        kind: "agent" as const,
        id: agent.id,
        state: agentStatusState(agent),
        startedAt: agent.startedAt,
        label: oneLine(agent.title || agent.task),
        last:
          streams
            ?.get(agent.id)
            ?.split(/\r?\n/)
            .findLast((l) => l.trim()) ?? agentLast(session, agent.id),
      })) ?? []),
  ]
}

/** The task's name in lists: its id, and what it is when that is not a plain job. */
const taskName = (task: Task) => (task.kind === "monitor" ? `${task.id} monitor` : task.id)
const taskTime = (task: Task, now: number) =>
  task.startedAt === undefined ? "" : formatElapsed((task.endedAt ?? now) - task.startedAt)

/** A task that left the live list while it was still shown: its final state and end time. */
function endedTask(task: Task, registry: BackgroundJobRegistry, session: SessionControl, now: number): Task {
  if (task.kind === "agent") {
    const agent = session.subagents().find((agent) => agent.id === task.id)
    if (!agent) return { ...task, state: "stopped", endedAt: now }
    const state = agentStatusState(agent)
    const startedAt = agent.startedAt ?? task.startedAt
    const endedAt =
      startedAt !== undefined && agent.durationMs !== undefined ? startedAt + agent.durationMs : now
    return {
      ...task,
      state: state === "working" || state === "queued" ? "stopped" : state,
      startedAt,
      endedAt,
    }
  }
  const job = registry.get(task.id)
  const state: AgentStatusState =
    job?.status === "exited"
      ? job.exitCode === 0
        ? "done"
        : "failed"
      : job?.status === "failed"
        ? "failed"
        : "stopped"
  return { ...task, state, endedAt: job?.endedAt ?? now }
}

/** "job1 · 7s · bun run dev --watch", as the /tasks picker and completions show a task. */
function taskRow(task: Task, now: number, separator = "·"): string {
  return [taskName(task), taskTime(task, now), task.label].filter(Boolean).join(` ${separator} `)
}

/**
 * A panel row: the shared status badge, then name, elapsed time, label and last output line,
 * the name and time padded so every row's columns line up.
 */
function taskSegments(
  task: Task,
  opts: PanelRenderOptions,
  columns: { name: number; time: number },
): ViewSegment[] {
  const separator = ` ${opts.glyphs?.separator ?? "·"} `
  const badge = AGENT_STATUS_BADGES[task.state]
  const head: ViewSegment[] = [
    ...(opts.statusBadge?.(task.state, { pad: true }) ?? [{ kind: badge.role, text: badge.label.padEnd(7) }]),
    { kind: "muted", text: ` ${taskName(task).padEnd(columns.name)}${separator}` },
    { kind: "muted", text: `${taskTime(task, opts.now).padStart(columns.time)}${separator}` },
  ]
  // Badge, name and time are one cell per character.
  const room = Math.max(0, opts.width - head.reduce((n, part) => n + part.text.length, 0))
  const last = oneLine(task.last)
  const label = clip(task.label, last ? Math.max(8, Math.floor(room / 2)) : room, opts.glyphs?.more ?? "…")
  return [
    ...head,
    { kind: "text", text: label },
    ...(last ? [{ kind: "muted" as const, text: `${separator}${last}` }] : []),
  ]
}

/** Jobs, monitors and live sub-agents share one foldable live panel. */
export function tasksPanel(
  registry: BackgroundJobRegistry,
  session: () => SessionControl | undefined = () => undefined,
  streams?: Map<string, string>,
): PanelDefinition {
  return {
    id: "background-jobs",
    order: 10,
    render(opts) {
      const live = tasks(registry, session(), streams)
      if (!live.length) return []
      const counts = (Object.keys(AGENT_STATUS_BADGES) as AgentStatusState[])
        .map((state) => {
          const count = live.filter((task) => task.state === state).length
          return count ? `${count} ${AGENT_STATUS_BADGES[state].label}` : ""
        })
        .filter(Boolean)
      const separator = ` ${opts.glyphs?.separator ?? "·"} `
      const lines: PanelLine[] = [
        {
          kind: "muted",
          text: [plural(live.length, "background task"), ...counts, "/tasks to see or stop"].join(separator),
        },
      ]
      if (opts.collapsed) return lines
      const columns = {
        name: Math.max(...live.map((task) => taskName(task).length)),
        time: Math.max(...live.map((task) => taskTime(task, opts.now).length)),
      }
      return [
        ...lines,
        ...live.map((task) => ({ kind: "segments" as const, parts: taskSegments(task, opts, columns) })),
      ]
    },
  }
}

/** Reuse the existing job output and sub-agent transcript views. */
async function show(task: Task, registry: BackgroundJobRegistry, ctx: CommandContext) {
  if (task.kind !== "agent") {
    if (ctx.openView?.({ kind: JOB_VIEW, data: { id: task.id } })) return
    return jobsCommand(registry).run(task.id, ctx)
  }
  if (ctx.openView?.({ kind: "subagent", data: { sessionId: task.id } })) return
  const agents = ctx.session.subagents()
  const agent = agents.find((agent) => agent.id === task.id)
  if (!agent) throw new Error(`sub-agent ${task.id} is gone`)
  ctx.print(subagentTranscriptText(agent, ctx.session.subagentMessages(task.id) ?? [], agents))
}

async function stop(task: Task, registry: BackgroundJobRegistry, ctx: CommandContext): Promise<boolean> {
  if (task.kind === "agent") {
    const agent = ctx.session.subagents().find((agent) => agent.id === task.id)
    return !!agent && liveAgent(agent) && ctx.session.stopSubagent(task.id)
  }
  const job = registry.get(task.id)
  if (!job || (job.status !== "starting" && job.status !== "running")) return false
  const ended = await registry.stop(task.id, STOP_GRACE_MS)
  return ended.status !== "starting" && ended.status !== "running"
}

export function tasksCommand(registry: BackgroundJobRegistry): CommandDefinition {
  return {
    name: "tasks",
    description: "Show or stop live jobs, monitors and sub-agents",
    args: {
      hint: "[list|view <id>|<id>|stop <id|all>]",
      complete(prefix, ctx) {
        const live = tasks(registry, ctx.session)
        const action = /^(stop|view)\s/.exec(prefix)?.[1]
        const candidates = live.map((task) => ({
          value: `${action ? `${action} ` : ""}${task.id}`,
          description: `${AGENT_STATUS_BADGES[task.state].label} · ${taskRow(task, Date.now())}`,
        }))
        if (action === "stop" && live.length)
          candidates.push({ value: "stop all", description: "Stop every live task" })
        if (!action)
          candidates.push(
            { value: "list", description: "List live tasks" },
            { value: "view", description: "View a live task" },
            { value: "stop", description: "Stop a live task" },
          )
        return candidates
      },
    },
    async run(args, ctx) {
      const live = tasks(registry, ctx.session)
      const stopping = /^stop(?:\s+(.*))?$/.exec(args)
      const viewing = /^view(?:\s+(.*))?$/.exec(args)
      const ref = (stopping?.[1] ?? viewing?.[1] ?? args).trim()
      if (stopping && !stopping[1]?.trim()) throw new Error("say which task to stop: /tasks stop <id|all>")
      if (viewing && !viewing[1]?.trim()) throw new Error("say which task to view: /tasks view <id>")
      if (stopping && ref === "all") {
        const stopped = await Promise.all(live.map((task) => stop(task, registry, ctx)))
        const count = stopped.filter(Boolean).length
        return ctx.print(
          live.length
            ? `Stopped ${plural(count, "background task")}.${count < live.length ? " Some tasks have ended or are still stopping." : ""}`
            : "No live background tasks.",
        )
      }
      if (args && args !== "list") {
        const task = live.find((task) => task.id === ref)
        if (!task) throw new Error(`no live task "${ref}"; /tasks lists them`)
        if (stopping)
          return ctx.print(
            (await stop(task, registry, ctx))
              ? `Stopped ${task.id}.`
              : `${task.id} has ended or is still stopping.`,
          )
        return show(task, registry, ctx)
      }
      if (!live.length) return ctx.print("No live background tasks. /jobs and /agents show completed work.")
      const separator = () => ctx.glyphs?.().separator ?? "·"
      const rows = live.map((task) => taskRow(task, Date.now(), separator()))
      const ended: (Task | undefined)[] = []
      if (ctx.frontend === "print")
        return ctx.print(
          live.map((task, i) => `${AGENT_STATUS_BADGES[task.state].label} ${rows[i]}`).join("\n"),
        )
      const pick = await ctx.ui.choose("Background tasks", rows, {
        sections: [{ at: 0, choose: ctx.openView ? "open" : "print", keys: [{ key: "x", label: "stop" }] }],
        optionStatuses: live.map((task) => task.state),
        descriptions: live.map((task) => oneLine(task.last)),
        // The same tasks in the same order: only their times, states and last lines move on.
        // One that ends keeps its row with its final state and its time stopped at the end.
        live: () => {
          const now = new Map(tasks(registry, ctx.session).map((task) => [task.id, task]))
          const shown = live.map((task, i) => {
            const current = now.get(task.id)
            if (current) return current
            ended[i] ??= endedTask(task, registry, ctx.session, Date.now())
            return ended[i]
          })
          return {
            optionLabels: shown.map((task) => taskRow(task, Date.now(), separator())),
            optionStatuses: shown.map((task) => task.state),
            descriptions: shown.map((task) => oneLine(task.last)),
          }
        },
        signal: ctx.signal,
      })
      if (!pick) return
      const task = live[rows.indexOf(pick.option)]
      if (!task) return
      if (pick.key === "x")
        return ctx.print(
          (await stop(task, registry, ctx))
            ? `Stopped ${task.id}.`
            : `${task.id} has ended or is still stopping.`,
        )
      await show(task, registry, ctx)
    },
  }
}

export function registerTasks(api: ExtensionAPI, registry: BackgroundJobRegistry): void {
  const streams = new Map<string, string>()
  api.registerPanel(tasksPanel(registry, () => api.session?.(), streams))
  api.registerCommand(tasksCommand(registry))
  api.on("message.start", (e) => {
    if (e.parentSessionId !== undefined) streams.delete(e.sessionId)
  })
  api.on("message.delta", (e) => {
    if (e.parentSessionId === undefined || e.data.kind !== "text") return
    const text = `${streams.get(e.sessionId) ?? ""}${e.data.text}`
    streams.set(e.sessionId, text.slice(-2000))
    api.requestRender()
  })
  api.on("message.end", (e) => {
    if (e.parentSessionId === undefined) return
    streams.delete(e.sessionId)
    api.requestRender()
  })
  api.on("subagent.start", () => api.requestRender())
  api.on("subagent.state", () => api.requestRender())
  api.on("subagent.end", (e) => {
    streams.delete(e.data.childSessionId)
    api.requestRender()
  })
  api.on("session.start", (e) => {
    if (e.parentSessionId === undefined) streams.clear()
  })
}
