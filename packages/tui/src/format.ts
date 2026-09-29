import type { SpawnGroupInfo, UserMessage } from "@amira/api"
import { type Theme, truncateToWidth, wrapText } from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

/** Arguments that say what a call is about; the first one present leads the summary. */
const PRIMARY_ARGS = ["path", "file_path", "filePath", "command", "pattern", "url", "query", "prompt", "name"]
/** Longest a labelled argument's value gets in a summary. */
const MAX_LABELLED = 24

function oneLine(v: unknown): string {
  return String(v).replace(/\s+/g, " ").trim()
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * One-line summary of the arguments of a tool without a presenter: the argument that says
 * what the call is about (a path, a command, a pattern, or else the first text), then the
 * other short ones labelled, e.g. `src/a.ts · limit=20`.
 */
export function summarizeArgs(args: Record<string, unknown>, max = 80): string {
  const scalars = Object.entries(args).filter(
    ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  )
  if (!scalars.length) return ""
  let lead = scalars.findIndex(([k]) => PRIMARY_ARGS.includes(k))
  if (lead === -1) lead = scalars.findIndex(([, v]) => typeof v === "string")
  const parts: string[] = []
  if (lead !== -1) parts.push(oneLine(scalars[lead]![1]))
  for (const [i, [k, v]] of scalars.entries()) {
    if (i !== lead) parts.push(`${k}=${cut(oneLine(v), MAX_LABELLED)}`)
  }
  return cut(parts.join(" · "), max)
}

/** A finished call's duration: "0.4s", "12.3s", "2m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

/**
 * Committed lines for the user's message, wrapped to `width` under the prompt symbol: its
 * display text when it has one (a command shows as typed, its note on a line below), else its
 * content.
 */
export function userLines(theme: Theme, message: UserMessage, width = Number.POSITIVE_INFINITY): string[] {
  // A notice (e.g. background sub-agents' results) shows as its short lines, not as typed text.
  if (message.display?.origin && message.display.text.trim()) return originLines(theme, message.display.text)
  const text = (message.display?.text.trim() || userText(message)).trim()
  const rows = Number.isFinite(width)
    ? text.split("\n").flatMap((l) => (l ? wrapText(l, Math.max(10, width - 2)) : [""]))
    : text.split("\n")
  const lines = rows.map((l, i) => `${theme.accent(i === 0 ? glyphs.user : " ")} ${l}`)
  const note = message.display?.note
  if (note) lines.push(`  ${theme.muted(glyphs.result)} ${theme.muted(note)}`)
  return lines
}

/** A notice's lines, e.g. "◆ explorer finished · 41s · 12.3k tok": the marker accented, the rest muted. */
function originLines(theme: Theme, text: string): string[] {
  return text
    .trim()
    .split("\n")
    .map((l) => {
      const m = /^(\s*◆)(.*)$/.exec(l)
      return m ? `${theme.accent(m[1]!)}${theme.muted(m[2]!)}` : theme.muted(l)
    })
}

/** A user message's content as text, with images as placeholders. */
export function userText(message: UserMessage): string {
  return message.content.map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`)).join("\n\n")
}

/**
 * Rows of an assistant reply, rendered at the width less the gutter, as the transcript shows
 * them: indented by the gutter, blank rows left blank.
 */
export function replyRows(rows: string[]): string[] {
  return rows.map((r) => (r === "" ? "" : glyphs.assistant + r))
}

/** A sub-agent as the live area shows it, from its start until its line is committed. */
export interface SubagentLine {
  title: string
  role: string
  depth: number
  /** Unset while it waits for a slot. */
  startedAt?: number
  /** Tokens its replies used so far. */
  tokens: number
  /** Its latest tool call, as its row shows it: `grep` and `"TODO" src`. */
  activity?: { name: string; summary: string }
  /** The text of its latest reply, which becomes its result. */
  lastText?: string
  /** A persistent sub-agent between turns, waiting for a message (subagent.state). */
  idle?: boolean
}

/** Longest summary of a sub-agent's current tool on its row. */
export const ACTIVITY_CHARS = 40

export function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  return n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
}

/** A sub-agent's rows sit under its call like a result, one level deeper per nesting. */
function subagentIndent(depth: number): string {
  return "  ".repeat(Math.max(1, depth))
}

/**
 * A queued or running sub-agent under its call: `└ ◆ title · role · 12s · 4.1k tok`
 * ("queued" while it waits), and once it has called a tool, `│   ● grep "TODO"` below.
 */
/**
 * `last`: no row of the same tree follows at this level, so this one closes it ("└", not "├")
 * and its tool row below has no "│" to carry the tree on.
 */
export function subagentRows(
  sub: SubagentLine,
  now: number,
  width: number,
  theme: Theme,
  last = true,
): string[] {
  const s = glyphs.separator
  const indent = subagentIndent(sub.depth)
  const stats =
    sub.startedAt === undefined
      ? "queued"
      : sub.idle
        ? `idle ${s} ${compactTokens(sub.tokens)} tok`
        : `${formatElapsed(now - sub.startedAt)} ${s} ${compactTokens(sub.tokens)} tok`
  const head = `${indent}${theme.muted(last ? glyphs.result : glyphs.treeBranch)} ${theme.accent(glyphs.subagent)} ${oneLine(sub.title)} ${theme.muted(`${s} ${sub.role} ${s} ${stats}`)}`
  const rows = [truncateToWidth(head, width, glyphs.more)]
  if (sub.startedAt !== undefined && sub.activity && !sub.idle) {
    const summary = cut(oneLine(sub.activity.summary), ACTIVITY_CHARS)
    const tree = `${last ? " " : glyphs.output} ${glyphs.result}`
    const tool = `${indent}${theme.muted(tree)} ${theme.accent(glyphs.toolRunning)} ${theme.accent(sub.activity.name)}${summary ? ` ${theme.muted(summary)}` : ""}`
    rows.push(truncateToWidth(tool, width, glyphs.more))
  }
  return rows
}

/** Elapsed time on a running row: "4s", "1m 05s". */
export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`
}

/**
 * The line a sub-agent's rows become when it ends, committed under its call: how it ended,
 * its time and tokens, and the start of its answer.
 */
export function subagentEndLine(
  sub: SubagentLine,
  end: { status: "done" | "error" | "aborted"; error?: string; durationMs: number; tokens: number },
  width: number,
  theme: Theme,
  last = true,
): string {
  const mark =
    end.status === "done"
      ? theme.success(glyphs.subagentDone)
      : end.status === "error"
        ? theme.error(glyphs.subagentFailed)
        : theme.muted(glyphs.subagentAborted)
  const s = glyphs.separator
  const stats = `${sub.role} ${s} ${formatDuration(end.durationMs)} ${s} ${compactTokens(end.tokens)} tok`
  const said =
    end.status === "error"
      ? theme.error(oneLine(end.error ?? "failed"))
      : end.status === "aborted"
        ? theme.muted("stopped")
        : theme.muted(oneLine(sub.lastText ?? "") || "(no answer)")
  const line = `${subagentIndent(sub.depth)}${theme.muted(last ? glyphs.result : glyphs.treeBranch)} ${theme.accent(glyphs.subagent)} ${oneLine(sub.title)} ${mark} ${theme.muted(`${stats} ${s}`)} ${said}`
  return truncateToWidth(line, width, glyphs.more)
}

/**
 * The one line a compact spawn group (e.g. a workflow run) shows in place of its members'
 * rows: `└ ◆ workflow deep-review · Verify · 3/7 agents · 12.3k tok`, from its owner's status
 * line, or else from its counts.
 */
export function spawnGroupRow(
  group: SpawnGroupInfo,
  depth: number,
  width: number,
  theme: Theme,
  last = true,
): string {
  const s = glyphs.separator
  const a = group.agents
  const counts = [
    `${a.ended}/${a.total} done`,
    ...(a.working ? [`${a.working} working`] : []),
    ...(a.queued ? [`${a.queued} queued`] : []),
    `${compactTokens(group.tokens)} tok`,
  ].join(` ${s} `)
  const about = group.status ? oneLine(group.status) : counts
  const line = `${subagentIndent(depth)}${theme.muted(last ? glyphs.result : glyphs.treeBranch)} ${theme.accent(glyphs.subagent)} ${oneLine(group.name)} ${theme.muted(`${s} ${about}`)}`
  return truncateToWidth(line, width, glyphs.more)
}

/** Whether `list[i]` (a depth-first list) has no later sibling: nothing after it at its depth before its parent's level ends. */
export function isLastSibling(list: { depth: number }[], i: number): boolean {
  const depth = list[i]!.depth
  for (let j = i + 1; j < list.length; j++) {
    const d = list[j]!.depth
    if (d === depth) return false
    if (d < depth) return true
  }
  return true
}
