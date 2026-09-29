import type { ToolDetailLevel } from "@amira/api"
import { type ImagePlacement, stripAnsi, truncateToWidth } from "@amira/tui-kit"
import { type Block, type BlockEnv, imagesIn, ReplyBlock } from "./blocks.ts"
import { gapBetween } from "./transcript.ts"

/** Lines of a block drawn at one width, for one version of it. */
interface Drawn {
  width: number
  version: number
  detail: ToolDetailLevel
  /** The most rows an image could take, and whether images were drawn at all. */
  imageRows: number
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

/** A match of the find bar: `len` characters at `col` of the plain text of a block's line. */
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

/** Marks the rows of the selected block, which is drawn one column narrower. */
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
  private matches: Match[] = []
  private matchIndex = new Map<Block, Map<number, Match[]>>()
  private current = -1
  private findQuery = ""
  private findWidth = 0

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
    if (this.selected === block) this.selected = undefined
    this.changed()
  }

  get last(): Block | undefined {
    return this.blocks[this.blocks.length - 1]
  }

  /** Notes a change to the conversation, shown as new output when scrolled up. */
  changed(): void {
    if (!this.following) this.unseen = true
  }

  /** A block's lines at the env's width (one column narrower while selected). */
  lines(block: Block, env: BlockEnv, selected = block === this.selected): string[] {
    return this.draw(block, env, selected).lines
  }

  /** A block's lines without styling, for finding text in them. */
  plain(block: Block, env: BlockEnv): string[] {
    const d = this.draw(block, env, false)
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
    if (this.findQuery && this.findWidth !== env.width) this.runFind()
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
      const selected = block === this.selected
      const images = imagesIn(this.draw(block, env, selected).lines)
      const first = layout[i]!.line
      const last = layout[j - 1]!.line
      for (const im of images ?? []) {
        const top = Math.max(im.line, first)
        const end = Math.min(im.line + im.image.rows, last + 1)
        if (end <= top) continue
        const from = top - im.line
        const to = end - im.line
        const at = i + (top - first)
        const col = im.col + (selected ? 1 : 0)
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
      } else lines = this.lines(b, env, false)
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

  /** Selects a block, or none, and scrolls it into view. */
  select(block: Block | undefined): void {
    this.selected = block
    if (block) this.reveal(block)
  }

  /** Selects the block before the selected one (the newest one when none is), skipping empty ones. */
  selectPrev(): void {
    if (!this.env) return
    const from = this.selected ? this.selected.index - 1 : this.blocks.length - 1
    for (let i = from; i >= 0; i--) {
      if (this.lines(this.blocks[i]!, this.env, false).length) {
        this.select(this.blocks[i])
        return
      }
    }
  }

  selectNext(): void {
    if (!this.env || !this.selected) return
    for (let i = this.selected.index + 1; i < this.blocks.length; i++) {
      if (this.lines(this.blocks[i]!, this.env, false).length) {
        this.select(this.blocks[i])
        return
      }
    }
  }

  /** The block shown at a row of the viewport (0 is its top), if any. */
  blockAt(row: number): PaneRow | undefined {
    return this.layout[row - this.padding]
  }

  /** Scrolls so `block` is in view: its top when it is above, its end when it is below. */
  reveal(block: Block): void {
    const env = this.env
    if (!env || block.index < 0) return
    const rows = this.layout.filter((r) => r.block === block)
    const lines = this.lines(block, env)
    const whole = rows.some((r) => r.line === 0) && rows.some((r) => r.line === lines.length - 1)
    if (whole) return
    const above = !this.layout.length || this.layout[0]!.block.index >= block.index
    const gap = this.gapBefore(block.index, env) ? 1 : 0
    this.following = false
    if (above || lines.length + gap >= this.height) this.moveTo(block.index, gap)
    else this.moveTo(block.index, gap + lines.length - this.height)
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
        (m) => m.block.index < bottom.block.index || (m.block === bottom.block && m.line <= bottom.line),
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

  private runFind(): void {
    const env = this.env
    this.matches = []
    this.matchIndex.clear()
    if (!env || !this.findQuery) return
    this.findWidth = env.width
    const exact = this.findQuery !== this.findQuery.toLowerCase()
    const q = exact ? this.findQuery : this.findQuery.toLowerCase()
    for (const block of this.blocks) {
      const plain = this.plain(block, env)
      for (let line = 0; line < plain.length; line++) {
        const text = exact ? plain[line]! : plain[line]!.toLowerCase()
        let at = text.indexOf(q)
        while (at !== -1) {
          const m = { block, line, col: at, len: q.length }
          this.matches.push(m)
          let byLine = this.matchIndex.get(block)
          if (!byLine) {
            byLine = new Map()
            this.matchIndex.set(block, byLine)
          }
          byLine.set(line, [...(byLine.get(line) ?? []), m])
          at = text.indexOf(q, at + Math.max(1, q.length))
        }
      }
    }
    if (this.current >= this.matches.length) this.current = this.matches.length - 1
  }

  private jump(i: number): void {
    const env = this.env
    const m = this.matches[i]
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
    const imageRows = env.images ? env.images.loader.maxRows() : 0
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

  private draw(block: Block, env: BlockEnv, selected: boolean): Drawn {
    const width = selected ? Math.max(1, env.width - 1) : env.width
    const list = this.drawn.get(block) ?? []
    const hit = list.find((d) => d.width === width)
    const imageRows = env.images ? env.images.loader.maxRows() : 0
    const fresh = block.live
      ? hit?.frame === this.frame
      : hit?.version === block.version && hit.detail === env.detail && hit.imageRows === imageRows
    if (hit && fresh) return hit
    const lines = block.lines(width === env.width ? env : { ...env, width })
    const d: Drawn = {
      width,
      version: block.version,
      detail: env.detail,
      imageRows,
      frame: this.frame,
      lines,
    }
    // One width, plus the narrower one while selected.
    this.drawn.set(block, [d, ...list.filter((x) => x.width !== width)].slice(0, 2))
    return d
  }

  private drawRow(r: PaneRow, env: BlockEnv, alt?: string): string {
    if (r.line < 0) return ""
    const selected = r.block === this.selected
    let line = alt ?? this.lines(r.block, env, selected)[r.line] ?? ""
    const found = this.matchIndex.get(r.block)?.get(r.line)
    if (found && !selected) {
      const current = this.matches[this.current]
      line = highlight(
        line,
        found.map((m) => ({ col: m.col, len: m.len, current: m === current })),
      )
    }
    return selected ? `${env.theme.accent(SELECTED)}${line}` : line
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

const ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]/y

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

/** The newest reply in the transcript, if any. */
export function lastReply(pane: TranscriptPane): ReplyBlock | undefined {
  for (let i = pane.blocks.length - 1; i >= 0; i--) {
    const b = pane.blocks[i]
    if (b instanceof ReplyBlock && b.source.trim()) return b
  }
  return undefined
}

/** A one-line bar under the transcript, fitted to `width`. */
export function barLine(text: string, width: number): string {
  return truncateToWidth(text, width, "…")
}
