import { cursor, erase, syncOutput } from "./ansi.ts"
import { type Component, CURSOR_MARKER } from "./component.ts"
import type { Terminal } from "./terminal.ts"
import { closeStyles, sanitize, truncateToWidth, visibleWidth } from "./width.ts"

export interface RendererOptions {
  /** Wrap frames in synchronized-output sequences (mode 2026). */
  synchronizedOutput?: boolean
  /** Minimum time between frames scheduled with `requestRender()`. */
  frameIntervalMs?: number
}

interface Frame {
  lines: string[]
  cursor: { row: number; col: number } | undefined
}

/**
 * Draws a component as the live region at the bottom of an inline terminal UI. Lines committed
 * with `commit()` are printed above it once and left to scroll into the scrollback. The live
 * region is redrawn differentially: every frame is one write, with the cursor hidden while drawing.
 */
export class LiveRenderer {
  synchronizedOutput: boolean
  private frameIntervalMs: number
  private prev: Frame | undefined
  /** Row and column of the terminal cursor, relative to the top of the live region. */
  private row = 0
  private col = 0
  private width = 0
  private forceFull = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastFrameAt = 0
  private offResize: (() => void) | undefined
  private stopped = false

  constructor(
    private terminal: Terminal,
    private root: Component,
    opts: RendererOptions = {},
  ) {
    this.synchronizedOutput = opts.synchronizedOutput ?? false
    this.frameIntervalMs = opts.frameIntervalMs ?? 16
  }

  start(): void {
    this.stopped = false
    this.offResize ??= this.terminal.onResize(() => {
      this.forceFull = true
      this.requestRender()
    })
    this.render()
  }

  /** Schedules a frame, coalescing calls to at most one per frame interval. */
  requestRender(): void {
    if (this.stopped || this.timer) return
    const wait = Math.max(0, this.lastFrameAt + this.frameIntervalMs - performance.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.render()
    }, wait)
  }

  /** Draws a frame now. */
  render(): void {
    this.draw([])
  }

  /** Prints lines permanently above the live region, then redraws the live region below them. */
  commit(lines: string[]): void {
    this.draw(lines.flatMap((l) => sanitize(l).split("\n")))
  }

  /**
   * Leaves the cursor below the live region (or clears it) and shows it. Until `start()` is
   * called again, rendering and committing do nothing.
   */
  stop(opts: { clear?: boolean } = {}): void {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.offResize?.()
    this.offResize = undefined
    if (!this.prev) return
    const last = Math.max(0, this.prev.lines.length - 1)
    const out = opts.clear
      ? this.toTop() + erase.toScreenEnd
      : this.moveTo(last) + (this.prev.lines.length > 0 ? "\r\n" : "")
    this.terminal.write(out + cursor.show)
    this.prev = undefined
    this.row = 0
  }

  private draw(committed: string[]): void {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.lastFrameAt = performance.now()
    const width = this.terminal.columns
    const frame = this.layout(width, this.terminal.rows)
    const full = !this.prev || committed.length > 0 || this.forceFull || width !== this.width
    let body = full ? this.fullBody(frame, committed, width) : this.diffBody(frame)
    if (body === undefined) {
      if (sameCursor(frame.cursor, this.prev?.cursor)) return
      body = ""
    }
    body += this.placeCursor(frame)
    const out = cursor.hide + body + (frame.cursor ? cursor.show : "")
    this.terminal.write(this.synchronizedOutput ? syncOutput.begin + out + syncOutput.end : out)
    this.prev = frame
    this.width = width
    this.forceFull = false
  }

  private layout(width: number, height: number): Frame {
    let lines = this.root.render(width)
    let pos: Frame["cursor"]
    let found = false
    lines = lines.map((line, row) => {
      const at = line.indexOf(CURSOR_MARKER)
      if (at === -1) return fit(line, width)
      if (!found) {
        found = true
        // A caret past the last visible cell has nowhere to go; hide the cursor instead.
        const col = visibleWidth(line.slice(0, at))
        if (col < width) pos = { row, col }
      }
      return fit(line.replaceAll(CURSOR_MARKER, ""), width)
    })
    // Rows that scrolled off the top cannot be redrawn, so never draw more than fits.
    if (lines.length > height) {
      const cut = lines.length - height
      lines = lines.slice(cut)
      pos = pos && pos.row >= cut ? { row: pos.row - cut, col: pos.col } : undefined
    }
    return { lines, cursor: pos }
  }

  private fullBody(frame: Frame, committed: string[], width: number): string {
    let out = this.prev ? this.toTop(width) : "\r"
    out += erase.toScreenEnd
    for (const line of committed) out += `${closeStyles(line)}\r\n`
    out += frame.lines.join("\r\n")
    this.row = Math.max(0, frame.lines.length - 1)
    return out
  }

  private diffBody(frame: Frame): string | undefined {
    const prev = this.prev!.lines
    const next = frame.lines
    let out = ""
    for (let i = 0; i < next.length; i++) {
      if (prev[i] === next[i]) continue
      out += `${this.moveTo(i)}\r${erase.line}${next[i]}`
    }
    if (next.length < prev.length) {
      // Clear the rows the live region no longer uses.
      out += `${this.moveTo(next.length)}\r${erase.toScreenEnd}`
    }
    return out === "" ? undefined : out
  }

  private placeCursor(frame: Frame): string {
    if (frame.cursor) {
      const { row, col } = frame.cursor
      this.col = col
      return this.moveTo(row) + cursor.column(col)
    }
    // Without a caret, park at the start of the last row so the column is always known.
    this.col = 0
    return `${this.moveTo(Math.max(0, frame.lines.length - 1))}\r`
  }

  /** Moves between rows of the live region. Moving down uses newlines so missing rows get created. */
  private moveTo(target: number): string {
    const from = this.row
    this.row = target
    if (target < from) return cursor.up(from - target)
    if (target > from) return "\r\n".repeat(target - from)
    return ""
  }

  /**
   * Moves to the top-left of the live region. When the terminal got narrower it may have
   * re-wrapped our lines, so count the rows they take up at the new width.
   */
  private toTop(width = this.width): string {
    let up = this.row
    if (this.prev && width < this.width) {
      up = 0
      for (let i = 0; i < this.row; i++) up += rowsFor(visibleWidth(this.prev.lines[i] ?? ""), width)
      up += Math.floor(this.col / width)
    }
    this.row = 0
    return `\r${cursor.up(up)}`
  }
}

function rowsFor(cells: number, width: number): number {
  return Math.max(1, Math.ceil(cells / width))
}

function fit(line: string, width: number): string {
  return closeStyles(truncateToWidth(line, width))
}

function sameCursor(a: Frame["cursor"], b: Frame["cursor"]): boolean {
  return a?.row === b?.row && a?.col === b?.col
}
