import type { Message, ToolResult, UserMessage } from "@amira/api"
import { type Theme, truncateToWidth, visibleWidth } from "@amira/tui-kit"

/** One-line summary of tool arguments, e.g. `read src/index.ts` or `bash bun test`. */
export function summarizeArgs(args: Record<string, unknown>, max = 80): string {
  const s = Object.values(args)
    .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(String)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function resultText(result: ToolResult): string {
  return result.content
    .map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`))
    .join("\n")
    .trim()
}

/**
 * The committed lines for a finished tool call: a header and a one-line result preview,
 * each fitted to `width` so a tool call always takes exactly two rows.
 */
export function toolLines(
  theme: Theme,
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
  durationMs: number,
  width = 80,
): string[] {
  const failed = result.isError === true
  // A cross, not just a red dot: failure should not depend on seeing color.
  const bullet = failed ? theme.error("✗") : theme.success("●")
  const summary = summarizeArgs(args)
  const head = `${bullet} ${theme.accent(name)}${summary ? ` ${summary}` : ""}`
  const text = resultText(result)
  const lines = text ? text.split("\n") : []
  const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""
  const time = durationMs >= 1000 ? ` · ${(durationMs / 1000).toFixed(1)}s` : ""
  const suffix = more + time
  const room = Math.max(8, width - 4 - visibleWidth(suffix))
  const first = truncateToWidth(lines[0] ?? "(no output)", room, "…")
  const preview = failed ? theme.error(first) : theme.muted(first)
  return [truncateToWidth(head, width, "…"), `  ${theme.muted("⎿")} ${preview}${theme.muted(suffix)}`]
}

/**
 * Committed lines for the user's message: its display text when it has one (a command shows
 * as typed, its note on a line below), else its content.
 */
export function userLines(theme: Theme, message: UserMessage): string[] {
  const text = message.display?.text.trim() || userText(message)
  const lines = text
    .trim()
    .split("\n")
    .map((l, i) => `${theme.accent(i === 0 ? "›" : " ")} ${l}`)
  const note = message.display?.note
  if (note) lines.push(`  ${theme.muted("⎿")} ${theme.muted(note)}`)
  return lines
}

/** A user message's content as text, with images as placeholders. */
export function userText(message: UserMessage): string {
  return message.content.map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`)).join("\n\n")
}

/** A resumed conversation, shown compactly: user messages, replies and one line per tool call. */
export function historyLines(theme: Theme, messages: Message[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role === "user") {
      out.push(...userLines(theme, m), "")
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) out.push(...b.text.trim().split("\n"), "")
        else if (b.type === "toolCall") {
          const summary = summarizeArgs(b.args)
          out.push(theme.muted(`● ${b.name}${summary ? ` ${summary}` : ""}`), "")
        }
      }
    }
  }
  return [...out, theme.muted("── resumed ──"), ""]
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
}

function compactTokens(n: number): string {
  if (n < 1000) return String(n)
  return n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
}

/**
 * One line per sub-agent, indented by depth: role, elapsed time and tokens first, so they
 * survive a narrow terminal, then the task cut to fit.
 */
export function subagentLines(subs: SubagentLine[], now: number, width: number, theme: Theme): string[] {
  if (!subs.length) return []
  const lines = subs.map((s) => {
    const when =
      s.startedAt === undefined ? "queued" : `${Math.max(0, Math.floor((now - s.startedAt) / 1000))}s`
    const stats = `${when} · ${compactTokens(s.tokens)} tok`
    const task = s.task.replace(/\s+/g, " ").trim()
    const line = `${"  ".repeat(Math.max(0, s.depth - 1))}${theme.accent("◆")} ${s.role} ${theme.muted(`· ${stats} · ${task}`)}`
    return truncateToWidth(line, width, "…")
  })
  return [...lines, ""]
}
