import {
  type BackgroundJobInfo,
  type BackgroundJobRegistry,
  type CommandContext,
  type CommandDefinition,
  clip,
  type ExtensionAPI,
  formatElapsed,
  type PanelDefinition,
  plural,
  type SessionControl,
  type SubagentInfo,
  subagentTranscriptText,
} from "@amira/api"
import { STOP_GRACE_MS } from "./jobs.ts"
import { JOB_VIEW, jobsCommand, lastLine } from "./jobs-ui.ts"

interface Task {
  kind: "job" | "monitor" | "agent"
  id: string
  state: BackgroundJobInfo["status"] | SubagentInfo["status"]
  startedAt?: number
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
      state: job.status,
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
        state: agent.status,
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

function taskRow(task: Task, now: number, width = 160): string {
  const state = task.kind === "agent" ? ` ${task.state}` : ""
  const time =
    task.startedAt === undefined ? (state ? "" : " queued") : ` ${formatElapsed(now - task.startedAt)}`
  const head = `${task.kind} ${task.id}${state}${time} | `
  const room = Math.max(0, width - head.length)
  const label = clip(task.label, task.last ? Math.floor(room / 2) : room, "...")
  return clip(`${head}${label}${task.last ? ` | ${oneLine(task.last)}` : ""}`, width, "...")
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
    render({ width, now, collapsed }) {
      const live = tasks(registry, session(), streams)
      if (!live.length) return []
      const counts = ["running", "starting", "queued", "idle", "paused"]
        .map((state) => {
          const count = live.filter((task) => task.state === state).length
          return count ? `${count} ${state}` : ""
        })
        .filter(Boolean)
      const lines = [
        {
          kind: "muted" as const,
          text: [plural(live.length, "background task"), ...counts, "/tasks to see or stop"].join(" | "),
        },
      ]
      return collapsed
        ? lines
        : [...lines, ...live.map((task) => ({ kind: "text" as const, text: taskRow(task, now, width) }))]
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
          description: taskRow(task, Date.now()),
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
      const rows = live.map((task) => taskRow(task, Date.now()))
      if (ctx.frontend === "print") return ctx.print(rows.join("\n"))
      const pick = await ctx.ui.choose("Background tasks", rows, {
        sections: [{ at: 0, choose: ctx.openView ? "open" : "print", keys: [{ key: "x", label: "stop" }] }],
        descriptions: live.map((task) => task.last),
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
