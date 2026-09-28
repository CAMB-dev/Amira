import { type Component, CURSOR_MARKER } from "../component.ts"
import { type InputEvent, isNewlineKey, isSubmitKey } from "../keys.ts"
import { defaultTheme, type Theme } from "../style.ts"
import { graphemes, visibleWidth } from "../width.ts"

export interface EditorOptions {
  /** Shown before the first row; later rows are indented to line up with it. */
  prompt?: string
  placeholder?: string
  theme?: Theme
  onSubmit?: (text: string) => void
  onChange?: (text: string) => void
}

/** A visual row: part of logical line `line` from `start` to `end` (UTF-16 indices). */
interface Row {
  line: number
  start: number
  end: number
  last: boolean
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * Multi-line text input. Enter submits, the newline key (Shift+Enter or Ctrl+Enter) inserts a
 * line break, and pastes are inserted as-is. The caret is drawn by the terminal cursor.
 */
export class Editor implements Component {
  focused = true
  private lines = [""]
  private line = 0
  private col = 0
  /** Display column kept while moving up and down. */
  private goalCol: number | undefined
  private width = 80

  constructor(private opts: EditorOptions = {}) {}

  getText(): string {
    return this.lines.join("\n")
  }

  /** Replaces the text and puts the caret at the end. Does not call `onChange`. */
  setText(text: string): void {
    this.lines = text.replace(/\r\n?/g, "\n").split("\n")
    this.line = this.lines.length - 1
    this.col = this.current.length
    this.goalCol = undefined
  }

  clear(): void {
    this.setText("")
  }

  /** Caret position as logical line and UTF-16 offset. */
  get cursor(): { line: number; col: number } {
    return { line: this.line, col: this.col }
  }

  insert(text: string): void {
    const parts = text.replace(/\r\n?/g, "\n").split("\n")
    const before = this.current.slice(0, this.col)
    const after = this.current.slice(this.col)
    const last = parts.length - 1
    const inserted = parts.map((p, i) => (i === 0 ? before : "") + p + (i === last ? after : ""))
    this.lines.splice(this.line, 1, ...inserted)
    this.line += last
    this.col = (last === 0 ? before.length : 0) + parts[last]!.length
    this.changed()
  }

  handleInput(e: InputEvent): boolean {
    if (e.type === "paste") {
      this.insert(e.text)
      return true
    }
    if (isSubmitKey(e)) {
      const text = this.getText()
      if (text === "") return true
      this.clear()
      this.opts.onSubmit?.(text)
      return true
    }
    if (isNewlineKey(e)) {
      this.insert("\n")
      return true
    }
    if (e.text !== undefined && !e.ctrl && !e.alt) {
      this.insert(e.text)
      return true
    }
    const word = e.ctrl || e.alt
    switch (e.name) {
      case "backspace":
        return word ? this.deleteTo(this.wordLeft()) : this.deleteTo(this.charLeft())
      case "delete":
        return word ? this.deleteTo(this.wordRight()) : this.deleteTo(this.charRight())
      case "left":
        return this.moveTo(word ? this.wordLeft() : this.charLeft())
      case "right":
        return this.moveTo(word ? this.wordRight() : this.charRight())
      case "home":
        return this.moveTo({ line: this.line, col: 0 })
      case "end":
        return this.moveTo({ line: this.line, col: this.current.length })
      case "up":
        return this.vertical(-1)
      case "down":
        return this.vertical(1)
    }
    if (e.ctrl && e.name === "a") return this.moveTo({ line: this.line, col: 0 })
    if (e.ctrl && e.name === "e") return this.moveTo({ line: this.line, col: this.current.length })
    return false
  }

  render(width: number): string[] {
    this.width = width
    const theme = this.opts.theme ?? defaultTheme
    const prompt = this.opts.prompt ?? ""
    const indent = " ".repeat(visibleWidth(prompt))
    const caret = this.focused ? CURSOR_MARKER : ""
    if (this.getText() === "" && this.opts.placeholder) {
      return [theme.accent(prompt) + caret + theme.muted(this.opts.placeholder)]
    }
    const rows = this.layout()
    const caretRow = this.caretRow(rows)
    return rows.map((row, i) => {
      const text = this.lines[row.line]!
      let body = text.slice(row.start, row.end)
      if (i === caretRow) {
        const at = this.col - row.start
        body = body.slice(0, at) + caret + body.slice(at)
      }
      return (i === 0 ? theme.accent(prompt) : indent) + body
    })
  }

  private get current(): string {
    return this.lines[this.line]!
  }

  private get contentWidth(): number {
    return Math.max(2, this.width - visibleWidth(this.opts.prompt ?? ""))
  }

  private changed(): void {
    this.goalCol = undefined
    this.opts.onChange?.(this.getText())
  }

  /** Splits logical lines into rows by display width. A full last row gets an empty row after it for the caret. */
  private layout(): Row[] {
    const max = this.contentWidth
    const rows: Row[] = []
    this.lines.forEach((text, line) => {
      let start = 0
      let used = 0
      let pos = 0
      for (const g of graphemes(text)) {
        const w = Bun.stringWidth(g)
        if (used + w > max) {
          rows.push({ line, start, end: pos, last: false })
          start = pos
          used = 0
        }
        used += w
        pos += g.length
      }
      if (used >= max && line === this.line && this.col === text.length) {
        rows.push({ line, start, end: pos, last: false })
        start = pos
      }
      rows.push({ line, start, end: pos, last: true })
    })
    return rows
  }

  private caretRow(rows: Row[]): number {
    return rows.findIndex(
      (r) =>
        r.line === this.line && this.col >= r.start && (this.col < r.end || (r.last && this.col === r.end)),
    )
  }

  private vertical(dir: -1 | 1): boolean {
    const rows = this.layout()
    const from = this.caretRow(rows)
    const to = rows[from + dir]
    if (!to) return false
    const row = rows[from]!
    const goal = this.goalCol ?? visibleWidth(this.lines[row.line]!.slice(row.start, this.col))
    const text = this.lines[to.line]!
    let col = to.start
    let used = 0
    for (const g of graphemes(text.slice(to.start, to.end))) {
      const w = Bun.stringWidth(g)
      if (used + w > goal) break
      used += w
      col += g.length
    }
    // The end of a row that wraps is the start of the next row; stay on this one.
    if (!to.last && col === to.end) col = lastBoundary(text.slice(0, to.end))
    this.line = to.line
    this.col = col
    this.goalCol = goal
    return true
  }

  private moveTo(pos: { line: number; col: number }): boolean {
    this.line = pos.line
    this.col = pos.col
    this.goalCol = undefined
    return true
  }

  /** Deletes between the caret and `pos`, joining lines when the range crosses a line break. */
  private deleteTo(pos: { line: number; col: number }): boolean {
    if (pos.line === this.line && pos.col === this.col) return true
    const [a, b] =
      pos.line < this.line || (pos.line === this.line && pos.col < this.col)
        ? [pos, { line: this.line, col: this.col }]
        : [{ line: this.line, col: this.col }, pos]
    const merged = this.lines[a.line]!.slice(0, a.col) + this.lines[b.line]!.slice(b.col)
    this.lines.splice(a.line, b.line - a.line + 1, merged)
    this.line = a.line
    this.col = a.col
    this.changed()
    return true
  }

  private charLeft(): { line: number; col: number } {
    if (this.col > 0) return { line: this.line, col: lastBoundary(this.current.slice(0, this.col)) }
    if (this.line > 0) return { line: this.line - 1, col: this.lines[this.line - 1]!.length }
    return { line: this.line, col: 0 }
  }

  private charRight(): { line: number; col: number } {
    if (this.col < this.current.length) {
      const next = segmenter.segment(this.current.slice(this.col))[Symbol.iterator]().next().value
      return { line: this.line, col: this.col + (next?.segment.length ?? 1) }
    }
    if (this.line < this.lines.length - 1) return { line: this.line + 1, col: 0 }
    return { line: this.line, col: this.col }
  }

  private wordLeft(): { line: number; col: number } {
    if (this.col === 0) return this.charLeft()
    const text = this.current
    let i = this.col
    while (i > 0 && /\s/.test(text[i - 1]!)) i--
    while (i > 0 && !/\s/.test(text[i - 1]!)) i--
    return { line: this.line, col: i }
  }

  private wordRight(): { line: number; col: number } {
    const text = this.current
    if (this.col === text.length) return this.charRight()
    let i = this.col
    while (i < text.length && /\s/.test(text[i]!)) i++
    while (i < text.length && !/\s/.test(text[i]!)) i++
    return { line: this.line, col: i }
  }
}

function lastBoundary(s: string): number {
  const gs = graphemes(s)
  return s.length - (gs[gs.length - 1]?.length ?? 0)
}
