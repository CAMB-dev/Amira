import type { ToolDetailLevel } from "@amira/api"
import { type ImagePlacement, stripAnsi, type Theme, truncateToWidth } from "@amira/tui-kit"
import { setImageFallback } from "./blocks/base.ts"
import { type Block, type BlockEnv, type CodeFrame, codeFrames, imagesIn, ReplyBlock } from "./blocks.ts"
import { glyphs } from "./glyphs.ts"
import { PaneFind } from "./pane/find.ts"
import { PaneTextSelection } from "./pane/text-selection.ts"
import { cellsOf, markCells, sliceCells } from "./text-selection.ts"
import { gapBetween } from "./transcript.ts"

export { highlight } from "./pane/find.ts"

/** Lines of a block drawn at one width, for one version of it. */
interface Drawn {
  width: number
  theme: Theme
  glyphs: BlockEnv["glyphs"]
  version: number
  detail: ToolDetailLevel
  /** The most rows an image could take (0 without images), and the renderers of extensions. */
  imageRows: string
  /** The frame it was drawn in, for live blocks, which are drawn once per frame. */
  frame: number
  lines: string[]
  plain?: string[]
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

/** What decides how blocks lay out besides the width: image rows, and the renderers of extensions. */
const imageRowsOf = (env: BlockEnv) =>
  `${env.images ? env.images.store.maxRows() : 0}:${env.renders?.renders.generation ?? -1}`

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
  private readonly textSelection = new PaneTextSelection({
    blocks: this.blocks,
    env: () => this.env,
    layout: () => this.layout,
    padding: () => this.padding,
    lines: (block, env) => this.lines(block, env),
    plain: (block, env) => this.plain(block, env),
    gapBefore: (index, env) => this.gapBefore(index, env),
    imageRowsOf,
    clearSelectedBlock: () => {
      this.selected = undefined
    },
  })
  private readonly finder = new PaneFind({
    blocks: this.blocks,
    env: () => this.env,
    layout: () => this.layout,
    following: () => this.following,
    height: () => this.height,
    plain: (block, env) => this.plain(block, env),
    drawing: (block, env) => this.draw(block, env),
    gapBefore: (index, env) => this.gapBefore(index, env),
    moveTo: (index, offset) => {
      this.following = false
      this.moveTo(index, offset)
    },
  })

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

  /** Theme and glyph changes invalidate all widths, while retaining scroll and selection. */
  invalidate(): void {
    this.drawn = new WeakMap()
    this.finder.invalidate()
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
    this.finder.refresh(env)
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
    this.textSelection.update(env)
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
        if (from === 0 && to === im.image.rows ? false : !im.image.croppable) {
          // Drawn whole only: said where to find it, when the view is tall enough to show it.
          const note = im.image.rows <= this.height ? env.theme.muted(" (scroll to view)") : ""
          setImageFallback(alt, at, im, to - from, env.width, note)
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
        if (!im.image.broken) im.image.whenReady(im.changed ?? env.images.changed)
        setImageFallback(alt, at, im, to - from, env.width)
      }
      i = j
    }
    return alt
  }

  /**
   * Every block at `width`, spaced like the inline transcript: what exiting prints. Blocks
   * folded by hand print as the inline transcript shows them, except thinking keeps its chosen
   * fold. Images print as their alt text: the normal screen is text.
   */
  printout(env: BlockEnv): string[] {
    const out: string[] = []
    let prev: Block | undefined
    const { images: _, ...text } = env
    for (const b of this.blocks) {
      let lines: string[]
      if (b.refolded && b.kind !== "reasoning") lines = b.printLines(text)
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
    return codeFrames(this.plain(block, this.env), this.env.glyphs, glyphs.assistant)
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
    return this.textSelection.hasText
  }

  /** Whether the mouse is selecting text. */
  get dragging(): boolean {
    return this.textSelection.dragging
  }

  /**
   * The cell at a row and column of the viewport in the last frame. Above its rows (the padding
   * over short content) is the start of the first one, below them the end of the last.
   */
  pointAt(row: number, col: number): TextPoint | undefined {
    return this.textSelection.pointAt(row, col)
  }

  /** Selects the text from `anchor` to `focus`, both cells included; the selected block goes. */
  selectText(anchor: TextPoint, focus: TextPoint): void {
    this.textSelection.selectText(anchor, focus)
  }

  clearText(): void {
    this.textSelection.clearText()
  }

  /** Starts selecting text at a cell of the viewport; nothing is selected until the mouse leaves it. */
  startDrag(row: number, col: number): void {
    this.textSelection.startDrag(row, col)
  }

  /** The mouse moved to a cell of the viewport while selecting. */
  dragTo(row: number, col: number): void {
    this.textSelection.dragTo(row, col)
  }

  /** The mouse was released: the selection stays, if the mouse moved. */
  endDrag(): void {
    this.textSelection.endDrag()
  }

  /** Selects the word at a cell of the viewport. False when there is none (a blank row). */
  selectWord(row: number, col: number): boolean {
    return this.textSelection.selectWord(row, col)
  }

  /** Selects the line at a row of the viewport, with the rows it wraps over. False on a blank row. */
  selectLine(row: number, col: number): boolean {
    return this.textSelection.selectLine(row, col)
  }

  /**
   * The selected text as it copies: the rows as shown, less the transcript's chrome (gutters,
   * trees, code frames: see `Block.copyRows`), wrapped lines of code joined, images as their
   * alt text, a blank line where the transcript has one between blocks.
   */
  selectedText(): string {
    return this.textSelection.selectedText()
  }

  // --- find

  get findActive(): boolean {
    return this.finder.findActive
  }

  get matchCount(): number {
    return this.finder.matchCount
  }

  /** The current match, 1-based from the top, or 0. */
  get matchPosition(): number {
    return this.finder.matchPosition
  }

  /**
   * Finds `query` in the text of every block (ignoring case unless it has capitals) and
   * moves to the newest match at or above the bottom of the view.
   */
  find(query: string): void {
    this.finder.find(query)
  }

  /** Moves to the match before the current one (up), or after it (`step` 1, down), wrapping. */
  stepMatch(step: -1 | 1): void {
    this.finder.stepMatch(step)
  }

  clearFind(): void {
    this.finder.clearFind()
  }

  // --- drawing

  /** A block's lines at the env's width if they were drawn and are still current. */
  private cached(block: Block, env: BlockEnv): string[] | undefined {
    const d = this.drawn.get(block)?.find((x) => x.width === env.width)
    const imageRows = imageRowsOf(env)
    if (
      !d ||
      block.live ||
      d.theme !== env.theme ||
      d.glyphs !== env.glyphs ||
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
    if (hit && fresh && hit.theme === env.theme && hit.glyphs === env.glyphs) return hit
    const lines = block.lines(env)
    const d: Drawn = {
      width,
      theme: env.theme,
      glyphs: env.glyphs,
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
    const text = this.textSelection.row(r, env)
    if (r.line < 0) return text.end("")
    const code = r.block === this.selected ? this.selectedCode?.frame : undefined
    const selected =
      r.block === this.selected &&
      (!code ||
        (r.line >= code.top && r.line <= (code.bottom ?? code.rows[code.rows.length - 1] ?? code.top)))
    let line = alt ?? this.lines(r.block, env)[r.line] ?? ""
    if (text.mark) line = text.mark(line)
    else if (!selected) line = this.finder.highlightRow(r.block, r.line, line)
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

/** A one-line bar under the transcript, fitted to `width`. */
export function barLine(text: string, width: number): string {
  return truncateToWidth(text, width, "…")
}
