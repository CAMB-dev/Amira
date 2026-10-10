import type { ToolDetailLevel } from "@amira/api"
import { visibleWidth } from "@amira/tui-kit"
import type { Block, BlockEnv } from "../blocks.ts"
import { markCells, selectionMarks, sliceCells, wordAt } from "../text-selection.ts"
import type { PaneRow, TextPoint } from "../transcript-pane.ts"

interface SelectionView {
  blocks: readonly Block[]
  env(): BlockEnv | undefined
  layout(): readonly PaneRow[]
  padding(): number
  lines(block: Block, env: BlockEnv): string[]
  plain(block: Block, env: BlockEnv): string[]
  gapBefore(index: number, env: BlockEnv): boolean
  imageRowsOf(env: BlockEnv): string
  clearSelectedBlock(): void
}

/**
 * Text selected with the mouse, from `anchor` (where the press was) to `focus` (where the
 * mouse is or was released), both cells included. It holds on to the blocks and the text it
 * covers as drawn at `width`, and goes when that text changes.
 */
interface TextSelection {
  anchor: TextPoint
  focus: TextPoint
  width: number
  detail: ToolDetailLevel
  imageRows: string
  /** The blocks it covers, in order. */
  blocks: Block[]
  /**
   * Each block's version when it was taken, and for a block that changes by itself (`live`:
   * a reply streaming, a call running) the text of its rows then.
   */
  texts: Map<Block, { version: ReturnType<Block["cacheVersion"]>; text?: string }>
}

/** Orders two cells of the transcript. */
function compare(a: TextPoint, b: TextPoint): number {
  if (a.block !== b.block) return a.block.index - b.block.index
  if (a.line !== b.line) return a.line - b.line
  return a.col === b.col ? 0 : a.col < b.col ? -1 : 1
}

/** What changes in a running call's rows by itself: its elapsed time, its spinner (braille). */
const TICKING = /[\d⠀-⣿]/g

export class PaneTextSelection {
  /** Text selected with the mouse, if any. */
  private text: TextSelection | undefined
  /** A drag selecting text: the cell it started at, where the mouse is (viewport rows), whether it left that cell. */
  private drag: { anchor: TextPoint; row: number; col: number; moved: boolean } | undefined

  constructor(private readonly view: SelectionView) {}

  update(env: BlockEnv): void {
    this.checkText(env)
    // Scrolled while dragging (the wheel, or the drag at an edge): the mouse is over other text.
    if (this.drag) this.dragText()
  }

  row(r: PaneRow, env: BlockEnv) {
    const range = this.rangeIn(r.block, r.line)
    const marks = range && selectionMarks(env.theme)
    // A row selected to its end (and on, to the next) shows it with a marked cell after its
    // text, as terminals show a selected line break; so do blank rows in the selection.
    const end = (line: string) =>
      range?.to === Number.POSITIVE_INFINITY && visibleWidth(line) < env.width
        ? `${line}${marks!.on} ${marks!.off}`
        : line
    return {
      end,
      mark: range ? (line: string) => end(markCells(line, range.from, range.to, marks!)) : undefined,
    }
  }

  /** Whether text is selected with the mouse. */
  get hasText(): boolean {
    return this.text !== undefined
  }

  /** Whether the mouse is selecting text. */
  get dragging(): boolean {
    return this.drag !== undefined
  }

  /**
   * The cell at a row and column of the viewport in the last frame. Above its rows (the padding
   * over short content) is the start of the first one, below them the end of the last.
   */
  pointAt(row: number, col: number): TextPoint | undefined {
    const layout = this.view.layout()
    if (!layout.length) return undefined
    const i = row - this.view.padding()
    if (i < 0) return { ...layout[0]!, col: 0 }
    if (i >= layout.length) return { ...layout[layout.length - 1]!, col: Number.POSITIVE_INFINITY }
    return { ...layout[i]!, col: Math.max(0, col) }
  }

  /** Selects the text from `anchor` to `focus`, both cells included; the selected block goes. */
  selectText(anchor: TextPoint, focus: TextPoint): void {
    const env = this.view.env()
    if (!env) return
    this.view.clearSelectedBlock()
    this.text = {
      anchor,
      focus,
      width: env.width,
      detail: env.detail,
      imageRows: this.view.imageRowsOf(env),
      blocks: [],
      texts: new Map(),
    }
    const [start, end] = this.ends()!
    this.text.blocks = this.view.blocks.slice(start.block.index, end.block.index + 1)
    // Only blocks that change by themselves keep their text: for the others, the version says.
    for (const b of this.text.blocks)
      this.text.texts.set(b, {
        version: b.cacheVersion(env),
        ...(b.live ? { text: this.textIn(b, env) } : {}),
      })
  }

  clearText(): void {
    this.text = undefined
    this.drag = undefined
  }

  /** Starts selecting text at a cell of the viewport; nothing is selected until the mouse leaves it. */
  startDrag(row: number, col: number): void {
    this.clearText()
    const anchor = this.pointAt(row, col)
    if (anchor) this.drag = { anchor, row, col, moved: false }
  }

  /** The mouse moved to a cell of the viewport while selecting. */
  dragTo(row: number, col: number): void {
    if (!this.drag) return
    this.drag.row = row
    this.drag.col = col
    this.dragText()
  }

  /** The mouse was released: the selection stays, if the mouse moved. */
  endDrag(): void {
    this.drag = undefined
  }

  /** The cell at a row and column of the viewport in the last frame, if a row of text is there. */
  private hit(row: number, col: number): TextPoint | undefined {
    const r = this.view.layout()[row - this.view.padding()]
    return r && r.line >= 0 && row >= this.view.padding() ? { ...r, col: Math.max(0, col) } : undefined
  }

  /** Selects the word at a cell of the viewport. False when there is none (a blank row). */
  selectWord(row: number, col: number): boolean {
    const env = this.view.env()
    const at = this.hit(row, col)
    if (!env || !at) return false
    const range = wordAt(this.view.plain(at.block, env)[at.line] ?? "", at.col)
    if (!range) return false
    this.selectText({ ...at, col: range.from }, { ...at, col: range.to - 1 })
    return true
  }

  /** Selects the line at a row of the viewport, with the rows it wraps over. False on a blank row. */
  selectLine(row: number, col: number): boolean {
    const env = this.view.env()
    const at = this.hit(row, col)
    if (!env || !at) return false
    const lines = this.view.lines(at.block, env)
    const rows = at.block.copyRows(this.view.plain(at.block, env), lines)
    let first = at.line
    let last = at.line
    while (first > 0 && rows[first]?.joins) first--
    while (rows[last + 1]?.joins) last++
    this.selectText({ ...at, line: first, col: 0 }, { ...at, line: last, col: Number.POSITIVE_INFINITY })
    return true
  }

  /**
   * The selected text as it copies: the rows as shown, less the transcript's chrome (gutters,
   * trees, code frames: see `Block.copyRows`), wrapped lines of code joined, images as their
   * alt text, a blank line where the transcript has one between blocks.
   */
  selectedText(): string {
    const env = this.view.env()
    const ends = this.ends()
    if (!env || !ends) return ""
    const [start, end] = ends
    /** Lines copied, and whether each was selected whole (then its `exact` form copies). */
    const out: { text: string; whole: boolean; exact?: string | undefined }[] = []
    for (let k = start.block.index; k <= end.block.index; k++) {
      const block = this.view.blocks[k]!
      const lines = this.view.lines(block, env)
      if (!lines.length) continue
      if (this.view.gapBefore(k, env) && this.rangeIn(block, -1)) out.push({ text: "", whole: false })
      const plain = this.view.plain(block, env)
      const rows = block.copyRows(plain, lines)
      let last = -2
      for (let l = 0; l < lines.length; l++) {
        const range = this.rangeIn(block, l)
        const row = rows[l] ?? { from: 0 }
        if (!range || row.skip || (row.repeats && last === l - 1)) continue
        const text =
          row.text ??
          sliceCells(
            plain[l]!,
            Math.max(range.from, row.from),
            Math.min(range.to, row.to ?? Number.POSITIVE_INFINITY),
          )
        const whole = range.from <= row.from && range.to >= visibleWidth(plain[l]!)
        const prev = out[out.length - 1]
        if (row.joins && last === l - 1 && prev) {
          prev.text += text
          prev.whole &&= whole
        } else out.push({ text, whole, exact: row.exact })
        last = l
      }
    }
    const lines = out.map((l) => (l.whole && l.exact !== undefined ? l.exact : l.text).trimEnd())
    while (lines.length && !lines[0]) lines.shift()
    while (lines.length && !lines[lines.length - 1]) lines.pop()
    return lines.join("\n")
  }

  /** The selection's first and last cells, in order. */
  private ends(): [TextPoint, TextPoint] | undefined {
    const t = this.text
    if (!t) return undefined
    return compare(t.anchor, t.focus) <= 0 ? [t.anchor, t.focus] : [t.focus, t.anchor]
  }

  /** The columns selected in a line of a block (`to` excluded), if any. */
  private rangeIn(block: Block, line: number): { from: number; to: number } | undefined {
    const ends = this.ends()
    if (!ends) return undefined
    const [s, e] = ends
    const before = block.index < s.block.index || (block === s.block && line < s.line)
    const after = block.index > e.block.index || (block === e.block && line > e.line)
    if (before || after) return undefined
    const from = block === s.block && line === s.line ? s.col : 0
    const to = block === e.block && line === e.line ? e.col + 1 : Number.POSITIVE_INFINITY
    return { from, to }
  }

  /**
   * The selected characters of a block's lines, as drawn; what a change to a live block is
   * checked by. Digits and spinner glyphs do not count: a running call's elapsed time and
   * spinner move by themselves.
   */
  private textIn(block: Block, env: BlockEnv): string {
    const [s, e] = this.ends()!
    const plain = this.view.plain(block, env)
    const first = block === s.block ? Math.max(0, s.line) : 0
    const last = block === e.block ? e.line : plain.length - 1
    const out: string[] = []
    for (let l = first; l <= last; l++) {
      const r = this.rangeIn(block, l)!
      // A line it covers is gone: that is not the text it had.
      out.push(l < plain.length ? sliceCells(plain[l]!, r.from, r.to) : "\0")
    }
    return out.join("\n").replace(TICKING, "#")
  }

  /**
   * Keeps the selection while the text it covers stays as it was: new output below it, a
   * reply streaming on, scrolling. It goes with a new width (the text flows differently: its
   * cells would be other text), a block of it removed or one put in it, and a change to the
   * text it covers (a call finishing, folding).
   */
  private checkText(env: BlockEnv): void {
    const t = this.text
    const ends = this.ends()
    if (!t || !ends) return
    const [s, e] = ends
    const keep = (() => {
      if (t.width !== env.width || s.block.index < 0 || e.block.index < 0) return false
      const blocks = this.view.blocks.slice(s.block.index, e.block.index + 1)
      if (blocks.length !== t.blocks.length || blocks.some((b, i) => b !== t.blocks[i])) return false
      // Another tool output level or image size: the blocks are drawn afresh.
      if (t.detail !== env.detail || t.imageRows !== this.view.imageRowsOf(env)) return false
      for (const b of blocks) {
        const was = t.texts.get(b)!
        if (was.text === undefined) {
          if (b.cacheVersion(env) !== was.version) return false
          // It started changing by itself (a sub-agent of a finished call started).
          if (b.live) was.text = this.textIn(b, env)
          continue
        }
        // A live block (or one that just stopped: a reply that finished) by its text.
        if (this.textIn(b, env) !== was.text) return false
        was.version = b.cacheVersion(env)
        if (!b.live) delete was.text
      }
      return true
    })()
    if (!keep) {
      this.text = undefined
      if (t.width !== env.width) this.drag = undefined
    }
  }

  /** Selects from where the drag started to the cell under the mouse, once it left the first one. */
  private dragText(): void {
    const d = this.drag!
    if (d.anchor.block.index < 0) {
      this.drag = undefined
      return
    }
    const focus = this.pointAt(d.row, d.col)
    if (!focus) return
    if (!d.moved && compare(focus, d.anchor) === 0) return
    d.moved = true
    const t = this.text
    if (t && t.anchor === d.anchor && compare(t.focus, focus) === 0) return
    this.selectText(d.anchor, focus)
  }
}
