import {
  clip,
  formatDuration,
  formatElapsed,
  formatTokens,
  type SpawnGroupInfo,
  type UserMessage,
} from "@amira/api"
import {
  RESET,
  type StyleFn,
  type Theme,
  themeToken,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

/** Arguments that say what a call is about; the first one present leads the summary. */
const PRIMARY_ARGS = ["path", "file_path", "filePath", "command", "pattern", "url", "query", "prompt", "name"]
/** Longest a labelled argument's value gets in a summary. */
const MAX_LABELLED = 24

function oneLine(v: unknown): string {
  return String(v).replace(/\s+/g, " ").trim()
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
    if (i !== lead) parts.push(`${k}=${clip(oneLine(v), MAX_LABELLED)}`)
  }
  return clip(parts.join(" · "), max)
}

export { formatDuration, formatElapsed }

/**
 * Committed lines for the user's message, wrapped to `width` under the prompt symbol: its
 * display text when it has one (a command shows as typed, its note on a line below), else its
 * content.
 */
export function userLines(theme: Theme, message: UserMessage, width = Number.POSITIVE_INFINITY): string[] {
  // A notice (e.g. background sub-agents' results) shows as its short lines, not as typed text.
  if (message.display?.origin && message.display.text.trim()) return originLines(theme, message.display.text)
  const text = (message.display?.text.trim() || userText(message)).trim()
  const bg = Number.isFinite(width) ? themeToken(theme, "userBg") : undefined
  // On the band, a cell is left free at the right edge, as at the left.
  const room = width - (bg ? 3 : 2)
  const rows = Number.isFinite(width)
    ? text.split("\n").flatMap((l) => (l ? wrapText(l, Math.max(10, room)) : [""]))
    : text.split("\n")
  const lines = rows.map((l, i) => `${theme.accent(i === 0 ? glyphs.user : " ")} ${l}`)
  const note = message.display?.note
  const muted = (bg && themeToken(theme, "surfaceMuted")) || theme.muted
  if (note) lines.push(`  ${muted(glyphs.result)} ${muted(note)}`)
  return bg ? bandRows(lines, width, bg) : lines
}

/**
 * An echoed command (`› /status`), muted: on the band like the user's messages, since it was
 * typed too, but muted, since it went to Amira rather than to the model.
 */
export function commandEchoLines(theme: Theme, line: string, width: number): string[] {
  const bg = themeToken(theme, "userBg")
  const muted = (bg && themeToken(theme, "surfaceMuted")) || theme.muted
  const rows = wrapText(muted(`${glyphs.user} ${line}`), Math.max(1, width - (bg ? 1 : 0)))
  return bg ? bandRows(rows, width, bg) : rows
}

/**
 * Rows on a band of `bg` the width of the screen, with a blank row of it above and below: each
 * row filled with spaces to exactly `width` (cut to it when wider), so the band ends at the
 * right edge and never wraps.
 */
export function bandRows(rows: string[], width: number, bg: StyleFn): string[] {
  const w = Math.max(1, width)
  // The band's own opening, to start again after a full reset in a row (wrapText and
  // truncateToWidth end a style they cut with one), which would end the band too.
  const open = bg("\0").split("\0")[0]!
  const fill = (row: string) => {
    const fit = visibleWidth(row) > w ? truncateToWidth(row, w) : row
    const body = fit.replaceAll(RESET, RESET + open)
    return bg(body + " ".repeat(Math.max(0, w - visibleWidth(fit))))
  }
  return [fill(""), ...rows.map(fill), fill("")]
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

/** Token counts as every screen writes them: 999, 1.2k, 46k, 2.5M. */
export const compactTokens = formatTokens

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
    const summary = clip(oneLine(sub.activity.summary), ACTIVITY_CHARS)
    const tree = `${last ? " " : glyphs.output} ${glyphs.result}`
    const tool = `${indent}${theme.muted(tree)} ${theme.accent(glyphs.toolRunning)} ${theme.accent(sub.activity.name)}${summary ? ` ${theme.muted(summary)}` : ""}`
    rows.push(truncateToWidth(tool, width, glyphs.more))
  }
  return rows
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
