import type { ToolDetailLevel } from "@amira/api"
import { type ImagePlacement, stripAnsi, type Theme, truncateToWidth, visibleWidth } from "@amira/tui-kit"
import { type Block, type BlockEnv, type CodeFrame, codeFrames, imagesIn, ReplyBlock } from "./blocks.ts"
import { cellsOf, ESCAPE, markCells, selectionMarks, sliceCells, wordAt } from "./text-selection.ts"
import { gapBetween } from "./transcript.ts"

/** Lines of a block drawn at one width, for one version of it. */
interface Drawn {
  width: number
  version: number
  detail: ToolDetailLevel
  /** The most rows an image could take (0 without images), and the renderers of extensions. */
  imageRows: string
  /** The frame it was drawn in, for live blocks, which are drawn once per frame. */
  frame: number
  lines: string[]
  plain?: string[]
  /** The find bar's matches in these lines, for the query (as searched) they were found for. */
  found?: { query: string; matches: Match[][] }
}

/** What a row of the last frame showed: a line of a block, or the gap before one (`line` -1). */
export interface PaneRow {
  block: Block
  line: number
}

/** A match of the find bar on a row: `len` characters at `col` of the plain text of a block's line. */
export interface Match {
  block: Block
  line: number
  col: number
  len: number
}

/** A row position in the transcript: `offset` rows into a block's rows (its gap row first). */
interface Position {
  block: Block
  offset: number
}

/**
 * A cell of the transcript's text: column `col` of a block's line (`line` -1 is the gap row
 * before it). Infinity as `col` is the end of the line.
 */
export interface TextPoint {
  block: Block
  line: number
  col: number
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
  texts: Map<Block, { version: number; text?: string }>
}

/** Orders two cells of the transcript. */
function compare(a: TextPoint, b: TextPoint): number {
  if (a.block !== b.block) return a.block.index - b.block.index
  if (a.line !== b.line) return a.line - b.line
  return a.col === b.col ? 0 : a.col < b.col ? -1 : 1
}

/** What changes in a running call's rows by itself: its elapsed time, its spinner (braille). */
const TICKING = /[\d⠀-⣿]/g

/** What decides how blocks lay out besides the width: image rows, and the renderers of extensions. */
const imageRowsOf = (env: BlockEnv) =>
  `${env.images ? env.images.store.maxRows() : 0}:${env.renders?.renders.generation ?? -1}`

/** How often matches are found again while a block changes by itself (a reply streaming). */
const FIND_LIVE_MS = 250

/**
 * Marks the rows of the selected block in their first column, which is mostly blank (the
 * indent of replies, the band's edge): there it is this bar; a character there shows in
 * inverse video instead. Its text stays where it is, at the same width.
 */
const SELECTED = "▌"

/**
 * The full-screen transcript: the blocks of the conversation in order, drawn into a viewport
 * of `height` rows. Only blocks in view are drawn, and a block's lines are kept per width and
 * version, so a frame costs what is on screen, not the length of the conversation; blocks
 * that are `live` are drawn afresh once per frame.
 *
 * It follows the end by default. Scrolling up keeps the rows in view where they are while
 * the conversation grows (and notes that there is new output); scrolling back to the end
 * follows again. It also keeps a selected block and the matches of the find bar.
 */
export class TranscriptPane {
  readonly blocks: Block[] = []
  /** Whether the view keeps to the end as blocks arrive and grow. */
  following = true
  /** Something changed while not following. */
  unseen = false
  selected: Block | undefined
  /** The selected code block of the selected reply, by its number there. */
  private code: number | undefined
  /** Rows of the last frame, top to bottom; the padding above short content is left out. */
  layout: PaneRow[] = []
  /** Rows of blank padding above the content in the last frame. */
  padding = 0
  /** Images of the last frame, by rows of the viewport. */
  placements: ImagePlacement[] = []
  private drawn = new WeakMap<Block, Drawn[]>()
  private anchor: Position | undefined
  /** The first row of the last frame. */
  private top: Position | undefined
  private frame = 0
  private env: BlockEnv | undefined
  private height = 1
  /** Matches of the find bar, top to bottom; each is a segment per row it covers. */
  private matches: Match[][] = []
  private matchIndex = new Map<Block, Map<number, Match[]>>()
  private current = -1
  private findQuery = ""
  private findWidth = 0
  /** What the matches were found in (see `stamp`). */
  private findStamp = ""
  /** Text selected with the mouse, if any. */
  private text: TextSelection | undefined
  /** A drag selecting text: the cell it started at, where the mouse is (viewport rows), whether it left that cell. */
  private drag: { anchor: TextPoint; row: number; col: number; moved: boolean } | undefined

  add(block: Block): void {
    block.index = this.blocks.length
    this.blocks.push(block)
    this.changed()
  }

  /** Puts `block` right after `after`. */
  insertAfter(after: Block, block: Block): void {
    this.blocks.splice(after.index + 1, 0, block)
    this.reindex(after.index + 1)
    this.changed()
  }

  remove(block: Block): void {
    if (block.index < 0 || this.blocks[block.index] !== block) return
    this.blocks.splice(block.index, 1)
    this.reindex(block.index)
    block.index = -1
    if (this.selected === block) this.select(undefined)
    this.changed()
  }

  /**
   * Starts afresh with the blocks `keep` keeps (the banner): the rest goes, and with it the
   * selection, selected text and find matches; the view follows the end.
   */
  clear(keep: (b: Block) => boolean): void {
    const kept = this.blocks.filter(keep)
    for (const b of this.blocks) if (!kept.includes(b)) b.index = -1
    this.blocks.splice(0, this.blocks.length, ...kept)
    this.reindex(0)
    this.select(undefined)
    this.clearText()
    this.clearFind()
    this.layout = []
    this.top = undefined
    this.follow()
  }

  get last(): Block | undefined {
    return this.blocks[this.blocks.length - 1]
  }

  /** Notes a change to the conversation, shown as new output when scrolled up. */
  changed(): void {
    if (!this.following) this.unseen = true
  }

  /** A block's lines at the env's width. */
  lines(block: Block, env: BlockEnv): string[] {
    return this.draw(block, env).lines
  }

  /** A block's lines without styling, for finding text in them. */
  plain(block: Block, env: BlockEnv): string[] {
    const d = this.draw(block, env)
    d.plain ??= d.lines.map(stripAnsi)
    return d.plain
  }

  /**
   * The rows of the viewport, `height` of them: blank padding above content shorter than
   * that, then the blocks in view, the selected one marked and matches of the find bar
   * highlighted.
   */
  render(env: BlockEnv, height: number): string[] {
    this.frame++
    this.env = env
    this.height = Math.max(1, height)
    // The matches follow the text: another width, blocks that came or changed, a reply streaming.
    if (this.findQuery && (this.findWidth !== env.width || this.findStamp !== this.stamp())) this.runFind()
    let rows: PaneRow[] | undefined
    if (!this.following) {
      const a = this.anchor
      if (a && a.block.index >= 0) {
        rows = this.fill(a.block.index, a.offset, this.height)
        this.top = a
      }
      if (!rows || rows.length < this.height) this.follow()
    }
    if (this.following) rows = this.fillTail(this.height)
    this.layout = rows!
    this.padding = this.height - this.layout.length
    this.checkText(env)
    // Scrolled while dragging (the wheel, or the drag at an edge): the mouse is over other text.
    if (this.drag) this.dragText()
    const alt = this.placeImages(env)
    const out: string[] = Array(this.padding).fill("")
    for (let i = 0; i < this.layout.length; i++) out.push(this.drawRow(this.layout[i]!, env, alt.get(i)))
    return out
  }

  /**
   * Works out where the images of the blocks in view go (`placements`, rows counted from the
   * top of the viewport), cropped to the rows in view. One that cannot be drawn shows its alt
   * text on its first row in view instead: while it gets ready, and when only part of it is in
   * view and its protocol draws images whole ("scroll to view"). Returns those rows by index
   * in the layout.
   */
  private placeImages(env: BlockEnv): Map<number, string> {
    this.placements = []
    const alt = new Map<number, string>()
    if (!env.images) return alt
    const layout = this.layout
    for (let i = 0; i < layout.length; ) {
      const block = layout[i]!.block
      let j = i
      while (j < layout.length && layout[j]!.block === block) j++
      const images = imagesIn(this.draw(block, env).lines)
      const first = layout[i]!.line
      const last = layout[j - 1]!.line
      for (const im of images ?? []) {
        const top = Math.max(im.line, first)
        const end = Math.min(im.line + im.image.rows, last + 1)
        if (end <= top) continue
        const from = top - im.line
        const to = end - im.line
        const at = i + (top - first)
        const col = im.col
        const indent = " ".repeat(im.col)
        if (from === 0 && to === im.image.rows ? false : !im.image.croppable) {
          // Drawn whole only: said where to find it, when the view is tall enough to show it.
          const note = im.image.rows <= this.height ? env.theme.muted(" (scroll to view)") : ""
          alt.set(at, `${indent}${im.alt}${note}`)
          continue
        }
        // In view: kept, and prepared if it is not ready.
        im.image.want()
        if (im.image.ready) {
          this.placements.push({
            image: im.image,
            row: this.padding + at,
            col,
            from,
            to,
            key: `${block.id}:${im.line}`,
          })
          continue
        }
        if (!im.image.broken) im.image.whenReady(env.images.changed)
        alt.set(at, `${indent}${im.alt}`)
      }
      i = j
    }
    return alt
  }

  /**
   * Every block at `width`, spaced like the inline transcript: what exiting prints. Blocks
   * folded or unfolded by hand print as the inline transcript shows them, so nothing folded
   * away is lost. Images print as their alt text: the normal screen is text.
   */
  printout(env: BlockEnv): string[] {
    const out: string[] = []
    let prev: Block | undefined
    const { images: _, ...text } = env
    for (const b of this.blocks) {
      let lines: string[]
      if (b.refolded) lines = b.printLines(text)
      else if (b instanceof ReplyBlock) {
        // Laid out without images (none is loaded for it), unless its lines as shown have none.
        const shown = this.cached(b, env)
        lines = shown && !imagesIn(shown) ? shown : b.printLines(text)
      } else lines = this.lines(b, env)
      if (!lines.length) continue
      if (prev && gapBetween(prev.kind, b.kind)) out.push("")
      out.push(...lines)
      prev = b
    }
    return out
  }

  // --- scrolling

  /** Scrolls by `rows` (negative is up). Reaching the end follows it again. */
  scrollBy(rows: number): void {
    if (!this.env || !this.blocks.length) return
    if (this.following) {
      if (rows >= 0 || !this.top) return
      this.anchor = { ...this.top }
      this.following = false
    }
    this.moveTo(this.anchor!.block.index, this.anchor!.offset + rows)
  }

  pageUp(): void {
    this.scrollBy(-Math.max(1, this.height - 1))
  }

  pageDown(): void {
    this.scrollBy(Math.max(1, this.height - 1))
  }

  toTop(): void {
    const first = this.blocks[0]
    if (!first || !this.env) return
    this.following = false
    this.moveTo(0, 0)
  }

  follow(): void {
    this.following = true
    this.unseen = false
    this.anchor = undefined
  }

  // --- selection

  /** Selects a block, or none, and scrolls it into view. Selected text goes. */
  select(block: Block | undefined): void {
    this.selected = block
    this.code = undefined
    if (block) {
      this.clearText()
      this.reveal(block)
    }
  }

  /** Selects the block before the selected one (the newest one when none is), skipping empty ones. */
  selectPrev(): void {
    if (!this.env) return
    const from = this.selected ? this.selected.index - 1 : this.blocks.length - 1
    for (let i = from; i >= 0; i--) {
      if (this.lines(this.blocks[i]!, this.env).length) {
        this.select(this.blocks[i])
        return
      }
    }
  }

  selectNext(): void {
    if (!this.env || !this.selected) return
    for (let i = this.selected.index + 1; i < this.blocks.length; i++) {
      if (this.lines(this.blocks[i]!, this.env).length) {
        this.select(this.blocks[i])
        return
      }
    }
  }

  /**
   * Scrolls so `block` is in view: its top when it is above, its end when it is below. A block
   * already partly in view stays where it is (a long reply at the end is not scrolled to its
   * top).
   */
  reveal(block: Block): void {
    const env = this.env
    if (!env || block.index < 0) return
    if (this.layout.some((r) => r.block === block && r.line >= 0)) return
    this.revealRows(block, 0, this.lines(block, env).length - 1)
  }

  /** Scrolls so lines `from` to `to` of `block` are in view, unless they are: as `reveal` does. */
  private revealRows(block: Block, from: number, to: number): void {
    const env = this.env
    if (!env || block.index < 0) return
    const rows = this.layout.filter((r) => r.block === block)
    if (rows.some((r) => r.line === from) && rows.some((r) => r.line === to)) return
    const above =
      !this.layout.length ||
      this.layout[0]!.block.index > block.index ||
      (this.layout[0]!.block === block && this.layout[0]!.line > from)
    const gap = this.gapBefore(block.index, env) ? 1 : 0
    this.following = false
    if (above || to - from + 1 >= this.height) this.moveTo(block.index, gap + from)
    else this.moveTo(block.index, gap + to + 1 - this.height)
  }

  // --- code blocks of the selected reply

  /** The code blocks of `block` (a reply's) as drawn now; none for other blocks. */
  codeBlocks(block: Block | undefined): CodeFrame[] {
    if (!(block instanceof ReplyBlock) || !this.env) return []
    return codeFrames(this.plain(block, this.env))
  }

  /** The selected code block of the selected reply, if one is. */
  get selectedCode(): { frame: CodeFrame; index: number; count: number } | undefined {
    if (this.code === undefined) return undefined
    const frames = this.codeBlocks(this.selected)
    const frame = frames[this.code]
    return frame ? { frame, index: this.code, count: frames.length } : undefined
  }

  /**
   * Selects a code block of the selected reply: the first (`step` 0), or the one before or
   * after the selected one; scrolls it into view. False when the reply has none.
   */
  selectCode(step: -1 | 0 | 1): boolean {
    const frames = this.codeBlocks(this.selected)
    if (!frames.length || !this.selected) return false
    const at = this.code === undefined || step === 0 ? 0 : this.code + step
    this.code = Math.max(0, Math.min(frames.length - 1, at))
    const f = frames[this.code]!
    this.revealRows(this.selected, f.top, f.bottom ?? f.rows[f.rows.length - 1] ?? f.top)
    return true
  }

  /** Back from a code block to its whole reply. */
  leaveCode(): void {
    this.code = undefined
  }

  /**
   * The code of the selected code block as it copies: its lines as written in the reply (a line
   * wrapped over rows is one line), without the frame.
   */
  codeText(): string {
    const env = this.env
    const code = this.selectedCode
    const block = this.selected
    if (!env || !code || !block) return ""
    const plain = this.plain(block, env)
    const rows = block.copyRows(plain, this.lines(block, env))
    const out: string[] = []
    let exact = false
    for (const r of code.frame.rows) {
      const row = rows[r] ?? { from: 0 }
      if (row.skip) continue
      if (row.joins && out.length) {
        if (!exact) out[out.length - 1] += sliceCells(plain[r]!, row.from, Number.POSITIVE_INFINITY)
        continue
      }
      exact = row.exact !== undefined
      out.push(row.exact ?? row.text ?? sliceCells(plain[r]!, row.from, Number.POSITIVE_INFINITY))
    }
    return out.map((l) => l.trimEnd()).join("\n")
  }

  // --- where the view is

  /** Rows of the transcript below the last one in view: none while following the end. */
  get rowsBelow(): number {
    const env = this.env
    const last = this.layout[this.layout.length - 1]
    if (!env || !last || this.following || last.block.index < 0) return 0
    let n = this.lines(last.block, env).length - 1 - last.line
    for (let k = last.block.index + 1; k < this.blocks.length; k++) n += this.rowsOf(k, env)
    return n
  }

  // --- text selection

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
    const layout = this.layout
    if (!layout.length) return undefined
    const i = row - this.padding
    if (i < 0) return { ...layout[0]!, col: 0 }
    if (i >= layout.length) return { ...layout[layout.length - 1]!, col: Number.POSITIVE_INFINITY }
    return { ...layout[i]!, col: Math.max(0, col) }
  }

  /** Selects the text from `anchor` to `focus`, both cells included; the selected block goes. */
  selectText(anchor: TextPoint, focus: TextPoint): void {
    const env = this.env
    if (!env) return
    this.selected = undefined
    this.text = {
      anchor,
      focus,
      width: env.width,
      detail: env.detail,
      imageRows: imageRowsOf(env),
      blocks: [],
      texts: new Map(),
    }
    const [start, end] = this.ends()!
    this.text.blocks = this.blocks.slice(start.block.index, end.block.index + 1)
    // Only blocks that change by themselves keep their text: for the others, the version says.
    for (const b of this.text.blocks)
      this.text.texts.set(b, { version: b.version, ...(b.live ? { text: this.textIn(b, env) } : {}) })
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
    const r = this.layout[row - this.padding]
    return r && r.line >= 0 && row >= this.padding ? { ...r, col: Math.max(0, col) } : undefined
  }

  /** Selects the word at a cell of the viewport. False when there is none (a blank row). */
  selectWord(row: number, col: number): boolean {
    const env = this.env
    const at = this.hit(row, col)
    if (!env || !at) return false
    const range = wordAt(this.plain(at.block, env)[at.line] ?? "", at.col)
    if (!range) return false
    this.selectText({ ...at, col: range.from }, { ...at, col: range.to - 1 })
    return true
  }

  /** Selects the line at a row of the viewport, with the rows it wraps over. False on a blank row. */
  selectLine(row: number, col: number): boolean {
    const env = this.env
    const at = this.hit(row, col)
    if (!env || !at) return false
    const lines = this.lines(at.block, env)
    const rows = at.block.copyRows(this.plain(at.block, env), lines)
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
    const env = this.env
    const ends = this.ends()
    if (!env || !ends) return ""
    const [start, end] = ends
    /** Lines copied, and whether each was selected whole (then its `exact` form copies). */
    const out: { text: string; whole: boolean; exact?: string | undefined }[] = []
    for (let k = start.block.index; k <= end.block.index; k++) {
      const block = this.blocks[k]!
      const lines = this.lines(block, env)
      if (!lines.length) continue
      if (this.gapBefore(k, env) && this.rangeIn(block, -1)) out.push({ text: "", whole: false })
      const plain = this.plain(block, env)
      const rows = block.copyRows(plain, lines)
      let last = -2
      for (let l = 0; l < lines.length; l++) {
        const range = this.rangeIn(block, l)
        const row = rows[l] ?? { from: 0 }
        if (!range || row.skip || (row.repeats && last === l - 1)) continue
        const text = row.text ?? sliceCells(plain[l]!, Math.max(range.from, row.from), range.to)
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
    const plain = this.plain(block, env)
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
      const blocks = this.blocks.slice(s.block.index, e.block.index + 1)
      if (blocks.length !== t.blocks.length || blocks.some((b, i) => b !== t.blocks[i])) return false
      // Another tool output level or image size: the blocks are drawn afresh.
      if (t.detail !== env.detail || t.imageRows !== imageRowsOf(env)) return false
      for (const b of blocks) {
        const was = t.texts.get(b)!
        if (was.text === undefined) {
          if (b.version !== was.version) return false
          // It started changing by itself (a sub-agent of a finished call started).
          if (b.live) was.text = this.textIn(b, env)
          continue
        }
        // A live block (or one that just stopped: a reply that finished) by its text.
        if (this.textIn(b, env) !== was.text) return false
        was.version = b.version
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

  // --- find

  get findActive(): boolean {
    return this.findQuery !== ""
  }

  get matchCount(): number {
    return this.matches.length
  }

  /** The current match, 1-based from the top, or 0. */
  get matchPosition(): number {
    return this.current + 1
  }

  /**
   * Finds `query` in the text of every block (ignoring case unless it has capitals) and
   * moves to the newest match at or above the bottom of the view.
   */
  find(query: string): void {
    this.findQuery = query
    this.runFind()
    if (!this.matches.length) return
    const bottom = this.layout[this.layout.length - 1]
    let pick = this.matches.length - 1
    if (!this.following && bottom) {
      const at = this.matches.findLastIndex(
        ([m]) => m!.block.index < bottom.block.index || (m!.block === bottom.block && m!.line <= bottom.line),
      )
      if (at !== -1) pick = at
    }
    this.jump(pick)
  }

  /** Moves to the match before the current one (up), or after it (`step` 1, down), wrapping. */
  stepMatch(step: -1 | 1): void {
    if (!this.findQuery) return
    this.runFind()
    if (!this.matches.length) return
    const n = this.matches.length
    this.jump(((((this.current < 0 ? n : this.current) + step) % n) + n) % n)
  }

  clearFind(): void {
    this.findQuery = ""
    this.matches = []
    this.matchIndex.clear()
    this.current = -1
  }

  /**
   * Finds the query in each block's text as one run: its rows without their indent, a space
   * between rows (where the text wrapped, the space it broke at; none after a wide character,
   * where CJK text wraps without one), a blank row a break no match
   * crosses. So a match does not depend on where the width wraps the text; one that goes over
   * rows is a segment on each. The current match stays the one it was, where it still is.
   */
  private runFind(): void {
    const env = this.env
    const was = this.matches[this.current]?.[0]
    this.matches = []
    this.matchIndex.clear()
    if (!env || !this.findQuery) return
    this.findWidth = env.width
    this.findStamp = this.stamp()
    const exact = this.findQuery !== this.findQuery.toLowerCase()
    const q = exact ? this.findQuery : this.findQuery.toLowerCase()
    for (const block of this.blocks) {
      // Found again only in blocks drawn anew (streaming, changed): rerunning stays cheap.
      const d = this.draw(block, env)
      if (d.found?.query !== q)
        d.found = { query: q, matches: findIn(block, this.plain(block, env), q, exact) }
      for (const match of d.found.matches) {
        this.matches.push(match)
        let byLine = this.matchIndex.get(block)
        if (!byLine) {
          byLine = new Map()
          this.matchIndex.set(block, byLine)
        }
        for (const m of match) byLine.set(m.line, [...(byLine.get(m.line) ?? []), m])
      }
    }
    if (was) {
      const same = this.matches.findIndex(
        (m) => m[0]!.block === was.block && m[0]!.line === was.line && m[0]!.col === was.col,
      )
      if (same !== -1) this.current = same
    }
    if (this.current >= this.matches.length) this.current = this.matches.length - 1
  }

  /**
   * What the matches depend on besides the width: the blocks and their versions, and while a
   * block changes by itself (a reply streaming) the time, a few times a second.
   */
  private stamp(): string {
    let versions = 0
    let live = false
    for (const b of this.blocks) {
      versions += b.version
      live ||= b.live
    }
    return `${this.blocks.length}:${versions}:${live ? Math.floor(Date.now() / FIND_LIVE_MS) : ""}`
  }

  private jump(i: number): void {
    const env = this.env
    const m = this.matches[i]?.[0]
    if (!env || !m) return
    this.current = i
    const gap = this.gapBefore(m.block.index, env) ? 1 : 0
    this.following = false
    this.moveTo(m.block.index, gap + m.line - Math.floor(this.height / 2))
  }

  // --- drawing

  /** A block's lines at the env's width if they were drawn and are still current. */
  private cached(block: Block, env: BlockEnv): string[] | undefined {
    const d = this.drawn.get(block)?.find((x) => x.width === env.width)
    const imageRows = imageRowsOf(env)
    if (
      !d ||
      block.live ||
      d.version !== block.version ||
      d.detail !== env.detail ||
      d.imageRows !== imageRows
    )
      return undefined
    return d.lines
  }

  private draw(block: Block, env: BlockEnv): Drawn {
    const width = env.width
    const list = this.drawn.get(block) ?? []
    const hit = list.find((d) => d.width === width)
    const imageRows = imageRowsOf(env)
    const fresh = block.live
      ? hit?.frame === this.frame
      : hit?.version === block.version && hit.detail === env.detail && hit.imageRows === imageRows
    if (hit && fresh) return hit
    const lines = block.lines(env)
    const d: Drawn = {
      width,
      version: block.version,
      detail: env.detail,
      imageRows,
      frame: this.frame,
      lines,
    }
    // The width now, and the one before (a resize back and forth).
    this.drawn.set(block, [d, ...list.filter((x) => x.width !== width)].slice(0, 2))
    return d
  }

  private drawRow(r: PaneRow, env: BlockEnv, alt?: string): string {
    const range = this.rangeIn(r.block, r.line)
    const marks = range && selectionMarks(env.theme)
    // A row selected to its end (and on, to the next) shows it with a marked cell after its
    // text, as terminals show a selected line break; so do blank rows in the selection.
    const end = (line: string) =>
      range?.to === Number.POSITIVE_INFINITY && visibleWidth(line) < env.width
        ? `${line}${marks!.on} ${marks!.off}`
        : line
    if (r.line < 0) return end("")
    const code = r.block === this.selected ? this.selectedCode?.frame : undefined
    const selected =
      r.block === this.selected &&
      (!code ||
        (r.line >= code.top && r.line <= (code.bottom ?? code.rows[code.rows.length - 1] ?? code.top)))
    let line = alt ?? this.lines(r.block, env)[r.line] ?? ""
    const found = this.matchIndex.get(r.block)?.get(r.line)
    if (range) line = end(markCells(line, range.from, range.to, marks!))
    else if (found && !selected) {
      const current = this.matches[this.current]
      line = highlight(
        line,
        found.map((m) => ({ col: m.col, len: m.len, current: current?.includes(m) ?? false })),
      )
    }
    return selected ? markGutter(line, env.theme) : line
  }

  /** Whether the block at `i` has a blank row before it: by the kinds of it and the block with rows before it. */
  private gapBefore(i: number, env: BlockEnv): boolean {
    for (let j = i - 1; j >= 0; j--) {
      const prev = this.blocks[j]!
      if (this.lines(prev, env).length) return gapBetween(prev.kind, this.blocks[i]!.kind)
    }
    return false
  }

  /** Rows the block at `i` takes: its gap row, if any, and its lines; none when it has no lines. */
  private rowsOf(i: number, env: BlockEnv): number {
    const n = this.lines(this.blocks[i]!, env).length
    return n ? n + (this.gapBefore(i, env) ? 1 : 0) : 0
  }

  /** Rows from block `i`, `offset` rows into it, down to at most `height` rows. */
  private fill(i: number, offset: number, height: number): PaneRow[] {
    const env = this.env!
    const out: PaneRow[] = []
    for (let k = i; k < this.blocks.length && out.length < height; k++) {
      const block = this.blocks[k]!
      const lines = this.lines(block, env)
      if (!lines.length) continue
      const rows: PaneRow[] = this.gapBefore(k, env) ? [{ block, line: -1 }] : []
      for (let l = 0; l < lines.length; l++) rows.push({ block, line: l })
      out.push(...(k === i ? rows.slice(offset) : rows))
    }
    return out.slice(0, height)
  }

  /** The last `height` rows, and where they start. */
  private fillTail(height: number): PaneRow[] {
    const env = this.env!
    const chunks: PaneRow[][] = []
    let count = 0
    for (let k = this.blocks.length - 1; k >= 0 && count < height; k--) {
      const block = this.blocks[k]!
      const lines = this.lines(block, env)
      if (!lines.length) continue
      const rows: PaneRow[] = this.gapBefore(k, env) ? [{ block, line: -1 }] : []
      for (let l = 0; l < lines.length; l++) rows.push({ block, line: l })
      chunks.push(rows)
      count += rows.length
    }
    const all = chunks.reverse().flat()
    const cut = Math.max(0, all.length - height)
    const shown = all.slice(cut)
    const first = shown[0]
    if (first) {
      const offset = all.slice(0, cut).filter((r) => r.block === first.block).length
      this.top = { block: first.block, offset }
    } else this.top = undefined
    return shown
  }

  /**
   * Makes `offset` rows into block `i` the top row, moving across blocks for offsets outside
   * it. Past the start it stops at the top; when the rest no longer fills the view, it
   * follows the end again.
   */
  private moveTo(i: number, offset: number): void {
    const env = this.env!
    let k = i
    let off = offset
    while (off < 0) {
      let j = k - 1
      while (j >= 0 && !this.rowsOf(j, env)) j--
      if (j < 0) {
        off = 0
        break
      }
      k = j
      off += this.rowsOf(j, env)
    }
    for (;;) {
      const h = this.rowsOf(k, env)
      if (off < h) break
      off -= h
      if (++k >= this.blocks.length) {
        this.follow()
        return
      }
    }
    this.anchor = { block: this.blocks[k]!, offset: off }
    // The rest from here fits: that is the end, which is followed.
    let below = -off
    for (let j = k; j < this.blocks.length && below <= this.height; j++) below += this.rowsOf(j, env)
    if (below <= this.height) this.follow()
  }

  private reindex(from: number): void {
    for (let i = from; i < this.blocks.length; i++) this.blocks[i]!.index = i
  }
}

/** The matches of `q` in a block's rows `plain`, as `runFind` finds them. */
function findIn(block: Block, plain: readonly string[], q: string, exact: boolean): Match[][] {
  let text = ""
  /** The line and column of each character of `text`; -1 for what joins lines. */
  const lineOf: number[] = []
  const colOf: number[] = []
  for (let line = 0; line < plain.length; line++) {
    const raw = plain[line]!
    const start = raw.length - raw.trimStart().length
    const body = raw.slice(start).trimEnd()
    // Text wraps after a wide (CJK) character without dropping a space: those rows join as is.
    const joint = !text ? "" : !body ? "\n" : endsWide(text) ? "" : " "
    if (joint) {
      text += joint
      lineOf.push(-1)
      colOf.push(-1)
    }
    for (let k = 0; k < body.length; k++) {
      lineOf.push(line)
      colOf.push(start + k)
    }
    text += body
  }
  const lower = exact ? text : text.toLowerCase()
  const hay = lower.length === text.length ? lower : text
  const out: Match[][] = []
  let at = hay.indexOf(q)
  while (at !== -1) {
    const match: Match[] = []
    for (let k = at; k < at + q.length; k++) {
      const line = lineOf[k]!
      if (line < 0) continue
      const last = match[match.length - 1]
      if (last?.line === line) last.len = colOf[k]! + 1 - last.col
      else match.push({ block, line, col: colOf[k]!, len: 1 })
    }
    if (match.length) out.push(match)
    at = hay.indexOf(q, at + Math.max(1, q.length))
  }
  return out
}

/** Whether `text` ends with a wide (two-cell) character, after which text wraps without a space. */
function endsWide(text: string): boolean {
  const last = Array.from(text.slice(-2)).pop()
  return last !== undefined && visibleWidth(last) === 2
}

/** `line` with the selected block's mark in its first column (see SELECTED). */
export function markGutter(line: string, theme: Theme): string {
  const cells = cellsOf(line)
  const first = cells.findIndex((c) => !c.escape)
  if (first === -1) return `${line}${theme.accent(SELECTED)}`
  if (cells[first]!.text !== " ") return markCells(line, 0, 1, { on: MARK_ON, off: "\x1b[27m" })
  const text = (cs: typeof cells) => cs.map((c) => c.text).join("")
  return `${text(cells.slice(0, first))}${theme.accent(SELECTED)}${text(cells.slice(first + 1))}`
}

const MARK_ON = "\x1b[7m"
const CURRENT_ON = "\x1b[7;4m"
const MARK_OFF = "\x1b[27;24m"

/**
 * `line` with the given ranges of its plain text in inverse video (the current match also
 * underlined). Escape sequences are kept; one inside a range (a color change, a reset) is
 * followed by the mark again, so the range stays marked to its end.
 */
export function highlight(line: string, ranges: { col: number; len: number; current: boolean }[]): string {
  let out = ""
  let plain = 0
  let open: { end: number; on: string } | undefined
  const sorted = [...ranges].sort((a, b) => a.col - b.col)
  let next = 0
  for (let i = 0; i < line.length; ) {
    if (open && plain >= open.end) {
      out += MARK_OFF
      open = undefined
    }
    ESCAPE.lastIndex = i
    const esc = ESCAPE.exec(line)
    if (esc) {
      out += esc[0]
      if (open) out += open.on
      i += esc[0].length
      continue
    }
    while (!open && next < sorted.length && sorted[next]!.col + sorted[next]!.len <= plain) next++
    const r = sorted[next]
    if (!open && r && r.col <= plain) {
      open = { end: r.col + r.len, on: r.current ? CURRENT_ON : MARK_ON }
      out += open.on
      next++
    }
    out += line[i]
    plain++
    i++
  }
  if (open) out += MARK_OFF
  return out
}

/** A one-line bar under the transcript, fitted to `width`. */
export function barLine(text: string, width: number): string {
  return truncateToWidth(text, width, "…")
}
