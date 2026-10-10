import {
  type CompactionInfo,
  clip,
  formatDuration,
  formatElapsed,
  formatTokens,
  plural,
  type SpawnGroupInfo,
  type UserMessage,
} from "@amira/api"
import {
  italic,
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
  if (message.display?.origin && message.display.text.trim())
    return originLines(theme, message.display.text, width)
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
  // The note wraps under its text, past "└ ", rather than being cut at the band's edge.
  if (note) {
    const noteRows = Number.isFinite(width) ? wrapText(note, Math.max(4, room - 2)) : [note]
    for (const [i, r] of noteRows.entries())
      lines.push(`  ${i === 0 ? muted(glyphs.result) : " "} ${muted(r)}`)
  }
  return bg ? bandRows(lines, width, bg) : lines
}

/**
 * An echoed command (`› /status`), muted: on the band like the user's messages, since it was
 * typed too, but muted, since it went to Amira rather than to the model.
 */
export function commandEchoLines(theme: Theme, line: string, width: number): string[] {
  const bg = themeToken(theme, "userBg")
  const muted = (bg && themeToken(theme, "surfaceMuted")) || theme.muted
  // Its rows after the first hang under the text, past the prompt symbol, as a message's do.
  const gutter = visibleWidth(glyphs.user) + 1
  const room = Math.max(1, width - (bg ? 1 : 0) - gutter)
  const rows = wrapText(line, room).map((r, i) =>
    muted(`${i === 0 ? `${glyphs.user} ` : " ".repeat(gutter)}${r}`),
  )
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

/** How a sub-agent's line marks how it ended, styled. */
function endMark(theme: Theme, mark: string): string {
  if (mark === glyphs.subagentDone) return theme.success(mark)
  if (mark === glyphs.subagentFailed) return theme.error(mark)
  return theme.muted(mark)
}

/**
 * A notice's lines, e.g. "◆ US market trend ✓ explorer · 41s · 12k tok": the marker accented,
 * how it ended in its color, the rest muted. Wrapped to `width`, later rows (and indented lines
 * such as "changes kept: …") hanging under the text after the marker.
 */
function originLines(theme: Theme, text: string, width = Number.POSITIVE_INFINITY): string[] {
  const hang = " ".repeat(visibleWidth(`${glyphs.subagent} `))
  return text
    .trim()
    .split("\n")
    .flatMap((l) => {
      const m = /^\s*◆ (.*)$/.exec(l)
      const body = (m ? m[1]! : l.trim()).trim()
      const rows = Number.isFinite(width) ? wrapText(body, Math.max(10, width - hang.length)) : [body]
      return rows.map((r, i) => {
        const lead = i === 0 && m ? `${theme.accent(glyphs.subagent)} ` : hang
        // The title, then how it ended: ✓ ✗ ⊘ in their colors.
        const end = i === 0 && m ? /^(.*?) ([✓✗⊘]) (.*)$/.exec(r) : null
        const shown = end
          ? `${theme.muted(end[1]!)} ${endMark(theme, end[2]!)} ${theme.muted(end[3]!)}`
          : theme.muted(r)
        return `${lead}${shown}`
      })
    })
}

/**
 * What the model thought before it answered: `∴ Thought for 12s` (`∴ Thought` when the time is
 * not known, as in a resumed session; `∴ Thinking` while it goes on), and `expanded`, the text
 * under it in muted italics, wrapped to `width`.
 */
export function reasoningLines(
  theme: Theme,
  text: string,
  opts: { durationMs?: number; thinking?: boolean; expanded?: boolean },
  width: number,
): string[] {
  const time = opts.durationMs === undefined ? "" : ` for ${formatElapsed(Math.max(1000, opts.durationMs))}`
  const thinking = themeToken(theme, "thinking") ?? theme.muted
  const head = `${thinking(glyphs.thought)} ${thinking(opts.thinking ? "Thinking" : `Thought${time}`)}`
  const body = text.trim()
  const lines = [truncateToWidth(head, Math.max(1, width), glyphs.more)]
  if (!opts.expanded || !body) return lines
  const style = (s: string) => theme.muted(italic(s))
  const room = Math.max(10, width - 2)
  for (const l of body.split("\n")) {
    if (!l.trim()) lines.push("")
    else for (const r of wrapText(l, room)) lines.push(`  ${style(r)}`)
  }
  return lines
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

/**
 * Why a compaction happened: "Compacted automatically at 82% of 128k", "Compacted (you
 * asked)", ...; plain "Compacted" when that is unknown (a compaction stored before it was kept).
 * A server-side one says so: "Compacted by the server (openai) automatically at 82% of 128k".
 */
export function compactionReason(info: CompactionInfo | undefined): string {
  const by = info?.native ? ` by the server (${info.native.provider})` : ""
  switch (info?.reason) {
    case "threshold": {
      const { tokensBefore: t, contextWindow: w } = info
      return t !== undefined && w
        ? `Compacted${by} automatically at ${Math.round((t / w) * 100)}% of ${compactTokens(w)}`
        : `Compacted${by} automatically`
    }
    case "manual":
      return by ? `Compacted${by} as you asked` : "Compacted (you asked)"
    case "overflow":
      return `Compacted${by} after the model rejected the request as too long`
    default:
      return `Compacted${by}`
  }
}

/**
 * The context before and (estimated) after a compaction, "105k → ~12k tokens", when known.
 * Not for `overflow`: the size before is the last reply's, smaller than the rejected request.
 */
export function compactionSizes(info: CompactionInfo | undefined): string | undefined {
  if (info?.tokensBefore === undefined || info.tokensAfter === undefined) return undefined
  if (info.reason === "overflow") return undefined
  return `${compactTokens(info.tokensBefore)} → ~${compactTokens(info.tokensAfter)} tokens`
}

/**
 * The notice a compaction leaves: "Compacted automatically at 82% of 128k: 14 older messages
 * into a summary (105k → ~12k tokens)."
 */
export function compactionNotice(replaced: number, info: CompactionInfo | undefined): string {
  const sizes = compactionSizes(info)
  const what = info?.native
    ? plural(replaced, "older message")
    : `${plural(replaced, "older message")} into a summary`
  const line = `${compactionReason(info)}: ${what}${sizes ? ` (${sizes})` : ""}.`
  // The provider has server-side compaction on, but it did not work this time.
  return info?.fallback
    ? `${line}\nThe server could not compact, so the model wrote the summary: ${info.fallback}`
    : line
}

/**
 * The tree in front of a sub-agent's rows: under its call, then for each level above its own a
 * "│" where that ancestor has more rows after it at its level (else blanks), so nested trees
 * keep their lines. Without `open`, blanks only.
 */
export function treeIndent(depth: number, open: readonly boolean[] = []): string {
  let s = "  "
  for (let level = 1; level < Math.max(1, depth); level++) s += open[level] ? `${glyphs.output} ` : "  "
  return s
}

/**
 * For each row of a depth-first list of sub-agents: the tree in front of it and whether it
 * closes its level. With `closeTop` false, only a nested row can close a level (a finished
 * call's result line comes after them).
 */
export function treeLayout(list: { depth: number }[], closeTop = true): { indent: string; last: boolean }[] {
  const open: boolean[] = []
  return list.map((item, i) => {
    const last = (closeTop || item.depth > 1) && isLastSibling(list, i)
    const indent = treeIndent(item.depth, open)
    open.length = item.depth + 1
    open[item.depth] = !last
    return { indent, last }
  })
}

/**
 * `title` cut so that `rest` (what follows it on the row: stats) still fits in `room` cells;
 * when even a short title leaves no room, the row is cut at its end as usual.
 */
function fitTitle(title: string, rest: string, room: number): string {
  const left = room - visibleWidth(rest)
  return left >= 8 ? clip(title, left, glyphs.more) : title
}

/**
 * A queued or running sub-agent under its call: `└ ◆ title · role · 12s · 4.1k tok`
 * ("queued" while it waits), and once it has called a tool, `│   ● grep "TODO"` below. On a
 * narrow screen the title gives way before its role, time and tokens.
 *
 * `last`: no row of the same tree follows at this level, so this one closes it ("└", not "├")
 * and its tool row below has no "│" to carry the tree on. `indent`: the tree in front of it
 * (treeLayout); by default blanks as deep as it is.
 */
export function subagentRows(
  sub: SubagentLine,
  now: number,
  width: number,
  theme: Theme,
  last = true,
  indent = treeIndent(sub.depth),
): string[] {
  const s = glyphs.separator
  const stats =
    sub.startedAt === undefined
      ? "queued"
      : sub.idle
        ? `idle ${s} ${compactTokens(sub.tokens)} tok`
        : `${formatElapsed(now - sub.startedAt)} ${s} ${compactTokens(sub.tokens)} tok`
  const lead = `${indent}${last ? glyphs.result : glyphs.treeBranch} ${glyphs.subagent} `
  const rest = ` ${s} ${sub.role} ${s} ${stats}`
  const title = fitTitle(oneLine(sub.title), rest, width - visibleWidth(lead))
  const head = `${theme.muted(`${indent}${last ? glyphs.result : glyphs.treeBranch}`)} ${theme.accent(glyphs.subagent)} ${title}${theme.muted(rest)}`
  const rows = [truncateToWidth(head, width, glyphs.more)]
  if (sub.startedAt !== undefined && sub.activity && !sub.idle) {
    const summary = clip(oneLine(sub.activity.summary), ACTIVITY_CHARS)
    const tree = `${indent}${last ? " " : glyphs.output} ${glyphs.result}`
    const tool = `${theme.muted(tree)} ${theme.accent(glyphs.toolRunning)} ${theme.accent(sub.activity.name)}${summary ? ` ${theme.muted(summary)}` : ""}`
    rows.push(truncateToWidth(tool, width, glyphs.more))
  }
  return rows
}

/**
 * The line a sub-agent's rows become when it ends, committed under its call: how it ended,
 * its time and tokens, and the start of its answer (or why it failed or stopped). The answer
 * gives way first on a narrow screen, then the title.
 */
export function subagentEndLine(
  sub: SubagentLine,
  end: {
    status: "done" | "error" | "aborted"
    error?: string
    /** Why it ended early without failing (stopped, turn limit). */
    note?: string
    durationMs: number
    tokens: number
  },
  width: number,
  theme: Theme,
  last = true,
  indent = treeIndent(sub.depth),
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
        ? theme.muted(oneLine(end.note ?? "") || "stopped")
        : theme.muted(oneLine(sub.lastText ?? "") || "(no answer)")
  const lead = `${indent}${last ? glyphs.result : glyphs.treeBranch} ${glyphs.subagent} `
  const title = fitTitle(oneLine(sub.title), ` ✓ ${stats} ${s} …`, width - visibleWidth(lead))
  const line = `${theme.muted(`${indent}${last ? glyphs.result : glyphs.treeBranch}`)} ${theme.accent(glyphs.subagent)} ${title} ${mark} ${theme.muted(`${stats} ${s}`)} ${said}`
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
  indent = treeIndent(depth),
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
  const line = `${theme.muted(`${indent}${last ? glyphs.result : glyphs.treeBranch}`)} ${theme.accent(glyphs.subagent)} ${oneLine(group.name)} ${theme.muted(`${s} ${about}`)}`
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
