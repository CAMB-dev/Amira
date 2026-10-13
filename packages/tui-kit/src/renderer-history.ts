import type { RenderContext } from "./component.ts"
import type { ImageBlock } from "./images/types.ts"
import { visibleWidth } from "./width.ts"

/** An image going to scrollback: its text prefix and fallback rows. */
interface ImageLine {
  prefix: string
  block: ImageBlock
  fallback: string[]
}

export type Line = string | ImageLine

/** Shared by every chunk of one semantic commit, including chunks waiting for an image. */
export interface SemanticCommit {
  redraw: (width: number, ctx: RenderContext) => string[]
  /** Input lines not yet settled into committed output. */
  remaining: number
  /** All settled chunks have reached history, rather than just the current frame. */
  remembered: boolean
  /** Losing any chunk prevents a redraw from resurrecting discarded rows. */
  truncated: boolean
}

export interface Commit<T> {
  lines: T[]
  semantic?: SemanticCommit
}

/** Retained commit boundaries, independent of their rendered text. */
export class RendererHistory {
  readonly blocks: Commit<Line>[] = []
  private count = 0

  constructor(readonly limit: number) {}

  remember(committed: Commit<Line>[]): void {
    if (!this.limit) return
    let skip = Math.max(0, committed.reduce((n, block) => n + block.lines.length, 0) - this.limit)
    for (const block of committed) {
      const cut = Math.min(skip, block.lines.length)
      skip -= cut
      if (cut && block.semantic) block.semantic.truncated = true
      if (cut && cut === block.lines.length) continue
      if (!block.lines.length && !block.semantic) continue
      const lines = block.lines.slice(cut)
      const last = this.blocks.at(-1)
      if (block.semantic && last?.semantic === block.semantic) last.lines.push(...lines)
      else this.blocks.push({ lines, semantic: block.semantic })
      this.count += weight(lines)
      if (block.semantic && !block.semantic.remaining) block.semantic.remembered = true
    }
    while (this.count > this.limit && this.blocks.length) {
      const block = this.blocks.shift()!
      if (block.semantic) block.semantic.truncated = true
      this.count -= weight(block.lines)
    }
    // Empty semantic commits occupy a boundary too, but must not grow history without bound.
    while (this.blocks.length > this.limit) {
      const block = this.blocks.shift()!
      if (block.semantic) block.semantic.truncated = true
      this.count -= weight(block.lines)
    }
  }
}

function weight(lines: Line[]): number {
  return lines.reduce(
    (n, line) =>
      n + (typeof line === "string" ? 1 : line.block.rows + Math.ceil(line.block.seq.length / 10_000)),
    0,
  )
}

export function rowsFor(cells: number, width: number): number {
  return Math.max(1, Math.ceil(cells / width))
}

/** The rows a committed line takes at `width`. */
export function lineRows(line: Line, width: number): number {
  return typeof line === "string" ? rowsFor(visibleWidth(line), width) : line.block.rows
}

/** An image, or its fallback when too wide or too tall to leave a row below it. */
export function fitScreen(line: Line, width: number, height: number): Line[] {
  if (typeof line === "string") return [line]
  if (visibleWidth(line.prefix) + line.block.cols <= width && line.block.rows < height) return [line]
  return line.fallback
}
