import { type Component, CURSOR_MARKER, type RenderContext } from "../component.ts"
import { type InputEvent, isNewlineKey, isSubmitKey } from "../keys.ts"
import { graphemes, TAB_WIDTH, textWidth, truncateToWidth, visibleWidth } from "../width.ts"

/** A piece of editor content: typed text, or a pasted text folded into one placeholder. */
export type EditorPart = string | { paste: string }

/** What a folded paste's placeholder says. */
export interface PasteInfo {
  /** Lines of the pasted text (a trailing line break does not start another). */
  lines: number
  chars: number
  /** Numbers the editor's placeholders from 1; restarts when the editor is emptied. */
  n: number
}

/** "[pasted 2000 lines #1]", or "[pasted 1500 chars #1]" for a single long line. */
export function defaultPasteLabel({ lines, chars, n }: PasteInfo): string {
  return lines > 1 ? `[pasted ${lines} lines #${n}]` : `[pasted ${chars} chars #${n}]`
}

export interface SubmitInfo {
  /** The text with folded pastes shown as their placeholders, for display. */
  display: string
  /** The content as submitted, folded pastes kept apart (e.g. for a prompt history). */
  parts: EditorPart[]
}

export interface EditorOptions {
  /** Shown before the first row; later rows are indented to line up with it. */
  prompt?: string
  placeholder?: string
  /** Called with the full text, folded pastes expanded. */
  onSubmit?: (text: string, info: SubmitInfo) => void
  onChange?: (text: string) => void
  /**
   * Fold a bracketed paste of at least `lines` lines or `chars` characters into one placeholder
   * that moves and deletes as a single character and expands again in `getText()`. Off by default.
   */
  foldPastes?: { lines: number; chars: number }
  pasteLabel?: (info: PasteInfo) => string
  /** The submit key; default plain Enter. */
  isSubmit?: (e: InputEvent) => boolean
  /** The newline key; default Shift+Enter or Ctrl+Enter. */
  isNewline?: (e: InputEvent) => boolean
}

/** A visual row: part of logical line `line` from `start` to `end` (UTF-16 indices). */
interface Row {
  line: number
  start: number
  end: number
  last: boolean
}

/** How a logical line wraps at content width `max`. */
interface LineLayout {
  text: string
  max: number
  /** Offset each row starts at; the first is 0. */
  starts: number[]
  /** The last row is full, so a caret at the end of the line gets a row of its own. */
  full: boolean
}

interface Paste {
  text: string
  label: string
  width: number
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * Folded pastes are stored in the text as one code point each from Supplementary Private Use
 * Area-B, which fonts (Nerd Fonts included) leave unused, so a grapheme is a whole placeholder.
 */
const TOKEN_BASE = 0x100000
const TOKEN_LAST = 0x10fffd
const TOKEN_PATTERN = /[\u{100000}-\u{10fffd}]/gu
const TOKEN_TEST = /[\u{100000}-\u{10fffd}]/u
/** Printable ASCII: one cell per character, so a line wraps every `max` characters. */
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/

/**
 * Multi-line text input. Enter submits, the newline key (Shift+Enter or Ctrl+Enter) inserts a
 * line break, and pastes are inserted as-is or folded (see `foldPastes`). The caret is drawn by
 * the terminal cursor.
 *
 * Layout is incremental: each logical line's wrapping is cached until its text or the width
 * changes, and rows are found through prefix sums, so a key costs about the same with 100k lines
 * as with one.
 */
export class Editor implements Component {
  focused = true
  /**
   * Rows shown at most. Longer text scrolls inside them, keeping the caret in view, so the
   * editor never grows past its share of the screen.
   */
  maxRows = Number.POSITIVE_INFINITY
  /** Rows of text above and below the shown ones, as of the last render. */
  hidden = { above: 0, below: 0 }
  /** First shown row. */
  private top = 0
  private lines = [""]
  private line = 0
  private col = 0
  /** Display column kept while moving up and down. */
  private goalCol: number | undefined
  private width = 80
  /** Wrapping per logical line, parallel to `lines`; an entry is stale when its text or width differs. */
  private layouts: (LineLayout | undefined)[] = [undefined]
  /** `prefix[i]` is the number of rows before line `i` (without the caret's own extra row). */
  private prefix: number[] = [0]
  /** `prefix[0..prefixValid]` are up to date. */
  private prefixValid = 0
  /** The full text, until the next change. */
  private textCache: string | undefined
  private pastes = new Map<string, Paste>()
  private nextPaste = 1
  private nextToken = TOKEN_BASE
  private changes = 0
  private readonly promptWidth: number

  constructor(private opts: EditorOptions = {}) {
    this.promptWidth = visibleWidth(opts.prompt ?? "")
  }

  /** The text, folded pastes expanded. Cached until the next change. */
  getText(): string {
    if (this.textCache === undefined) {
      const joined = this.lines.join("\n")
      this.textCache = this.pastes.size ? this.expand(joined, (p) => p.text) : joined
    }
    return this.textCache
  }

  /** The text with folded pastes as their placeholders. */
  getDisplayText(): string {
    const joined = this.lines.join("\n")
    return this.pastes.size ? this.expand(joined, (p) => p.label) : joined
  }

  /** The content with folded pastes kept apart; `setParts` restores it. */
  getParts(): EditorPart[] {
    const joined = this.lines.join("\n")
    if (!this.pastes.size) return joined ? [joined] : []
    const parts: EditorPart[] = []
    let last = 0
    for (const m of joined.matchAll(TOKEN_PATTERN)) {
      const paste = this.pastes.get(m[0])
      if (!paste) continue
      if (m.index > last) parts.push(joined.slice(last, m.index))
      parts.push({ paste: paste.text })
      last = m.index + m[0].length
    }
    if (last < joined.length) parts.push(joined.slice(last))
    return parts
  }

  /** Replaces the content, folding the `{ paste }` parts, and puts the caret at the end. Does not call `onChange`. */
  setParts(parts: EditorPart[]): void {
    this.resetPastes()
    const text = parts
      .map((p) => (typeof p === "string" ? escapeTokens(normalize(p)) : this.addPaste(normalize(p.paste))))
      .join("")
    this.replaceAll(text.split("\n"))
    this.line = this.lines.length - 1
    this.col = this.current.length
    this.goalCol = undefined
    this.changes++
  }

  /** Replaces the text and puts the caret at the end. Does not call `onChange`. */
  setText(text: string): void {
    this.setParts([text])
  }

  clear(): void {
    this.setText("")
  }

  get isEmpty(): boolean {
    return this.lines.length === 1 && this.lines[0] === ""
  }

  /** Logical lines of text. */
  get lineCount(): number {
    return this.lines.length
  }

  /** Counts every change of the content, `setText` included; equal counts mean equal content. */
  get version(): number {
    return this.changes
  }

  /** Caret position as logical line and UTF-16 offset. */
  get cursor(): { line: number; col: number } {
    return { line: this.line, col: this.col }
  }

  /**
   * Moves the caret, clamped to the text; `col` should fall between graphemes (`Infinity` is
   * the end of the line).
   */
  setCursor(pos: { line: number; col: number }): void {
    const line = Math.min(Math.max(0, pos.line), this.lines.length - 1)
    this.moveTo({ line, col: Math.min(Math.max(0, pos.col), this.lines[line]!.length) })
  }

  /** The caret's line up to the caret; cheap, for completions that look at the word being typed. */
  textBeforeCaret(): string {
    return this.current.slice(0, this.col)
  }

  /** Replaces the `count` UTF-16 units before the caret, on its line, with `text`. */
  replaceBeforeCaret(count: number, text: string): void {
    const from = Math.max(0, this.col - count)
    if (this.pastes.size) this.dropPastes({ line: this.line, col: from }, { line: this.line, col: this.col })
    this.setLine(this.line, this.current.slice(0, from) + this.current.slice(this.col))
    this.col = from
    this.insert(text)
  }

  /**
   * Inserts `text` at the caret. Characters from the placeholders' range (Supplementary Private
   * Use Area-B) become U+FFFD, so typed or pasted text can never pose as a folded paste.
   */
  insert(text: string): void {
    this.insertRaw(escapeTokens(normalize(text)))
  }

  /** Inserts normalized text as it is, placeholders included. */
  private insertRaw(text: string): void {
    const parts = text.split("\n")
    const before = this.current.slice(0, this.col)
    const after = this.current.slice(this.col)
    const last = parts.length - 1
    if (last === 0) {
      this.setLine(this.line, before + parts[0] + after)
      this.col = before.length + parts[0]!.length
    } else {
      const inserted = parts.map((p, i) => (i === 0 ? before : "") + p + (i === last ? after : ""))
      this.spliceLines(this.line, 1, inserted)
      this.line += last
      this.col = parts[last]!.length
    }
    this.changed()
  }

  /** Inserts `text` folded into one placeholder at the caret. */
  insertPaste(text: string): void {
    this.insertRaw(this.addPaste(normalize(text)))
  }

  /**
   * Returns false for keys the editor does not use, including Enter on an empty editor, which
   * submits nothing and is left to the app.
   */
  handleInput(e: InputEvent): boolean {
    if (e.type === "paste") {
      if (this.shouldFold(e.text)) this.insertPaste(e.text)
      else this.insert(e.text)
      return true
    }
    if (e.type !== "key") return false
    if ((this.opts.isSubmit ?? isSubmitKey)(e)) {
      if (this.isEmpty) return false
      const text = this.getText()
      const info: SubmitInfo = { display: this.getDisplayText(), parts: this.getParts() }
      this.clear()
      this.opts.onSubmit?.(text, info)
      return true
    }
    if ((this.opts.isNewline ?? isNewlineKey)(e)) {
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

  render(width: number, { theme }: RenderContext): string[] {
    if (width !== this.width) {
      this.width = width
      this.prefixValid = 0
    }
    const prompt = this.opts.prompt ?? ""
    const indent = " ".repeat(this.promptWidth)
    const caret = this.focused ? CURSOR_MARKER : ""
    if (this.isEmpty && this.opts.placeholder) {
      this.top = 0
      this.hidden = { above: 0, below: 0 }
      return [theme.accent(prompt) + caret + theme.muted(this.opts.placeholder)]
    }
    const total = this.totalRows()
    const caretRow = this.caretRow()
    const shown = Math.max(1, Math.min(Math.floor(this.maxRows), total))
    // Scroll only as far as the caret needs, so the view stays put while it moves inside it.
    if (caretRow < this.top) this.top = caretRow
    else if (caretRow >= this.top + shown) this.top = caretRow - shown + 1
    this.top = Math.min(Math.max(0, this.top), total - shown)
    this.hidden = { above: this.top, below: total - this.top - shown }
    const max = this.contentWidth
    const out: string[] = []
    for (let i = this.top; i < this.top + shown; i++) {
      const row = this.rowAt(i)
      const text = this.lines[row.line]!
      let body = text.slice(row.start, row.end)
      if (i === caretRow) {
        const at = this.col - row.start
        body = body.slice(0, at) + caret + body.slice(at)
      }
      if (this.pastes.size) {
        body = this.expand(body, (p) => theme.accent(truncateToWidth(p.label, max, "…")))
      }
      out.push((i === 0 ? theme.accent(prompt) : indent) + body)
    }
    return out
  }

  private get current(): string {
    return this.lines[this.line]!
  }

  private get contentWidth(): number {
    return Math.max(2, this.width - this.promptWidth)
  }

  private shouldFold(text: string): boolean {
    const fold = this.opts.foldPastes
    if (!fold) return false
    return text.length >= fold.chars || lineCount(normalize(text)) >= fold.lines
  }

  /** Registers a folded paste and returns the character that stands for it. */
  private addPaste(text: string): string {
    let cp = this.nextToken
    // Skip characters still in use once the range wraps around (only after 1M placeholders).
    while (this.pastes.has(String.fromCodePoint(cp))) cp = cp >= TOKEN_LAST ? TOKEN_BASE : cp + 1
    this.nextToken = cp >= TOKEN_LAST ? TOKEN_BASE : cp + 1
    const token = String.fromCodePoint(cp)
    const label = (this.opts.pasteLabel ?? defaultPasteLabel)({
      lines: lineCount(text),
      chars: text.length,
      n: this.nextPaste++,
    })
    this.pastes.set(token, { text, label, width: visibleWidth(label) })
    return token
  }

  private resetPastes(): void {
    this.pastes.clear()
    this.nextPaste = 1
    this.nextToken = TOKEN_BASE
  }

  /** Replaces the placeholders in `s`. */
  private expand(s: string, as: (p: Paste) => string): string {
    return s.replace(TOKEN_PATTERN, (t) => {
      const p = this.pastes.get(t)
      return p ? as(p) : t
    })
  }

  /**
   * Cells grapheme `g` takes when `used` cells of its row are taken. A tab reaches the next tab
   * stop of the terminal line, which starts `promptWidth` cells before the row (the prompt and the
   * indent are as wide), matching how the width layer expands tabs when the row is drawn. A
   * placeholder takes its label's width, at most a row.
   */
  private cellWidth(g: string, used: number): number {
    if (g === "\t") return TAB_WIDTH - ((this.promptWidth + used) % TAB_WIDTH)
    if (g.length === 2 && this.pastes.size) {
      const p = this.pastes.get(g)
      if (p) return Math.min(p.width, this.contentWidth)
    }
    return textWidth(g)
  }

  private changed(): void {
    this.goalCol = undefined
    this.textCache = undefined
    this.changes++
    if (this.opts.onChange) this.opts.onChange(this.getText())
  }

  // --- Lines and their layout cache ---

  private replaceAll(lines: string[]): void {
    this.lines = lines
    this.layouts = new Array(lines.length)
    this.prefix = [0]
    this.prefixValid = 0
    this.textCache = undefined
  }

  private setLine(i: number, text: string): void {
    this.lines[i] = text
    this.prefixValid = Math.min(this.prefixValid, i)
    this.textCache = undefined
  }

  /** Replaces `count` lines from `from` with `lines`, keeping the layout cache aligned. */
  private spliceLines(from: number, count: number, lines: string[]): void {
    // Not splice(..., ...lines): spreading a huge paste as arguments overflows the stack.
    this.lines = this.lines.slice(0, from).concat(lines, this.lines.slice(from + count))
    this.layouts = this.layouts
      .slice(0, from)
      .concat(new Array(lines.length), this.layouts.slice(from + count))
    this.prefixValid = Math.min(this.prefixValid, from)
    this.textCache = undefined
  }

  /** How line `i` wraps at the current width; computed only when its text or the width changed. */
  private layout(i: number): LineLayout {
    const text = this.lines[i]!
    const max = this.contentWidth
    const cached = this.layouts[i]
    if (cached && cached.max === max && cached.text === text) return cached
    const fresh = this.wrap(text, max)
    this.layouts[i] = fresh
    return fresh
  }

  private wrap(text: string, max: number): LineLayout {
    if (ASCII_PRINTABLE.test(text)) {
      const starts = [0]
      for (let s = max; s < text.length; s += max) starts.push(s)
      return { text, max, starts, full: text.length > 0 && text.length % max === 0 }
    }
    // Most lines fit on one row; the whole line's width says so without splitting it.
    if (!text.includes("\t") && !(this.pastes.size && TOKEN_TEST.test(text))) {
      const w = textWidth(text)
      if (w <= max) return { text, max, starts: [0], full: w === max }
    }
    const starts = [0]
    let used = 0
    let pos = 0
    for (const g of graphemes(text)) {
      let w = this.cellWidth(g, used)
      if (used + w > max) {
        starts.push(pos)
        used = 0
        w = this.cellWidth(g, used)
      }
      used += w
      pos += g.length
    }
    return { text, max, starts, full: used >= max }
  }

  /** Brings `prefix` up to date for every line. */
  private ensurePrefix(): void {
    const n = this.lines.length
    if (this.prefixValid >= n && this.prefix.length === n + 1) return
    const prefix = this.prefix
    prefix.length = n + 1
    for (let i = this.prefixValid; i < n; i++) prefix[i + 1] = prefix[i]! + this.layout(i).starts.length
    this.prefixValid = n
  }

  /** The caret sits at the end of a line whose last row is full, on an empty row after it. */
  private extraRow(): boolean {
    return this.col === this.current.length && this.layout(this.line).full
  }

  private totalRows(): number {
    this.ensurePrefix()
    return this.prefix[this.lines.length]! + (this.extraRow() ? 1 : 0)
  }

  private caretRow(): number {
    this.ensurePrefix()
    const lay = this.layout(this.line)
    const sub = this.extraRow() ? lay.starts.length : lastAtMost(lay.starts, this.col)
    return this.prefix[this.line]! + sub
  }

  /** Visual row `r`; `ensurePrefix` must have run. */
  private rowAt(r: number): Row {
    let line: number
    let sub: number
    const extra = this.extraRow()
    const caretStart = this.prefix[this.line]!
    const caretRows = this.layout(this.line).starts.length
    if (extra && r >= caretStart && r <= caretStart + caretRows) {
      line = this.line
      sub = r - caretStart
    } else {
      const rr = extra && r > caretStart + caretRows ? r - 1 : r
      line = lastAtMost(this.prefix, rr, this.lines.length - 1)
      sub = rr - this.prefix[line]!
    }
    const text = this.lines[line]!
    const { starts } = this.layout(line)
    if (sub >= starts.length) return { line, start: text.length, end: text.length, last: true }
    const end = sub + 1 < starts.length ? starts[sub + 1]! : text.length
    const lastRow = sub === starts.length - 1 && !(extra && line === this.line)
    return { line, start: starts[sub]!, end, last: lastRow }
  }

  private vertical(dir: -1 | 1): boolean {
    const total = this.totalRows()
    const from = this.caretRow()
    if (from + dir < 0 || from + dir >= total) return false
    const row = this.rowAt(from)
    const to = this.rowAt(from + dir)
    const goal = this.goalCol ?? this.cells(this.lines[row.line]!.slice(row.start, this.col))
    const text = this.lines[to.line]!
    let col = to.start
    let used = 0
    for (const g of graphemes(text.slice(to.start, to.end))) {
      const w = this.cellWidth(g, used)
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

  /** Cells taken by `s` drawn from the start of a row. */
  private cells(s: string): number {
    let used = 0
    for (const g of graphemes(s)) used += this.cellWidth(g, used)
    return used
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
    if (this.pastes.size) this.dropPastes(a, b)
    const merged = this.lines[a.line]!.slice(0, a.col) + this.lines[b.line]!.slice(b.col)
    if (a.line === b.line) this.setLine(a.line, merged)
    else this.spliceLines(a.line, b.line - a.line + 1, [merged])
    this.line = a.line
    this.col = a.col
    this.changed()
    return true
  }

  /** Forgets the pastes whose placeholders lie in the range about to be deleted. */
  private dropPastes(a: { line: number; col: number }, b: { line: number; col: number }): void {
    for (let i = a.line; i <= b.line; i++) {
      const text = this.lines[i]!
      const part = text.slice(i === a.line ? a.col : 0, i === b.line ? b.col : text.length)
      for (const m of part.matchAll(TOKEN_PATTERN)) this.pastes.delete(m[0])
    }
  }

  private charLeft(): { line: number; col: number } {
    if (this.col > 0) return { line: this.line, col: lastBoundary(this.current.slice(0, this.col)) }
    if (this.line > 0) return { line: this.line - 1, col: this.lines[this.line - 1]!.length }
    return { line: this.line, col: 0 }
  }

  private charRight(): { line: number; col: number } {
    if (this.col < this.current.length) {
      return { line: this.line, col: this.col + graphemeLengthAt(this.current, this.col) }
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

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

/** `text` with placeholder-range characters replaced by U+FFFD (see `insert`). */
function escapeTokens(text: string): string {
  return TOKEN_TEST.test(text) ? text.replace(TOKEN_PATTERN, "�") : text
}

/** Lines of `text`; a trailing line break does not start another. */
function lineCount(text: string): number {
  let n = 1
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++
  return text.endsWith("\n") ? n - 1 : n
}

/** Index of the last element of the ascending `xs[0..hi]` that is at most `x` (0 if none). */
function lastAtMost(xs: number[], x: number, hi = xs.length - 1): number {
  let lo = 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (xs[mid]! <= x) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** UTF-16 units looked at around the caret to find a grapheme boundary; grown for longer clusters. */
const BOUNDARY_WINDOW = 128

/**
 * Start of the last grapheme of `s`. Looks at the end only, widening the look while the whole
 * window is one grapheme (a cluster of many combining marks), so a long cluster stays whole.
 */
function lastBoundary(s: string): number {
  for (let n = BOUNDARY_WINDOW; ; n *= 2) {
    const gs = graphemes(s.slice(-n))
    const last = gs[gs.length - 1]?.length ?? 0
    if (last < n || n >= s.length) return s.length - last
  }
}

/** Length of the grapheme of `s` starting at `from`, widening the look like `lastBoundary`. */
function graphemeLengthAt(s: string, from: number): number {
  for (let n = BOUNDARY_WINDOW; ; n *= 2) {
    const ahead = s.slice(from, from + n)
    const first = segmenter.segment(ahead)[Symbol.iterator]().next().value?.segment.length ?? 1
    if (first < n || ahead.length < n) return first
  }
}
