import type { Message, ToolCallBlock, ToolResultMessage } from "@amira/ai"
import { agentStatusState, type SubagentInfo } from "../commands.ts"
import { clip, formatElapsed, formatTokens, plural } from "../format.ts"
import { AGENT_STATUS_BADGES, DEFAULT_THEME_GLYPHS as glyphs } from "../themes.ts"

/** `text` on one line, cut to `max` terminal cells. */
function oneLine(text: string, max: number, more: string = glyphs.more): string {
  return clip(text.replace(/\s+/g, " ").trim(), max, more)
}

/** How long it has run (or ran), e.g. "12s" or "3m 05s"; "queued" before it starts. */
export function elapsed(info: SubagentInfo, now: number): string {
  const ms = info.durationMs ?? (info.startedAt !== undefined ? now - info.startedAt : undefined)
  return ms === undefined ? "queued" : formatElapsed(ms)
}

/** Tokens, and the cost when the model's prices are known. */
export function usageText(info: SubagentInfo, separator: string = glyphs.separator): string {
  const u = info.usage
  const tokens = `${formatTokens(u.input + u.output + u.cacheRead + u.cacheWrite)} tok`
  return u.cost !== undefined ? `${tokens} ${separator} $${u.cost.toFixed(4)}` : tokens
}

/** A stable badge for plain text, where there is no host theme or animation context. */
function plainBadge(info: SubagentInfo, pad = false): string {
  const badge = AGENT_STATUS_BADGES[agentStatusState(info)]
  return `${badge.symbol} ${pad ? badge.label.padEnd(7) : badge.label}`
}

/** One line about a sub-agent: badge, title, role, id, time and usage, then the task. */
export function subagentSummary(info: SubagentInfo, now: number, taskChars = 60): string {
  return `${plainBadge(info)} ${summary(info, now, taskChars)}`
}

function summary(
  info: SubagentInfo,
  now: number,
  taskChars = 60,
  chrome: { separator: string; more: string } = glyphs,
): string {
  return `${agentHeading(info, now, chrome.separator)} ${chrome.separator} ${oneLine(info.task, taskChars, chrome.more)}`
}

/** Its title and details, leaving the status to the badge before the title. */
function agentHeading(info: SubagentInfo, now: number, separator: string = glyphs.separator): string {
  const known = info.durationMs !== undefined || info.startedAt !== undefined
  const time = info.status !== "queued" && known ? ` ${separator} ${elapsed(info, now)}` : ""
  return `${info.title} ${separator} ${info.role} ${separator} ${info.id}${time} ${separator} ${usageText(info, separator)}`
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
export function callKids(rest: SubagentInfo[], call: ToolCallBlock): SubagentInfo[] {
  if (!rest.some((k) => k.toolCallId !== undefined)) return rest.splice(0, spawnCount(call))
  const mine = rest.filter((k) => k.toolCallId === call.id)
  for (const k of mine) rest.splice(rest.indexOf(k), 1)
  return mine
}

function toolHead(call: ToolCallBlock): string {
  const summary = oneLine(
    Object.values(call.args)
      .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(String)
      .join(" "),
    80,
  )
  return `${call.name}${summary ? ` ${summary}` : ""}`
}

/** The initial task, not subsequent notices or follow-ups, marks a fork's child-owned history. */
export function subagentOwnMessages(info: SubagentInfo, messages: readonly Message[]): readonly Message[] {
  const task = info.task.trim()
  const from = messages.findIndex(
    (message) =>
      message.role === "user" && !message.display?.origin && blockText(message.content).trim() === task,
  )
  // If compaction removed the task, retain available context instead of discarding it at
  // the last notice or follow-up. There is no reliable later user-message boundary.
  return messages.slice(Math.max(0, from))
}

/**
 * A sub-agent's transcript, compactly and as plain text: a header, the task, one line per
 * tool call with a one-line preview of its result (the sub-agents a call started under it),
 * the first line of what it said along the way, and its final reply in full.
 */
export function subagentTranscriptText(
  info: SubagentInfo,
  messages: readonly Message[],
  all: SubagentInfo[],
  now = Date.now(),
): string {
  const out = [`${glyphs.subagent} ${plainBadge(info)} ${agentHeading(info, now)}`]
  const own = subagentOwnMessages(info, messages)
  const task = info.task || (own[0]?.role === "user" ? blockText(own[0].content).trim() : "")
  for (const [i, line] of (task || "(no task)").split("\n").entries())
    out.push(`  ${i === 0 ? glyphs.user : " "} ${line}`)
  out.push("")
  const results = new Map<string, ToolResultMessage>()
  for (const m of own) if (m.role === "toolResult") results.set(m.toolCallId, m)
  const kids = all.filter((s) => s.parentSessionId === info.id)
  const last = own.findLast((m) => m.role === "assistant")
  const finished = !live(info)
  // Only visible blocks break a contiguous tool group, not results or thinking blocks.
  const blocks = own.flatMap((m) =>
    m.role === "assistant"
      ? m.content
          .filter(
            (b) => b.type === "toolCall" || b.type === "serverTool" || (b.type === "text" && b.text.trim()),
          )
          .map((b) => ({ m, b }))
      : [],
  )
  // Plain text has no animation or theme context; use a stable first spinner frame.
  const spinner = "⠋"
  for (const [i, { m, b }] of blocks.entries()) {
    if (b.type === "text") {
      const text = b.text.trim()
      const isFinal = m === last && !m.content.some((x) => x.type === "toolCall")
      if (isFinal) out.push(...text.split("\n").map((line) => (line ? `  ${line}` : "")), "")
      else {
        const first = text.split("\n")[0]!
        out.push(
          `  ${text.includes("\n") ? `${oneLine(first, 98)} ${glyphs.more}` : oneLine(first, 100)}`,
          "",
        )
      }
    } else if (b.type === "serverTool" || b.type === "toolCall") {
      const next = blocks[i + 1]?.b
      const isLast = next?.type !== "toolCall" && next?.type !== "serverTool"
      const tree = `  ${isLast ? glyphs.treeLast : glyphs.treeBranch}`
      if (b.type === "serverTool") {
        // A search the provider ran: what it searched or opened, and how it ended.
        const what = [b.input.query, b.input.url].find((v) => typeof v === "string" && v) as
          | string
          | undefined
        const head = `${b.name}${what ? ` ${oneLine(what, 80)}` : ""}`
        if (b.status === "running" && !finished) out.push(`${tree} ${spinner} ${head}`)
        else {
          const mark =
            b.status === "running"
              ? glyphs.toolInterrupted
              : b.status === "failed"
                ? glyphs.toolFailed
                : glyphs.toolDone
          out.push(`${tree} ${head}  ${mark} ${b.status === "running" ? "did not finish" : b.status}`)
        }
      } else {
        const r = results.get(b.id)
        const head = toolHead(b)
        if (!r)
          out.push(
            finished ? `${tree} ${head}  ${glyphs.toolInterrupted} no result` : `${tree} ${spinner} ${head}`,
          )
        else {
          const lines = blockText(r.content).trim().split("\n")
          const more = lines.length > 1 ? ` (+${plural(lines.length - 1, "line")})` : ""
          const mark = r.rejected ? glyphs.toolInterrupted : r.isError ? glyphs.toolFailed : glyphs.toolDone
          out.push(`${tree} ${head}  ${mark} ${oneLine(lines[0] || "no output", 100)}${more}`)
        }
        if (b.name === "agent") {
          const rail = isLast ? "   " : `  ${glyphs.treePipe}`
          for (const kid of callKids(kids, b))
            out.push(`${rail}  ${glyphs.subagent} ${subagentSummary(kid, now)}`)
        }
      }
      if (isLast) out.push("")
    }
  }
  // Sub-agents started some other way than the agent tool.
  for (const kid of kids) out.push(`${glyphs.subagent} ${subagentSummary(kid, now)}`)
  if (kids.length) out.push("")
  if (info.error && info.status !== "done") out.push(`${glyphs.error} ${info.error}`)
  else if (finished && info.note) out.push(`${glyphs.interrupted} ${info.note}`)
  else if (finished && !last) out.push("(no reply)")
  while (out.at(-1) === "") out.pop()
  return out.join("\n")
}

function live(s: SubagentInfo): boolean {
  return s.status === "running" || s.status === "queued" || s.status === "idle" || s.status === "paused"
}
