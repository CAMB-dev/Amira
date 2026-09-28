import type { Message, ToolDetailLevel, ToolResult } from "@amira/api"
import { type Theme, wrapText } from "@amira/tui-kit"
import { userLines } from "./format.ts"
import { glyphs } from "./glyphs.ts"
import { finishedToolLines, type PresenterSource } from "./tool-view.ts"
import { Transcript } from "./transcript.ts"

export interface HistoryOptions {
  presenters?: PresenterSource
  width: number
  detail?: ToolDetailLevel
  /** Names the session in the separator after the history. */
  session?: { id: string; updatedAt?: number }
  /** Spacing continues from the blocks committed before; a fresh one when left out. */
  transcript?: Transcript
}

/** "2026-09-29 14:05", in local time. */
function localTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * A resumed conversation, laid out like the live transcript: the same blocks and spacing,
 * tool calls through the same presenters (without durations, which history does not keep),
 * then a separator naming the session.
 */
export function historyLines(theme: Theme, messages: Message[], opts: HistoryOptions): string[] {
  const t = opts.transcript ?? new Transcript()
  const out: string[] = []
  const results = new Map<string, ToolResult>()
  for (const m of messages) {
    if (m.role === "toolResult") results.set(m.toolCallId, { content: m.content, isError: m.isError })
  }
  const gutter = glyphs.assistant
  for (const m of messages) {
    if (m.role === "user") {
      const text = m.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n")
      out.push(...t.block("user", userLines(theme, text.trim(), opts.width)))
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) {
          const rows = wrapText(b.text.trim(), Math.max(1, opts.width - gutter.length))
          out.push(
            ...t.block(
              "assistant",
              rows.map((r) => gutter + r),
            ),
          )
        } else if (b.type === "toolCall") {
          const result = results.get(b.id) ?? { content: [], isError: true }
          const lines = finishedToolLines(
            theme,
            opts.presenters?.get(b.name),
            { name: b.name, args: b.args, result, ...(results.has(b.id) ? {} : { rejected: "aborted" }) },
            opts.detail ?? "summary",
            opts.width,
          )
          out.push(...t.block("tool", lines))
        }
      }
    }
  }
  const s = opts.session
  const label = s
    ? ` resumed ${s.id}${s.updatedAt !== undefined ? ` · ${localTime(s.updatedAt)}` : ""} `
    : " resumed "
  out.push(...t.block("history", [theme.muted(`${glyphs.rule.repeat(2)}${label}${glyphs.rule.repeat(2)}`)]))
  return out
}
