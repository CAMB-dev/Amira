import { stripAnsi } from "../ansi.ts"
import type { Component, RenderContext } from "../component.ts"
import { graphemes, TAB_WIDTH, textWidth } from "../width.ts"

/** A visual row: `text.slice(start, end)`; the row after it starts at `next`. */
interface Row {
  start: number
  end: number
  next: number
  /** Whether text appended later can no longer change this row. */
  stable: boolean
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
/** An escape sequence or `\r\n` that a chunk may end in the middle of. */
const UNFINISHED =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
  /(?:\x1b(?:\[[0-?]*[ -/]*|[\]P_^X][^\x07\x1b]*\x1b?|[ -/]*)?|\r)$/

/**
 * Plain text that streams in, such as a model's reply, word-wrapped like `wrapText`.
 *
 * It takes at most `maxRows` rows of the live region. When it grows past that, the rows that
 * can no longer change (all but the one still being written) are committed to the scrollback
 * during the frame, exactly as they were shown, and dropped from the text. So a reply longer
 * than the screen reaches the scrollback once, in order, and is never cut off the top of the
 * live region. Committing needs the renderer's `ctx.commit`; without it every row is returned.
 *
 * Escape sequences and control characters are dropped: the text is shown as plain text.
 */
export class StreamText implements Component {
  /** Rows the text may take in the live region; set by the parent before each render. */
  maxRows = Number.POSITIVE_INFINITY
  /** Rows committed to the scrollback since the text was last taken. */
  committedRows = 0
  private text = ""
  /** Cells of the current paragraph committed already, so tabs keep their stops. */
  private cut = 0
  /** The end of the last chunk when it may continue in the next: a split escape or `\r`. */
  private pending = ""

  /** The text not committed yet. */
  getText(): string {
    return this.text
  }

  /** Adds streamed text. Whitespace before the first visible character is dropped. */
  append(chunk: string): void {
    let s = this.pending + chunk
    this.pending = s.match(UNFINISHED)?.[0] ?? ""
    if (this.pending) s = s.slice(0, -this.pending.length)
    s = stripAnsi(s).replace(/\r\n?/g, "\n").replace(CONTROLS, "")
    if (this.text === "" && this.committedRows === 0) s = s.replace(/^\s+/, "")
    if (!s.includes("\t")) {
      this.text += s
      return
    }
    for (const part of s.split(/(\t)/)) {
      if (part !== "\t") {
        this.text += part
        continue
      }
      // Measured from the text, not summed per chunk: a chunk may end inside a grapheme.
      const nl = this.text.lastIndexOf("\n")
      const col = (nl === -1 ? this.cut : 0) + textWidth(this.text.slice(nl + 1))
      this.text += " ".repeat(TAB_WIDTH - (col % TAB_WIDTH))
    }
  }
  /**
   * Returns the rows not committed yet, wrapped to `width`, without trailing blank rows, and
   * starts over empty.
   */
  take(width: number): string[] {
    const rows = this.layout(width).map((r) => this.text.slice(r.start, r.end))
    while (rows.length > 0 && rows[rows.length - 1]!.trim() === "") rows.pop()
    this.text = ""
    this.cut = 0
    this.pending = ""
    this.committedRows = 0
    return rows
  }

  render(width: number, ctx: RenderContext): string[] {
    let rows = this.layout(width)
    if (ctx.commit && rows.length > this.maxRows) {
      let n = 0
      while (n < rows.length && rows[n]!.stable) n++
      // Blank rows at the end stay live: when the reply ends there they are dropped.
      while (n > 0 && this.isBlank(rows[n - 1]!)) n--
      if (n > 0) {
        ctx.commit(rows.slice(0, n).map((r) => this.text.slice(r.start, r.end)))
        this.committedRows += n
        // Rows depend only on where they start, so the rest lays out the same on its own.
        const from = rows[n]!.start
        const nl = this.text.lastIndexOf("\n", from - 1)
        this.cut = (nl === -1 ? this.cut : 0) + textWidth(this.text.slice(nl + 1, from))
        this.text = this.text.slice(from)
        rows = rows
          .slice(n)
          .map((r) => ({ ...r, start: r.start - from, end: r.end - from, next: r.next - from }))
      }
    }
    return rows.map((r) => this.text.slice(r.start, r.end))
  }

  private isBlank(r: Row): boolean {
    return this.text.slice(r.start, r.end).trim() === ""
  }

  /**
   * Word-wraps the text. Each row is laid out from where it starts, never from earlier rows,
   * so that committing the rows before one leaves it unchanged.
   */
  private layout(width: number): Row[] {
    const rows: Row[] = []
    if (this.text === "") return rows
    const max = Math.max(1, width)
    let from = 0
    for (;;) {
      const nl = this.text.indexOf("\n", from)
      const end = nl === -1 ? this.text.length : nl
      wrapParagraph(this.text, from, end, max, nl !== -1, rows)
      if (nl === -1) return rows
      from = nl + 1
    }
  }
}

/**
 * Wraps `text[from, to)` into `rows`. Breaks after a space (which is dropped) or a wide
 * character, and hard-breaks words longer than a row. A row is stable once the character that
 * overflowed it is not the last one of the text, since that one may still grow (a combining
 * mark, a ZWJ sequence); the last row is stable only when a line break follows (`closed`).
 */
function wrapParagraph(text: string, from: number, to: number, width: number, closed: boolean, rows: Row[]) {
  const gs = graphemes(text.slice(from, to))
  const offs: number[] = []
  let off = from
  for (const g of gs) {
    offs.push(off)
    off += g.length
  }
  let i = 0
  let start = from
  let used = 0
  /** Where the row may break: the head ends at `breakEnd`, the next row starts at grapheme `breakNext`. */
  let breakEnd = -1
  let breakNext = -1
  for (let j = 0; j < gs.length; j++) {
    const g = gs[j]!
    const w = textWidth(g)
    if (used + w > width && j > i) {
      let end: number
      let next: number
      if (g === " ") {
        end = offs[j]!
        next = j + 1
      } else if (breakEnd > start) {
        end = breakEnd
        next = breakNext
      } else {
        end = offs[j]!
        next = j
      }
      const nextOff = next < gs.length ? offs[next]! : to
      rows.push({ start, end, next: nextOff, stable: closed || j < gs.length - 1 })
      i = next
      start = nextOff
      used = 0
      breakEnd = -1
      // Lay out again from the new row's start, as if it were the first.
      j = next - 1
      continue
    }
    used += w
    if (g === " ") {
      breakEnd = offs[j]!
      breakNext = j + 1
    } else if (w === 2) {
      breakEnd = offs[j]! + g.length
      breakNext = j + 1
    }
  }
  rows.push({ start, end: to, next: closed ? to + 1 : to, stable: closed })
}
