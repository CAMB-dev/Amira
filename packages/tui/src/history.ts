import type { Message, ToolDetailLevel, ToolPresenter, ToolResult } from "@amira/api"
import {
  type MarkdownNodes,
  MarkdownStream,
  type MarkdownStreamOptions,
  renderMarkdown,
  type Theme,
  truncateToWidth,
  visibleWidth,
} from "@amira/tui-kit"
import { reasoningLines, replyRows, userLines } from "./format.ts"
import { glyphs } from "./glyphs.ts"
import {
  explorationOf,
  exploredLines,
  type FinishedCall,
  finishedToolLines,
  type PresenterSource,
} from "./tool-view.ts"
import { type BlockKind, noticeLines, replyEndNotice, Transcript } from "./transcript.ts"

export interface HistoryOptions {
  presenters?: PresenterSource
  width: number
  detail?: ToolDetailLevel
  /** Names the session in the separator after the history. */
  session?: { id: string; updatedAt?: number }
  /** Make links in replies clickable (OSC 8); default: what the terminal is known to support. */
  hyperlinks?: boolean
  /** Images and what extensions render (D88), committed as the inline transcript does. */
  nodes?: MarkdownNodes
  /** Spacing continues from the blocks committed before; a fresh one when left out. */
  transcript?: Transcript
  /** Output lines a successful shell command shows at `summary` detail (tui.shellOutputLines). */
  outputLines?: number
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
  const detail = opts.detail ?? "summary"
  const toolOpts = opts.outputLines !== undefined ? { outputLines: opts.outputLines } : {}
  /** Successful exploring calls in a row, to go as one "Explored" row, as they did live. */
  let exploring: { call: FinishedCall; presenter: ToolPresenter | undefined }[] = []
  const flush = () => {
    if (!exploring.length) return
    const [first] = exploring
    const lines =
      exploring.length === 1
        ? finishedToolLines(theme, first!.presenter, first!.call, detail, opts.width, toolOpts)
        : exploredLines(theme, exploring, detail === "full", detail, opts.width, toolOpts)
    exploring = []
    out.push(...t.block("tool", lines))
  }
  const block = (kind: BlockKind, lines: string[]) => {
    flush()
    out.push(...t.block(kind, lines))
  }
  for (const m of messages) {
    if (m.role === "user") {
      block("user", userLines(theme, m, opts.width))
    } else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "thinking" && (b.text.trim() || b.redacted)) {
          block("reasoning", reasoningLines(theme, b.text, { expanded: detail === "full" }, opts.width))
        } else if (b.type === "text" && b.text.trim()) {
          // Markdown, as the reply showed when it streamed in.
          const width = Math.max(1, opts.width - visibleWidth(gutter))
          const rows = opts.nodes
            ? committedMarkdown(b.text, width, theme, markdownOptions(opts))
            : renderMarkdown(b.text, width, theme, markdownOptions(opts))
          block("assistant", replyRows(rows))
        } else if (b.type === "toolCall") {
          const result = results.get(b.id) ?? { content: [], isError: true }
          const presenter = opts.presenters?.get(b.name)
          const call: FinishedCall = {
            name: b.name,
            args: b.args,
            result,
            ...(results.has(b.id) ? {} : { rejected: "aborted" as const }),
          }
          if (explorationOf(presenter, call)) exploring.push({ call, presenter })
          else block("tool", finishedToolLines(theme, presenter, call, detail, opts.width, toolOpts))
        }
      }
      // How the reply ended, when it did not end well: as the live transcript said it.
      const end = replyEndNotice(m)
      if (end) block("notice", noticeLines(theme, end.level, end.text, opts.width))
    }
  }
  block("history", [historySeparator(theme, opts.session, opts.width)])
  return out
}

/**
 * The separator after a resumed history, across the width: `── resumed <id> · <last write> ───`.
 * Without a width, a short one.
 */
export function historySeparator(
  theme: Theme,
  s?: { id: string; updatedAt?: number },
  width?: number,
): string {
  const label = s
    ? ` resumed ${s.id}${s.updatedAt !== undefined ? ` · ${localTime(s.updatedAt)}` : ""} `
    : " resumed "
  const head = `${glyphs.rule.repeat(2)}${label}`
  const rest = width === undefined ? 2 : Math.max(2, width - visibleWidth(head))
  return theme.muted(truncateToWidth(`${head}${glyphs.rule.repeat(rest)}`, width ?? Number.POSITIVE_INFINITY))
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
