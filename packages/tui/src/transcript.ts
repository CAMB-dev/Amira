import { type StyleFn, type Theme, textWidth, wrapText } from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

/** What a block of the transcript is; the spacing rule depends on it. */
export type BlockKind =
  | "banner"
  | "user"
  | "assistant"
  | "tool"
  | "notice"
  | "command"
  | "command-output"
  | "dialog"
  | "history"
  /** What the model thought before it answered: "∴ Thought for 12s", unfolded to the text. */
  | "reasoning"
  | "summary"

/** Blocks that follow one of the given kind with no blank line between them. */
const JOINS: Partial<Record<BlockKind, BlockKind>> = {
  // Tool calls of one step read as a list.
  tool: "tool",
  // What a command prints hangs under its echo.
  "command-output": "command",
  // The banner's hint line goes right under it.
  banner: "banner",
}

/** Whether a block of `next` kind after one of `prev` kind gets a blank line between them. */
export function gapBetween(prev: BlockKind | undefined, next: BlockKind): boolean {
  return prev !== undefined && JOINS[next] !== prev
}

/**
 * The transcript's spacing rule, in one place: exactly one blank line between blocks, none
 * between blocks that belong together (the tool calls of a step, a command and its output).
 * It only decides the lines; the caller commits them (they go to the scrollback once) and
 * uses `gapBefore` to draw what is still live the way it will be committed.
 */
export class Transcript {
  #last: BlockKind | undefined
  /** A block still being written, such as a streaming reply; more of it follows without a gap. */
  #open: BlockKind | undefined

  /** The kind of the last block committed. */
  get last(): BlockKind | undefined {
    return this.#last
  }

  /** Whether a block of `kind` starting now gets a blank line before it. */
  gapBefore(kind: BlockKind): boolean {
    if (this.#open === kind) return false
    return gapBetween(this.#last, kind)
  }

  /** The lines to commit for a whole block: a blank line first when the rule wants one. */
  block(kind: BlockKind, lines: string[]): string[] {
    if (!lines.length) return []
    const gap = this.gapBefore(kind)
    this.#last = kind
    this.#open = undefined
    return gap ? ["", ...lines] : lines
  }

  /** Lines that continue the open block of `kind`, or start it: e.g. finished rows of a reply. */
  continue(kind: BlockKind, lines: string[]): string[] {
    if (!lines.length) return []
    if (this.#open === kind) return lines
    const out = this.block(kind, lines)
    this.#open = kind
    return out
  }

  /** Ends the open block; what follows is a new one. */
  end(): void {
    this.#open = undefined
  }
}

export type NoticeLevel = "info" | "success" | "warning" | "error" | "interrupted"

/** The notice after a turn the user interrupted. */
export const INTERRUPTED_NOTICE = "Interrupted"

/**
 * The notice after a turn that failed: what went wrong, then what to do next. The error says
 * itself what failed (a request, a missing model), so nothing is put in front of it.
 */
export function modelErrorNotice(error: string | undefined): string {
  const said = error?.trim() || "The model request failed"
  return `${said}\n↑ recalls the prompt · /model switches models`
}

/**
 * The notice a reply of a resumed session ends with when it did not end well, as the live
 * transcript showed it: interrupted, or failed (the error itself is not kept).
 */
export function replyEndNotice(message: {
  stopReason?: string
}): { level: NoticeLevel; text: string } | undefined {
  if (message.stopReason === "aborted") return { level: "interrupted", text: INTERRUPTED_NOTICE }
  if (message.stopReason === "error") return { level: "error", text: "Model request failed" }
  return undefined
}

/**
 * A system notice (interrupted, compacted, an extension error, ...): a symbol by level, then
 * the text; later lines are indented under the first.
 */
export function noticeLines(theme: Theme, level: NoticeLevel, text: string, width = 80): string[] {
  const style: StyleFn = level === "error" ? theme.error : level === "warning" ? theme.warning : theme.muted
  const mark = glyphs[level]
  const glyph = level === "success" ? theme.success(mark) : style(mark)
  // Rows after the first hang under the text, past a mark that may be two cells (an emoji).
  const pad = " ".repeat(textWidth(mark) + 1)
  return hanging(text, width - pad.length).map((l, i) =>
    i === 0 ? `${glyph} ${style(l)}` : `${pad}${style(l)}`,
  )
}

/**
 * The details of a notice (e.g. what a provider answered to a failed request), muted and
 * hanging under its text like the notice's own later rows.
 */
export function noticeDetailLines(theme: Theme, level: NoticeLevel, detail: string, width = 80): string[] {
  const pad = " ".repeat(textWidth(glyphs[level]) + 1)
  return hanging(detail, width - pad.length).map((l) => `${pad}${theme.muted(l)}`)
}

/**
 * Output of a command, hanging under its echo like a tool's result. An error is marked with
 * "✗" after the result mark too, so it reads as one without colors. A row of columns (cells two
 * spaces or more apart, as /help and /cost print them) wraps under its last column, so the
 * columns stay lined up.
 */
export function commandOutputLines(
  theme: Theme,
  level: "info" | "warning" | "error",
  text: string,
  width = 80,
): string[] {
  const style = level === "error" ? theme.error : level === "warning" ? theme.warning : theme.text
  const mark = level === "error" ? `${theme.error(glyphs.error)} ` : ""
  const lead = level === "error" ? textWidth(glyphs.error) + 1 : 0
  return hanging(text, width - 4 - lead, true).map(
    (l, i) =>
      `  ${i === 0 ? theme.muted(glyphs.result) : " "} ${i === 0 ? mark : " ".repeat(lead)}${style(l)}`,
  )
}

/** Where a row of columns wraps to: past its last run of two or more spaces, when that is not too far in. */
function columnIndent(line: string, width: number): number {
  const m = /^(.*\S) {2,}(?=\S)/.exec(line)
  if (!m) return /^ */.exec(line)![0].length
  const at = textWidth(m[0])
  return at <= width * 0.6 ? at : /^ */.exec(line)![0].length
}

/**
 * A row of columns whose last column starts too far in to wrap under (a long first cell on a
 * narrow screen): the cells before it on their own rows, then the last one indented under
 * them, so its words are not pushed past the first cell's padding. Undefined for other lines.
 */
function farColumnRows(line: string, width: number): string[] | undefined {
  const m = /^(.*\S) {2,}(?=\S)/.exec(line)
  if (!m || textWidth(m[0]) <= width * 0.6) return undefined
  const lead = /^ */.exec(line)![0].length + 4
  const rest = wrapText(line.slice(m[0].length), Math.max(10, width - lead))
  return [...wrapText(m[1]!, width), ...rest.map((r) => " ".repeat(lead) + r)]
}

/**
 * Text wrapped to `width`, so that its rows can hang under a symbol instead of wrapping to
 * column 0; with `columns`, a line's rows after its first line up under its last column.
 */
function hanging(text: string, width: number, columns = false): string[] {
  const room = Math.max(10, width)
  return text.split("\n").flatMap((l) => {
    if (!l) return [""]
    const rows = wrapText(l, room)
    if (!columns || rows.length < 2) return rows
    const far = farColumnRows(l, room)
    if (far) return far
    const indent = columnIndent(l, room)
    if (!indent) return rows
    const rest = wrapText(l.slice(visibleOffset(l, rows[0]!)).trimStart(), Math.max(10, room - indent))
    return [rows[0]!, ...rest.map((r) => " ".repeat(indent) + r)]
  })
}

/** How much of `line` its first wrapped row `row` took, in characters. */
function visibleOffset(line: string, row: string): number {
  const plain = row.trimEnd()
  return line.startsWith(plain) ? plain.length : Math.min(line.length, plain.length)
}
