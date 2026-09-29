import { graphemes, inverse, TAB_WIDTH, type Theme, visibleWidth } from "@amira/tui-kit"
import { glyphs } from "./glyphs.ts"

/** An escape sequence at a position (sticky): CSI, OSC, DCS/APC/PM/SOS, or a two-byte one. */
export const ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]/y

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters
const CONTROL = /^[\x00-\x1f\x7f-\x9f]+$/

/** A piece of a line: an escape sequence (no cells), or a character at `col` taking `width` cells. */
export interface Cell {
  text: string
  col: number
  width: number
  escape: boolean
}

/**
 * A line split into escape sequences and characters (grapheme clusters) with the columns the
 * terminal draws them at: CJK and emoji take two, a tab reaches the next multiple of TAB_WIDTH,
 * control characters none.
 */
export function cellsOf(line: string): Cell[] {
  const out: Cell[] = []
  let col = 0
  let text = ""
  const flush = () => {
    for (const g of graphemes(text)) {
      const width = g === "\t" ? TAB_WIDTH - (col % TAB_WIDTH) : CONTROL.test(g) ? 0 : Bun.stringWidth(g)
      out.push({ text: g, col, width, escape: false })
      col += width
    }
    text = ""
  }
  for (let i = 0; i < line.length; ) {
    ESCAPE.lastIndex = i
    const esc = line.charCodeAt(i) === 0x1b ? ESCAPE.exec(line) : null
    if (esc) {
      flush()
      out.push({ text: esc[0], col, width: 0, escape: true })
      i += esc[0].length
    } else {
      text += line[i]
      i++
    }
  }
  flush()
  return out
}

/** Whether a character is in the columns `from` (inclusive) to `to` (exclusive): any of its cells. */
const within = (c: Cell, from: number, to: number) =>
  c.width === 0 ? c.col >= from && c.col < to : c.col < to && c.col + c.width > from

/** The characters of a line (escape sequences left out) in columns `from` to `to` (exclusive). */
export function sliceCells(line: string, from: number, to: number): string {
  let out = ""
  for (const c of cellsOf(line)) if (!c.escape && within(c, from, to)) out += c.text
  return out
}

/** The sequences that start and end the selection's look, from the theme's `selection` token. */
export function selectionMarks(theme: Theme): { on: string; off: string } {
  const style = theme.selection ?? inverse
  const [on = "", off = ""] = style("\0").split("\0")
  return on ? { on, off } : { on: "\x1b[7m", off: "\x1b[27m" }
}

/**
 * `line` with columns `from` to `to` (exclusive) marked as selected. Escape sequences are kept;
 * one inside the range (a color change, a reset) is followed by the mark again.
 */
export function markCells(
  line: string,
  from: number,
  to: number,
  marks: { on: string; off: string },
): string {
  let out = ""
  let open = false
  for (const c of cellsOf(line)) {
    if (c.escape) {
      out += c.text
      if (open) out += marks.on
      continue
    }
    const inside = within(c, from, to)
    if (inside && !open) out += marks.on
    else if (!inside && open) out += marks.off
    open = inside
    out += c.text
  }
  if (open) out += marks.off
  return out
}

const WORD = /^[\p{L}\p{N}\p{M}_\-./\\~:@#%+=?&]$/u

/**
 * The word at column `col` of a line: letters, digits and the characters of paths and URLs
 * around it, without trailing punctuation. On a blank or a lone symbol, that character.
 * Columns from (inclusive) to (exclusive); undefined past the end of the line.
 */
export function wordAt(line: string, col: number): { from: number; to: number } | undefined {
  const cells = cellsOf(line).filter((c) => !c.escape && c.width > 0)
  const at = cells.findIndex((c) => col >= c.col && col < c.col + c.width)
  if (at === -1) return undefined
  const isWord = (c: Cell | undefined) => c !== undefined && WORD.test(c.text)
  if (!isWord(cells[at])) return { from: cells[at]!.col, to: cells[at]!.col + cells[at]!.width }
  let a = at
  let b = at
  while (isWord(cells[a - 1])) a--
  while (isWord(cells[b + 1])) b++
  // "see src/a.ts." or "a.ts:" at the end of a sentence: the word, not the punctuation after it.
  while (b > at && /^[.:,?]$/.test(cells[b]!.text)) b--
  return { from: cells[a]!.col, to: cells[b]!.col + cells[b]!.width }
}

/**
 * How one row of a block copies: `from` the column its text starts at (what is left of it is
 * the transcript's chrome: a gutter, a tree, a code frame), left out when `skip`, or `text`
 * in its place (an image's alt text). A row that `joins` continues the row before it (a wrapped
 * line of code), so no line break goes between them. A row that `repeats` is a further row of
 * what the row above is (an image): copied only when that one is not.
 */
export interface CopyRow {
  from: number
  skip?: boolean
  joins?: boolean
  repeats?: boolean
  text?: string
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Symbols that start rows of tool calls, notices, sub-agents and command output. */
const MARKS = [
  glyphs.user,
  glyphs.toolDone,
  glyphs.toolRunning,
  glyphs.toolFailed,
  glyphs.toolInterrupted,
  glyphs.toolBlocked,
  glyphs.toolUnknown,
  glyphs.toolInvalid,
  glyphs.result,
  glyphs.treeBranch,
  glyphs.output,
  glyphs.subagent,
  glyphs.subagentDone,
  glyphs.subagentFailed,
  glyphs.subagentAborted,
  glyphs.info,
  glyphs.success,
  glyphs.warning,
  glyphs.error,
  glyphs.interrupted,
]
const LEAD = new RegExp(`^ *(?:(?:${[...new Set(MARKS)].map(escapeRe).join("|")}) +)+`, "u")

/**
 * Rows of a tool call, a notice or command output: the symbols in front (a bullet, a tree, a
 * result mark) are chrome; a row without one, under a row with one, loses the indent that
 * lines it up with that row's text, and keeps any indent of its own beyond it.
 */
export function chromeRows(plain: readonly string[]): CopyRow[] {
  let textCol = 0
  return plain.map((p) => {
    const m = LEAD.exec(p)
    if (m) {
      textCol = visibleWidth(m[0])
      return { from: textCol }
    }
    const lead = /^ */.exec(p)![0].length
    return { from: Math.min(lead, textCol) }
  })
}

/** Rows behind a gutter of `width` columns (a user message's "› "). */
export function gutterRows(plain: readonly string[], width: number): CopyRow[] {
  return plain.map(() => ({ from: width }))
}
