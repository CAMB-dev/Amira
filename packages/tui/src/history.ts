import type { CompactionInfo, Message, ToolDetailLevel, ToolPresenter, ToolResult } from "@amira/api"
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
import { compactionReason, compactionSizes, reasoningLines, replyRows, userLines } from "./format.ts"
import { glyphs } from "./glyphs.ts"
import { replyCitations, serverToolCall } from "./server-tools.ts"
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
  /** Names the session in the boundary before the history. */
  session?: SessionBoundary
  /** Make links in replies clickable (OSC 8); default: what the terminal is known to support. */
  hyperlinks?: boolean
  /** Images and what extensions render (D88), committed as the inline transcript does. */
  nodes?: MarkdownNodes
  /** Spacing continues from the blocks committed before; a fresh one when left out. */
  transcript?: Transcript
  /** Output lines a successful shell command shows at `summary` detail (tui.shellOutputLines). */
  outputLines?: number
  /** Why a compaction happened, by its summary's user message (Agent.compactionInfo). */
  compactionInfo?: (message: Message) => CompactionInfo | undefined
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
    if (isSummaryMessage(m)) {
      // The summary reads as what it is, not as a message of the user's; its reply goes with it.
      if (m.role === "user") {
        block("summary", summaryLines(theme, summaryText(m), opts.width, true, opts.compactionInfo?.(m)))
      }
    } else if (m.role === "user") {
      block("user", userLines(theme, m, opts.width))
    } else if (m.role === "assistant") {
      // The sources the reply cited follow its last text, as they did live.
      const sources = replyCitations(m.content)
      const lastText = m.content.findLastIndex((b) => b.type === "text" && b.text.trim() !== "")
      for (const [i, b] of m.content.entries()) {
        if (b.type === "thinking" && (b.text.trim() || b.redacted)) {
          block("reasoning", reasoningLines(theme, b.text, { expanded: detail === "full" }, opts.width))
        } else if (b.type === "text" && b.text.trim()) {
          // Markdown, as the reply showed when it streamed in.
          const width = Math.max(1, opts.width - visibleWidth(gutter))
          const text = i === lastText ? b.text + sources : b.text
          const rows = opts.nodes
            ? committedMarkdown(text, width, theme, markdownOptions(opts))
            : renderMarkdown(text, width, theme, markdownOptions(opts))
          block("assistant", replyRows(rows))
        } else if (b.type === "serverTool") {
          // A search the provider ran shows as the tool row it was live.
          const { rejected, ...call } = serverToolCall(b)
          const finished: FinishedCall = { ...call, ...(rejected ? { rejected } : {}) }
          block(
            "tool",
            finishedToolLines(theme, opts.presenters?.get(b.name), finished, detail, opts.width, toolOpts),
          )
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
  flush()
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
 * A compaction's summary: one line folded, with why it happened when known,
 * `▸ Compacted automatically at 82% of 128k · summary of earlier messages · 12 lines` (else
 * `▸ Compacted summary of earlier messages · 12 lines`); unfolded, the sizes and the model
 * that wrote it, then the summary as Markdown under that head.
 */
export function summaryLines(
  theme: Theme,
  summary: string,
  width: number,
  folded: boolean,
  info?: CompactionInfo,
): string[] {
  const n = summary ? summary.split("\n").length : 0
  // A server's checkpoint may have no readable text (OpenAI's is encrypted).
  const unreadable = !summary.trim()
  const what = info
    ? `${compactionReason(info)} · ${unreadable ? "no readable summary" : "summary of earlier messages"}`
    : unreadable
      ? "Compacted · no readable summary"
      : "Compacted summary of earlier messages"
  const title = `${what}${folded && !unreadable ? ` · ${n} line${n === 1 ? "" : "s"}` : ""}`
  const head = truncateToWidth(
    `${theme.accent(folded ? "▸" : "▾")} ${theme.muted(title)}`,
    width,
    glyphs.more,
  )
  if (folded) return [head]
  const native = info?.native
  const writer = info?.model
  const facts = [
    compactionSizes(info),
    native ? `compacted by ${native.provider}'s server for ${native.model}` : undefined,
    // For a server-side one, the model named is the one that wrote a text summary for it later.
    writer && (!native || writer.provider !== native.provider || writer.model !== native.model)
      ? `${native ? "text summary " : ""}written by ${writer.provider}/${writer.model}`
      : undefined,
  ].filter((f): f is string => f !== undefined)
  if (unreadable) {
    const note =
      "The server keeps this summary encrypted, so it cannot be shown. Only the model it was made for can read it; for another one Amira writes a text summary when it needs one. /compact with instructions writes a readable summary now."
    const indent = " ".repeat(visibleWidth(glyphs.assistant))
    const body = renderMarkdown(note, Math.max(1, width - visibleWidth(glyphs.assistant)), theme)
    const detail = facts.length
      ? [truncateToWidth(`${indent}${theme.muted(facts.join(" · "))}`, width, glyphs.more)]
      : []
    return [head, ...detail, "", ...replyRows(body)]
  }
  const detail = facts.length
    ? [
        truncateToWidth(
          `${" ".repeat(visibleWidth(glyphs.assistant))}${theme.muted(facts.join(" · "))}`,
          width,
          glyphs.more,
        ),
      ]
    : []
  const body = renderMarkdown(summary, Math.max(1, width - visibleWidth(glyphs.assistant)), theme)
  return [head, ...detail, "", ...replyRows(body)]
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
