import {
  type AgentStatusState,
  agentStatusState,
  type CompactionInfo,
  clip,
  formatDuration,
  formatElapsed,
  formatTokens,
  plural,
  type SpawnGroupInfo,
  subagentStateText,
  type UserMessage,
} from "@amira/api"
import {
  bold,
  italic,
  RESET,
  Spinner,
  type StyleFn,
  type Theme,
  themeToken,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "@amira/tui-kit"
import { localClock } from "./clock.ts"
import { asciiGlyphs, glyphs, viewEllipsis } from "./glyphs.ts"
import { CONTENT_INSET, contentRoom, MARKER_WIDTH, markerPrefix } from "./grid.ts"
import { messageNoticeLines } from "./message-notice.ts"
import { styledStatusBadge } from "./status-badge.ts"

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
export function summarizeArgs(
  args: Record<string, unknown>,
  max = 80,
  separator = "·",
  ellipsis = "…",
): string {
  const scalars = Object.entries(args).filter(
    ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  )
  if (!scalars.length) return ""
  let lead = scalars.findIndex(([k]) => PRIMARY_ARGS.includes(k))
  if (lead === -1) lead = scalars.findIndex(([, v]) => typeof v === "string")
  const parts: string[] = []
  if (lead !== -1) parts.push(oneLine(scalars[lead]![1]))
  for (const [i, [k, v]] of scalars.entries()) {
    if (i !== lead) parts.push(`${k}=${clip(oneLine(v), MAX_LABELLED, ellipsis)}`)
  }
  return clip(parts.join(` ${separator} `), max, ellipsis)
}

export { formatDuration, formatElapsed, localClock }

const storedClocks = new WeakMap<object, number>()

/** Attach entry metadata without changing messages passed to providers/extensions. */
export function rememberMessageTime(message: object, at: number): void {
  if (Number.isFinite(at)) storedClocks.set(message, at)
}

/** Old sessions have no message time: never substitute the time they were resumed. */
export function messageTimestamp(message: object): number | undefined {
  if (!("timestamp" in message)) return storedClocks.get(message)
  const at = message.timestamp
  return typeof at === "number" && Number.isFinite(at) ? at : storedClocks.get(message)
}

/**
 * Every clock (header, user band, sticky prompt, reply and tool rows) ends two cells in from
 * the right edge, as transcript text starts two cells in, so they all share one right edge.
 */
export const CLOCK_INSET = 2

/** Whether a row `width` cells wide shows the clock for `at`. */
function showsClock(width: number, at: number | undefined): at is number {
  return at !== undefined && Number.isFinite(width) && width - CLOCK_INSET >= 16
}

/**
 * Room for content before a row's clock: two cells between content and the clock, which ends
 * at the shared clock edge. Without a clock the row keeps its full width.
 */
export function timestampRoom(width: number, at: number | undefined): number {
  return showsClock(width, at) ? width - CLOCK_INSET - visibleWidth(localClock(at)) - 2 : width
}

interface TimestampDecoration {
  /** Row carrying the clock, after any painted band padding. */
  line: number
  /** Actual clock text and the cells added by its gap and text. */
  text: string
  width: number
  /** End of the real content in display cells, before the timestamp's gap. */
  to: number
}

const rowTimestamps = new WeakMap<readonly string[], TimestampDecoration>()
const userBandPadding = new WeakMap<readonly string[], number>()

/** Painted blank rows at each end of a user band, not transcript gaps. */
export function userBandPaddingIn(lines: readonly string[]): number {
  return userBandPadding.get(lines) ?? 0
}

/** Metadata exists only when a clock was actually appended to these rendered rows. */
export function timestampIn(lines: readonly string[]): TimestampDecoration | undefined {
  return rowTimestamps.get(lines)
}

/** Decorate one row, without cutting Markdown, extension output, or image placeholders. */
export function timestampRow(
  row: string,
  theme: Theme,
  width: number,
  at: number | undefined,
  record?: (stamp: TimestampDecoration) => void,
): string {
  if (!showsClock(width, at)) return row
  const text = localClock(at)
  const cells = visibleWidth(text)
  const gap = width - CLOCK_INSET - visibleWidth(row) - cells
  if (gap < 2) return row
  record?.({ line: 0, text, width: gap + cells, to: visibleWidth(row.trimEnd()) })
  return `${row}${" ".repeat(gap)}${theme.muted(text)}`
}

/** Stamp the first content row, retaining the actual decoration for selection/copying. */
export function stampRows(lines: string[], theme: Theme, width: number, at: number | undefined): string[] {
  const line = userBandPaddingIn(lines)
  if (lines[line] !== undefined)
    lines[line] = timestampRow(lines[line]!, theme, width, at, (stamp) =>
      rowTimestamps.set(lines, { ...stamp, line }),
    )
  return lines
}

/**
 * Committed lines for the user's message, wrapped to `width` under the prompt symbol: its
 * display text when it has one (a command shows as typed, its note on a line below), else its
 * content.
 */
export function userLines(
  theme: Theme,
  message: UserMessage,
  width = Number.POSITIVE_INFINITY,
  at = messageTimestamp(message),
  maxTextRows = Number.POSITIVE_INFINITY,
): string[] {
  // A notice (e.g. background sub-agents' results) shows as its short lines, not as typed text.
  if (message.display?.origin && message.display.text.trim())
    return messageNoticeLines(theme, message.display, width)
  const text = (message.display?.text.trim() || userText(message)).trim()
  const bg = Number.isFinite(width) ? themeToken(theme, "userBg") : undefined
  const painted = !!bg && bg(" ") !== " "
  // The band bleeds to the edges; its prompt occupies the marker gutter and its text starts two cells in.
  const inset = MARKER_WIDTH
  const room = Math.max(1, width - inset)
  const firstRoom = Math.max(1, timestampRoom(width, at) - inset)
  let rows = Number.isFinite(width) ? wrapText(text, room, firstRoom) : text.split("\n")
  if (rows.length > maxTextRows) {
    rows = rows.slice(0, maxTextRows)
    const last = rows.length - 1
    rows[last] = truncateToWidth(rows[last]! + viewEllipsis(), last === 0 ? firstRoom : room, viewEllipsis())
  }
  const lines = rows.map((l, i) => {
    const prompt = theme.accent(i === 0 ? glyphs.user : " ")
    return `${markerPrefix(i === 0 && bg && bg(" ") !== " " ? bold(prompt) : prompt)}${l}`
  })
  const note = message.display?.note
  const muted = (bg && themeToken(theme, "surfaceMuted")) || theme.muted
  // The note wraps under its text, past "└ ", rather than being cut at the band's edge.
  if (note) {
    const noteRows = Number.isFinite(width) ? wrapText(note, Math.max(1, width - 2)) : [note]
    for (const [i, r] of noteRows.entries())
      lines.push(`${markerPrefix(i === 0 ? muted(glyphs.result) : "")}${muted(r)}`)
  }
  // Identity surface tokens (plain/custom themes) must not add invisible blank padding.
  if (painted) {
    lines.unshift("")
    lines.push("")
    userBandPadding.set(lines, 1)
  }
  // Clocks on painted bands are readable secondary text, not dim structural chrome.
  stampRows(lines, userBandPaddingIn(lines) ? { ...theme, muted } : theme, width, at)
  return bg ? bandRows(lines, width, bg) : lines
}

/** An echoed command (`› /status`): plain muted text, not a message band for the model. */
export function commandEchoLines(theme: Theme, line: string, width: number): string[] {
  // Its rows after the first hang under the text, past the prompt symbol, as a message's do.
  const gutter = MARKER_WIDTH
  const room = Math.max(1, width - gutter)
  return wrapText(line, room).map(
    (r, i) => `${theme.muted(`${i === 0 ? markerPrefix(glyphs.user) : " ".repeat(gutter)}${r}`)}`,
  )
}

/**
 * Rows on a band of `bg` the width of the screen: each row filled with spaces to exactly
 * `width` (cut to it when wider). The transcript, not the band, owns inter-block blank rows.
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
  const lines = rows.map(fill)
  const stamp = timestampIn(rows)
  if (stamp) rowTimestamps.set(lines, stamp)
  const padding = userBandPaddingIn(rows)
  if (padding) userBandPadding.set(lines, padding)
  return lines
}

/**
 * What the model thought before it answered: `∴ Thought for 12s` (`∴ Thought` when the time is
 * not known, as in a resumed session; `∴ Thinking` while it goes on), and `expanded`, the text
 * under it in muted italics, wrapped to `width`.
 */
export function reasoningLines(
  theme: Theme,
  text: string,
  opts: {
    durationMs?: number
    thinking?: boolean
    expanded?: boolean
    expandKey?: string
    timestamp?: number
  },
  width: number,
): string[] {
  const time =
    opts.durationMs === undefined
      ? ""
      : ` for ${opts.durationMs < 10_000 ? Math.max(0.1, Math.round(opts.durationMs / 100) / 10) : Math.round(opts.durationMs / 1000)}s`
  const thinking = theme.muted
  const body = text.trim()
  const hint =
    body && !opts.expanded && opts.expandKey ? `  ${theme.muted(`${opts.expandKey} to expand`)}` : ""
  const head = `${markerPrefix(thinking(glyphs.thought))}${thinking(opts.thinking ? "Thinking" : `Thought${time}`)}${hint}`
  const lines = stampRows(
    [truncateToWidth(head, Math.max(1, timestampRoom(width, opts.timestamp)), viewEllipsis())],
    theme,
    width,
    opts.timestamp,
  )
  if (!opts.expanded || !body) return lines
  const style = (s: string) => theme.muted(italic(s))
  const room = contentRoom(width)
  for (const l of body.split("\n")) {
    if (!l.trim()) lines.push("")
    else for (const r of wrapText(l, room)) lines.push(`${CONTENT_INSET}${style(r)}`)
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
export function replyRows(rows: string[], markerRows?: ReadonlySet<string>): string[] {
  return rows.map((r) => {
    if (r === "") return ""
    if (markerRows?.has(r)) return r
    // Code fills bleed through the marker column, while their text keeps the shared inset.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR background opener
    const background = /^\x1b\[48;[^m]*m/.exec(r)?.[0] ?? ""
    return background + glyphs.assistant + r
  })
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
  /** A user pause holds the current turn without completing it. */
  paused?: boolean
  /** Also used when a persistent child's next turn is waiting for admission. */
  queued?: boolean
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
const treeArm = (last: boolean) =>
  truncateToWidth(last ? glyphs.treeLast : glyphs.treeBranch, MARKER_WIDTH, "")
const treeGap = (last: boolean) => " ".repeat(Math.max(0, MARKER_WIDTH - visibleWidth(treeArm(last))))
const treeRail = (open: boolean) => markerPrefix(open ? glyphs.treePipe : "")

export function treeIndent(depth: number, open: readonly boolean[] = []): string {
  let s = ""
  for (let level = 1; level < Math.max(1, depth); level++) s += treeRail(open[level] ?? false)
  return s
}

/**
 * For each row of a depth-first list of sub-agents: its rails and whether it closes its level.
 * Child trees close independently of their owning tool's output. The legacy second argument
 * is kept for callers that used to leave the top level open before a tool result.
 */
export function treeLayout(list: { depth: number }[], _closeTop = true): { indent: string; last: boolean }[] {
  const open: boolean[] = []
  return list.map((item, i) => {
    const last = isLastSibling(list, i)
    const indent = treeIndent(item.depth, open)
    open.length = item.depth + 1
    open[item.depth] = !last
    return { indent, last }
  })
}

/**
 * `title` cut so that `rest` (what follows it on the row: stats) still fits in `room` cells;
 * when stats leave less than a readable title, the row is cut at its end as usual.
 */
function fitTitle(title: string, rest: string, room: number): string {
  const left = room - visibleWidth(rest)
  return left >= Math.min(3, visibleWidth(title)) ? truncateToWidth(title, left, viewEllipsis()) : title
}

const defaultSpinner = new Spinner().glyph

/**
 * A sub-agent under its call: `└ ⠋ working title · role · 12s · 4.1k tok`
 * (a shared status badge while it waits or pauses), and once it has called a tool,
 * `│ └ ⠋ grep "TODO"` below. On a
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
  spinner = defaultSpinner,
): string[] {
  const s = glyphs.separator
  const state = agentStatusState(sub)
  const stats =
    state === "queued"
      ? ""
      : state === "idle"
        ? ` ${s} ${compactTokens(sub.tokens)} tok`
        : ` ${s} ${formatElapsed(now - (sub.startedAt ?? now))} ${s} ${compactTokens(sub.tokens)} tok`
  const mark = styledStatusBadge(state, theme, spinner, { pad: true })
  const lead = `${indent}${treeArm(last)}${treeGap(last)}${mark} `
  const rest = ` ${s} ${sub.role}${stats}`
  const title = fitTitle(oneLine(sub.title), rest, width - visibleWidth(lead))
  const head = `${theme.muted(`${indent}${treeArm(last)}`)}${treeGap(last)}${mark} ${title}${theme.muted(rest)}`
  const rows = [truncateToWidth(head, width, viewEllipsis())]
  if (state === "working" && sub.activity) {
    const summary = clip(oneLine(sub.activity.summary), ACTIVITY_CHARS)
    const tree = `${indent}${treeRail(!last)}${treeArm(true)}`
    const tool = `${theme.muted(tree)}${treeGap(true)}${theme.accent(spinner)} ${theme.fg2(sub.activity.name)}${summary ? ` ${theme.muted(summary)}` : ""}`
    rows.push(truncateToWidth(tool, width, viewEllipsis()))
  }
  return rows
}

/**
 * A finished child's compact row: status, title, role, time and tokens only. Its answer and
 * failure details remain in its transcript and the parent's result, not an inline excerpt.
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
  const mark = styledStatusBadge(agentStatusState(end), theme, undefined, { pad: true })
  const s = glyphs.separator
  const stats = `${sub.role} ${s} ${formatDuration(end.durationMs)} ${s} ${compactTokens(end.tokens)} tok`
  const lead = `${indent}${treeArm(last)}${treeGap(last)}${mark} `
  const title = fitTitle(oneLine(sub.title), ` ${s} ${stats}`, width - visibleWidth(lead))
  const line = `${theme.muted(`${indent}${treeArm(last)}`)}${treeGap(last)}${mark} ${title} ${theme.muted(`${s} ${stats}`)}`
  return truncateToWidth(line, width, viewEllipsis())
}

/** Shared presentation counts, including terminal members whose exact outcome is unknown. */
export type AgentCounts = Record<AgentStatusState | "ended" | "total", number>

export function agentCounts(sources: readonly Parameters<typeof agentStatusState>[0][]): AgentCounts {
  const counts: AgentCounts = {
    total: sources.length,
    working: 0,
    queued: 0,
    paused: 0,
    idle: 0,
    done: 0,
    failed: 0,
    stopped: 0,
    ended: 0,
  }
  for (const source of sources) counts[agentStatusState(source)]++
  return counts
}

/** Core snapshots already separate paused members from working admission slots. */
export function spawnGroupCounts(group: SpawnGroupInfo): AgentCounts {
  const counts = agentCounts([])
  const a = group.agents
  const o = group.outcomes
  counts.total = a.total
  counts.working = a.working
  counts.queued = a.queued
  counts.paused = a.paused ?? 0
  counts.idle = a.idle
  counts.done = o?.done ?? 0
  counts.failed = o?.failed ?? 0
  counts.stopped = o?.stopped ?? 0
  counts.ended = Math.max(0, a.ended - counts.done - counts.failed - counts.stopped)
  return counts
}

/** Only working members animate; success requires every member to have actually finished. */
export function agentCountsMark(counts: AgentCounts, theme: Theme, spinner = defaultSpinner): string {
  if (counts.working) return theme.accent(asciiGlyphs() ? Spinner.ascii(spinner) : spinner)
  if (counts.paused) return theme.warning(glyphs.statusPaused)
  if (counts.queued) return theme.dim(glyphs.statusQueued)
  const terminal = counts.done + counts.failed + counts.stopped
  if (counts.total > 0 && terminal === counts.total && !counts.idle && !counts.ended) {
    if (counts.done === counts.total) return theme.success(glyphs.subagentDone)
    if (counts.failed === counts.total) return theme.error(glyphs.subagentFailed)
    if (counts.stopped === counts.total) return theme.warning(glyphs.statusStopped)
  }
  return theme.muted(glyphs.statusIdle)
}

/** Explicit state words survive a folded tree, rather than relabeling every live member running. */
export function agentCountsText(counts: AgentCounts, doneFraction = false): string {
  return (["done", "failed", "stopped", "ended", "working", "paused", "queued", "idle"] as const)
    .filter((state) => counts[state] > 0)
    .map(
      (state) =>
        `${counts[state]}${state === "done" && doneFraction ? `/${counts.total}` : ""} ${state === "ended" ? "ended" : subagentStateText(state)}`,
    )
    .join(` ${glyphs.separator} `)
}

/** The state a group's badge shows: live work first, then any failure, then how it ended. */
function groupState(counts: AgentCounts): AgentStatusState {
  if (counts.working) return "working"
  if (counts.paused) return "paused"
  if (counts.queued) return "queued"
  if (counts.idle || counts.ended) return "idle"
  if (counts.failed) return "failed"
  if (counts.stopped) return "stopped"
  return counts.done ? "done" : "idle"
}

/** A compact group's aggregate mark is successful only when every member finished successfully. */
export function spawnGroupMark(group: SpawnGroupInfo, theme: Theme, spinner = defaultSpinner): string {
  return agentCountsMark(spawnGroupCounts(group), theme, spinner)
}

/**
 * The one line a compact spawn group (e.g. a workflow run) shows in place of its members'
 * rows, using definitive terminal outcomes rather than treating every ended member as done.
 */
export function spawnGroupRow(
  group: SpawnGroupInfo,
  depth: number,
  width: number,
  theme: Theme,
  last = true,
  indent = treeIndent(depth),
  spinner = defaultSpinner,
): string {
  const s = glyphs.separator
  const tally = spawnGroupCounts(group)
  const states = agentCountsText(tally, true)
  const counts = [states, `${compactTokens(group.tokens)} tok`].filter(Boolean).join(` ${s} `)
  const name = oneLine(group.name)
  // A status that repeats the name or a count ("1 queued") adds nothing: its other facts stay.
  const shown = new Set(counts.split(` ${s} `))
  const status = group.status
    ? oneLine(group.status)
        .split(/ [·.] /)
        .filter((part) => part !== name && !name.endsWith(` ${part}`) && !shown.has(part))
        .join(` ${s} `)
    : ""
  const about = status ? `${counts} ${s} ${status}` : counts
  // The members' shared badge, symbol and label, for the state most of them are in now.
  const badge = styledStatusBadge(groupState(tally), theme, spinner, { pad: true })
  const line = `${theme.muted(`${indent}${treeArm(last)}`)}${treeGap(last)}${badge} ${name} ${theme.muted(`${s} ${about}`)}`
  return truncateToWidth(line, width, viewEllipsis())
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
