import type { Message, ToolDetailLevel, ToolResult } from "@amira/api"
import { isSummaryMessage } from "@amira/core"
import {
  type MarkdownNodes,
  MarkdownStream,
  type MarkdownStreamOptions,
  renderMarkdown,
  type Theme,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import { replyRows, userLines } from "./format.ts"
import { glyphs } from "./glyphs.ts"
import { finishedToolLines, type PresenterSource } from "./tool-view.ts"
import { Transcript } from "./transcript.ts"

export interface HistoryOptions {
  presenters?: PresenterSource
  width: number
  detail?: ToolDetailLevel
  /** Names the session in the boundary before the history. */
  session?: SessionBoundary
  /** Make links in replies clickable (OSC 8); default: what the terminal is known to support. */
  hyperlinks?: boolean
  /** Images and what extensions render (D88), committed as the inline transcript does. */
  nodes?: MarkdownNodes
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
 * A resumed conversation, laid out like the live transcript: the boundary naming the session,
 * then the same blocks and spacing, tool calls through the same presenters (without durations,
 * which history does not keep). A compaction's summary is one folded line.
 */
export function historyLines(theme: Theme, messages: Message[], opts: HistoryOptions): string[] {
  const t = opts.transcript ?? new Transcript()
  const out: string[] = [
    ...t.block("history", [sessionBoundary(theme, opts.session ?? { resumed: true }, opts.width)]),
  ]
  const results = new Map<string, ToolResult>()
  for (const m of messages) {
    if (m.role === "toolResult") results.set(m.toolCallId, { content: m.content, isError: m.isError })
  }
  const gutter = glyphs.assistant
  for (const m of messages) {
    if (isSummaryMessage(m)) {
      // The summary reads as what it is, not as a message of the user's; its reply goes with it.
      if (m.role === "user")
        out.push(...t.block("summary", summaryLines(theme, summaryText(m), opts.width, true)))
    } else if (m.role === "user") {
      out.push(...t.block("user", userLines(theme, m, opts.width)))
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) {
          // Markdown, as the reply showed when it streamed in.
          const width = Math.max(1, opts.width - visibleWidth(gutter))
          const rows = opts.nodes
            ? committedMarkdown(b.text, width, theme, markdownOptions(opts))
            : renderMarkdown(b.text, width, theme, markdownOptions(opts))
          out.push(...t.block("assistant", replyRows(rows)))
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
  return out
}

/** The session a boundary names: resumed (with its last write), or new (after /clear). */
export interface SessionBoundary {
  id?: string
  updatedAt?: number
  resumed: boolean
}

/**
 * Where a session's part of the transcript starts: a rule across the width naming it,
 * `── resumed s_42 · 2026-09-29 14:05 ─────` or `── new session s_43 ─────`. Narrow, the name
 * is cut before the rule is.
 */
export function sessionBoundary(theme: Theme, s: SessionBoundary, width: number): string {
  const when = s.updatedAt !== undefined ? ` · ${localTime(s.updatedAt)}` : ""
  const id = s.id ? ` ${s.id}` : ""
  const label = s.resumed ? `resumed${id}${when}` : `new session${id}`
  const head = `${glyphs.rule.repeat(2)} `
  const room = Math.max(1, width - visibleWidth(head) - 3)
  const text = truncateToWidth(label, room, glyphs.more)
  const tail = glyphs.rule.repeat(Math.max(2, width - visibleWidth(head) - visibleWidth(text) - 1))
  return theme.muted(truncateToWidth(`${head}${text} ${tail}`, Math.max(1, width), ""))
}

/** The summary a compaction left, without the words that introduce it to the model. */
export function summaryText(m: Message): string {
  const first = m.content[0]
  const text = first?.type === "text" ? first.text : ""
  const cut = text.indexOf("\n\n")
  return (cut === -1 ? text : text.slice(cut + 2)).trim()
}

/**
 * A compaction's summary: one line folded, `▸ Compacted summary of earlier messages · 12 lines`;
 * unfolded, the summary as Markdown under that head.
 */
export function summaryLines(theme: Theme, summary: string, width: number, folded: boolean): string[] {
  const n = summary ? summary.split("\n").length : 0
  const title = `Compacted summary of earlier messages${folded ? ` · ${n} line${n === 1 ? "" : "s"}` : ""}`
  const head = truncateToWidth(
    `${theme.accent(folded ? "▸" : "▾")} ${theme.muted(title)}`,
    width,
    glyphs.more,
  )
  if (folded) return [head]
  const body = renderMarkdown(summary, Math.max(1, width - visibleWidth(glyphs.assistant)), theme)
  return [head, "", ...replyRows(body)]
}

/**
 * A whole Markdown text as rows to commit, as the live transcript commits a reply: images and
 * what extensions render go as they are ready, or as markers the renderer resolves in order.
 */
function committedMarkdown(text: string, width: number, theme: Theme, opts: MarkdownStreamOptions): string[] {
  const m = new MarkdownStream(opts)
  const rows: string[] = []
  m.append(text)
  m.render(width, { theme, color: true, rows: Number.POSITIVE_INFINITY, commit: (r) => rows.push(...r) })
  rows.push(...m.take(width))
  while (rows.length > 0 && rows[rows.length - 1]!.trim() === "") rows.pop()
  return rows
}

function markdownOptions(opts: HistoryOptions): MarkdownStreamOptions {
  return {
    ...(opts.hyperlinks === undefined ? {} : { hyperlinks: opts.hyperlinks }),
    ...(opts.nodes ? { nodes: opts.nodes } : {}),
  }
}
