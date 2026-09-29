import type {
  CommandCandidate,
  CommandContext,
  CommandDefinition,
  Message,
  SessionControl,
  SubagentInfo,
  ToolCallBlock,
  ToolResultMessage,
} from "@amira/api"

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
}

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** How long it has run (or ran), e.g. "12s" or "3m05s"; "queued" before it starts. */
export function elapsed(info: SubagentInfo, now: number): string {
  const ms = info.durationMs ?? (info.startedAt !== undefined ? now - info.startedAt : undefined)
  if (ms === undefined) return "queued"
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
}

/** Tokens, and the cost when the model's prices are known. */
export function usageText(info: SubagentInfo): string {
  const u = info.usage
  const tokens = `${formatTokens(u.input + u.output + u.cacheRead + u.cacheWrite)} tok`
  return u.cost !== undefined ? `${tokens} · $${u.cost.toFixed(4)}` : tokens
}

/** One line about a sub-agent: title, role, id, state, time and usage, then the task. */
export function subagentSummary(info: SubagentInfo, now: number, taskChars = 60): string {
  return `${info.title} · ${info.role} · ${info.id} · ${stateText(info, now)} · ${usageText(info)} · ${oneLine(info.task, taskChars)}`
}

/** Its status and how long it ran; just the status when that is not known (it never started). */
function stateText(info: SubagentInfo, now: number): string {
  const known = info.durationMs !== undefined || info.startedAt !== undefined
  return info.status === "queued" || !known ? info.status : `${info.status} · ${elapsed(info, now)}`
}

function blockText(content: Message["content"]): string {
  return content.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join("\n")
}

/** How many sub-agents a call of the agent tool starts: one per task. */
function spawnCount(call: ToolCallBlock): number {
  const tasks = (call.args as { tasks?: unknown }).tasks
  return Array.isArray(tasks) ? tasks.length : 1
}

/**
 * Takes the sub-agents an agent call started out of `rest`: those naming the call, or, for
 * sub-agents from before calls were recorded, as many as it had tasks, in order.
 */
function callKids(rest: SubagentInfo[], call: ToolCallBlock): SubagentInfo[] {
  if (!rest.some((k) => k.toolCallId !== undefined)) return rest.splice(0, spawnCount(call))
  const mine = rest.filter((k) => k.toolCallId === call.id)
  for (const k of mine) rest.splice(rest.indexOf(k), 1)
  return mine
}

function toolHead(call: ToolCallBlock, failed: boolean): string {
  const summary = oneLine(
    Object.values(call.args)
      .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(String)
      .join(" "),
    80,
  )
  return `${failed ? "✗" : "●"} ${call.name}${summary ? ` ${summary}` : ""}`
}

/**
 * A sub-agent's transcript, compactly and as plain text: a header, the task, one line per
 * tool call with a one-line preview of its result (the sub-agents a call started under it),
 * the first line of what it said along the way, and its final reply in full.
 */
export function transcriptText(
  info: SubagentInfo,
  messages: readonly Message[],
  all: SubagentInfo[],
  now = Date.now(),
): string {
  const out = [`◆ ${info.title} · ${info.role} · ${info.id} · ${stateText(info, now)} · ${usageText(info)}`]
  // A forked child starts with its parent's history; its own part starts at its task.
  const from = Math.max(
    0,
    messages.findLastIndex((m) => m.role === "user"),
  )
  const own = messages.slice(from)
  const task = own[0]?.role === "user" ? blockText(own[0].content).trim() : info.task
  for (const [i, line] of (task || "(no task)").split("\n").entries())
    out.push(`${i === 0 ? "›" : " "} ${line}`)
  out.push("")
  const results = new Map<string, ToolResultMessage>()
  for (const m of own) if (m.role === "toolResult") results.set(m.toolCallId, m)
  const kids = all.filter((s) => s.parentSessionId === info.id)
  const last = own.findLast((m) => m.role === "assistant")
  const finished = !live(info)
  for (const m of own) {
    if (m.role !== "assistant") continue
    for (const b of m.content) {
      if (b.type === "text" && b.text.trim()) {
        const text = b.text.trim()
        const isFinal = m === last && !m.content.some((x) => x.type === "toolCall")
        if (isFinal) out.push(...text.split("\n"), "")
        else {
          const first = text.split("\n")[0]!
          out.push(first.length > 100 || text.includes("\n") ? `${oneLine(first, 99)}…` : first, "")
        }
      } else if (b.type === "toolCall") {
        const r = results.get(b.id)
        out.push(toolHead(b, r?.isError === true))
        if (!r) out.push(finished ? "  └ (no result)" : "  └ running…")
        else {
          const lines = blockText(r.content).trim().split("\n")
          const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""
          out.push(`  └ ${oneLine(lines[0] || "(no output)", 100)}${more}`)
        }
        if (b.name === "agent") {
          for (const kid of callKids(kids, b)) out.push(`  ◆ ${subagentSummary(kid, now)}`)
        }
        out.push("")
      }
    }
  }
  // Sub-agents started some other way than the agent tool.
  for (const kid of kids) out.push(`◆ ${subagentSummary(kid, now)}`)
  if (kids.length) out.push("")
  if (info.error && info.status !== "done") out.push(`✗ ${info.error}`)
  else if (!finished) out.push(`… ${waitingFor(info)}`)
  else if (!last) out.push("(no reply)")
  while (out.at(-1) === "") out.pop()
  return out.join("\n")
}

/** A sub-agent by its 1-based number in the list, its id, or a unique start of its id. */
export function findSubagent(list: SubagentInfo[], ref: string): SubagentInfo | undefined {
  const r = ref.trim()
  if (/^\d+$/.test(r)) return list[Number(r) - 1]
  const exact = list.find((s) => s.id === r)
  if (exact) return exact
  const starts = list.filter((s) => s.id.startsWith(r))
  return starts.length === 1 ? starts[0] : undefined
}

/** Which one the live view opens on: the latest that is still running, else the latest. */
function defaultView(list: SubagentInfo[]): SubagentInfo | undefined {
  return list.findLast((s) => s.status === "running") ?? list.at(-1)
}

function label(s: SubagentInfo, i: number, now: number): string {
  return `${i + 1}. ${"  ".repeat(Math.max(0, s.depth - 1))}${subagentSummary(s, now)}`
}

function printTranscript(
  ctx: CommandContext,
  session: SessionControl,
  s: SubagentInfo,
  list: SubagentInfo[],
) {
  const messages = session.subagentMessages(s.id) ?? []
  ctx.print(transcriptText(s, messages, list))
}

function openView(ctx: CommandContext, s: SubagentInfo) {
  if (!ctx.openView) throw new Error("the live view needs the interactive terminal UI")
  ctx.openView({ kind: "subagent", sessionId: s.id })
}

/** Not ended: running, waiting for a place to run, or (a persistent one) idle between turns. */
function live(s: SubagentInfo): boolean {
  return s.status === "running" || s.status === "queued" || s.status === "idle"
}

function waitingFor(s: SubagentInfo): string {
  if (s.status === "queued") return "waiting for a free slot"
  return s.status === "idle" ? "idle, waiting for a message" : "still running"
}

/** Stops one sub-agent, or every live one with "all"; says what it did. */
function stop(ctx: CommandContext, list: SubagentInfo[], ref: string) {
  if (!ref) throw new Error("say which: /agents stop <n|id>, or /agents stop all")
  if (ref === "all") {
    const running = list.filter(live)
    if (!running.length) return ctx.print("No sub-agent is running.")
    const stopped = running.filter((s) => ctx.session.stopSubagent(s.id))
    ctx.print(
      stopped.length
        ? `Stopped ${stopped.length} sub-agent${stopped.length === 1 ? "" : "s"}: ${stopped.map((s) => `${s.title} (${s.role} ${s.id})`).join(", ")}.`
        : "No sub-agent is running.",
    )
    return
  }
  const target = findSubagent(list, ref)
  if (!target) throw new Error(`no sub-agent "${ref}"; /agents lists them`)
  if (!live(target) || !ctx.session.stopSubagent(target.id)) {
    ctx.print(`${target.title} (${target.role} ${target.id}) has already ended (${target.status}).`)
    return
  }
  ctx.print(`Stopped ${target.title} (${target.role} ${target.id}).`)
}

/**
 * /agents: this session's sub-agents. Without arguments a picker: choosing one opens the live
 * view on it where the frontend has one (its p prints the snapshot), else prints its transcript.
 * `/agents <n|id>` prints one; `/agents view [<n|id>]` opens the live view on it;
 * `/agents stop <n|id|all>` stops one or every running one.
 */
export function agentsCommand(): CommandDefinition {
  return {
    name: "agents",
    description: "Show the sub-agents of this session and what they did",
    args: {
      hint: "[<n>|<id>|view [<n>|<id>]|stop <n>|<id>|all]",
      complete(prefix, ctx) {
        const list = ctx.session.subagents()
        const now = Date.now()
        // A number is offered as itself, so what was typed stays what runs.
        const ref = (s: SubagentInfo, i: number, typed: string) =>
          /^\d+$/.test(typed) ? String(i + 1) : s.id
        const view = /^view\s+(.*)$/.exec(prefix)
        if (view) {
          // Nothing after it yet: Enter opens the default one, not the first candidate.
          if (!view[1]) return []
          return list.map((s, i) => ({ value: `view ${ref(s, i, view[1]!)}`, description: label(s, i, now) }))
        }
        const stopping = /^stop\s+(.*)$/.exec(prefix)
        if (stopping) {
          const typed = stopping[1]!
          const running = list.flatMap((s, i) =>
            live(s) ? [{ value: `stop ${ref(s, i, typed)}`, description: label(s, i, now) }] : [],
          )
          return running.length
            ? [...running, { value: "stop all", description: "Stop every running one" }]
            : []
        }
        const out: CommandCandidate[] = list.map((s, i) => ({
          value: ref(s, i, prefix),
          description: label(s, i, now),
        }))
        if (/^\d+$/.test(prefix)) return out
        if (list.length) out.push({ value: "view", description: "Open the live view" })
        if (list.some(live)) out.push({ value: "stop", description: "Stop a running sub-agent" })
        return out
      },
    },
    async run(args, ctx) {
      const list = ctx.session.subagents()
      if (!list.length) {
        ctx.print("No sub-agents in this session yet.")
        return
      }
      const stopping = /^stop(?:\s+(.*))?$/.exec(args)
      if (stopping) return stop(ctx, list, stopping[1]?.trim() ?? "")
      const view = /^view(?:\s+(.*))?$/.exec(args)
      if (view) {
        const target = view[1] ? findSubagent(list, view[1]) : defaultView(list)
        if (!target) throw new Error(`no sub-agent "${view[1]}"; /agents lists them`)
        openView(ctx, target)
        return
      }
      if (args) {
        const target = findSubagent(list, args)
        if (!target) throw new Error(`no sub-agent "${args}"; /agents lists them`)
        printTranscript(ctx, ctx.session, target, list)
        return
      }
      const now = Date.now()
      // A digit picks the sub-agent of that number.
      const options = list.map((s, i) => label(s, i, now))
      const title = ctx.openView ? "Sub-agents (Enter opens the live view; p there prints it)" : "Sub-agents"
      const pick = await ctx.ui.select(title, options, { signal: ctx.signal })
      if (pick === undefined) return
      const chosen = list[Number(/^(\d+)\./.exec(pick)?.[1]) - 1]
      if (!chosen) return
      if (ctx.openView) return openView(ctx, chosen)
      // The pick may have taken a while; show it as it is now.
      const fresh = ctx.session.subagents()
      printTranscript(ctx, ctx.session, fresh.find((s) => s.id === chosen.id) ?? chosen, fresh)
    },
  }
}
