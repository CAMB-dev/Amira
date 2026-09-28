import type { UserMessage } from "@amira/api"
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
  const text = (message.display?.text.trim() || userText(message)).trim()
  const rows = Number.isFinite(width)
    ? text.split("\n").flatMap((l) => (l ? wrapText(l, Math.max(10, width - 2)) : [""]))
    : text.split("\n")
  const lines = rows.map((l, i) => `${theme.accent(i === 0 ? glyphs.user : " ")} ${l}`)
  const note = message.display?.note
  if (note) lines.push(`  ${theme.muted(glyphs.result)} ${theme.muted(note)}`)
  return lines
}

/** A user message's content as text, with images as placeholders. */
export function userText(message: UserMessage): string {
  return message.content.map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`)).join("\n\n")
}

/** A sub-agent as the live area shows it while it is queued or running. */
export interface SubagentLine {
  role: string
  task: string
  depth: number
  /** Unset while it waits for a slot. */
  startedAt?: number
  /** Tokens its replies used so far. */
  tokens: number
  /** What it does right now, e.g. its latest tool call: "grep TODO". */
  activity?: string
  /** The text of its latest reply, which becomes its result. */
  lastText?: string
}

export function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  return n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
}

/**
 * One line per sub-agent, indented by depth: role, elapsed time and tokens first, so they
 * survive a narrow terminal, then what it is doing (its latest tool call) or its task.
 */
export function subagentLines(subs: SubagentLine[], now: number, width: number, theme: Theme): string[] {
  if (!subs.length) return []
  const lines = subs.map((s) => {
    const when =
      s.startedAt === undefined ? "queued" : `${Math.max(0, Math.floor((now - s.startedAt) / 1000))}s`
    const stats = `${when} · ${compactTokens(s.tokens)} tok`
    const doing = s.activity
      ? `${theme.accent(glyphs.toolRunning)} ${theme.muted(oneLine(s.activity))}`
      : theme.muted(oneLine(s.task))
    const line = `${"  ".repeat(Math.max(0, s.depth - 1))}${theme.accent(glyphs.subagent)} ${s.role} ${theme.muted(`· ${stats} ·`)} ${doing}`
    return truncateToWidth(line, width, "…")
  })
  return [...lines, ""]
}

/** The line committed when a sub-agent ends: how it ended, its time and tokens, and its answer. */
export function subagentEndLine(
  sub: SubagentLine,
  end: { status: "done" | "error" | "aborted"; error?: string; durationMs: number; tokens: number },
  width: number,
  theme: Theme,
): string {
  const mark =
    end.status === "done"
      ? theme.success(glyphs.subagentDone)
      : end.status === "error"
        ? theme.error(glyphs.subagentFailed)
        : theme.muted(glyphs.subagentAborted)
  const stats = `${formatDuration(end.durationMs)} · ${compactTokens(end.tokens)} tok`
  const said =
    end.status === "error"
      ? theme.error(oneLine(end.error ?? "failed"))
      : end.status === "aborted"
        ? theme.muted("stopped")
        : theme.muted(oneLine(sub.lastText ?? "") || "(no answer)")
  const line = `${"  ".repeat(Math.max(0, sub.depth - 1))}${theme.accent(glyphs.subagent)} ${sub.role} ${mark} ${theme.muted(`${stats} ·`)} ${said}`
  return truncateToWidth(line, width, "…")
}
