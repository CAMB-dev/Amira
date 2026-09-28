import { cursor, erase, syncOutput } from "./ansi.ts"
import { type Component, CURSOR_MARKER, type RenderContext } from "./component.ts"
import { defaultTheme, isColorEnabled, stripColors, type Theme } from "./style.ts"
import type { Terminal } from "./terminal.ts"
import { closeStyles, sanitize, truncateToWidth, visibleWidth } from "./width.ts"

export interface RendererOptions {
  /** Wrap frames in synchronized-output sequences (mode 2026). */
  synchronizedOutput?: boolean
  /** Minimum time between frames scheduled with `requestRender()`. */
  frameIntervalMs?: number
  /** Handed to components in the render context. Defaults to `defaultTheme`. */
  theme?: Theme
  /** Whether colors reach the terminal. Defaults to `isColorEnabled()`, which follows NO_COLOR. */
  color?: boolean
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
  /**
   * The context handed to components; change it and render again to switch theme or colors.
   * `rows` is kept in step with the terminal on every frame.
   */
  context: RenderContext
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
  private suspended = false
  private suspendedWidth = 0
  /** Lines committed while suspended, printed in order on `resume()`. */
  private held: string[] = []

  constructor(
    private terminal: Terminal,
    private root: Component,
    opts: RendererOptions = {},
  ) {
    this.synchronizedOutput = opts.synchronizedOutput ?? false
    this.frameIntervalMs = opts.frameIntervalMs ?? 16
    this.context = {
      theme: opts.theme ?? defaultTheme,
      color: opts.color ?? isColorEnabled(),
      rows: terminal.rows,
    }
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
    if (this.stopped || this.suspended || this.timer) return
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

  get isSuspended(): boolean {
    return this.suspended
  }

  /**
   * Stops drawing while something else has the screen, such as a full-screen view on the
   * alternate screen. Committed lines are held back meanwhile, and nothing is written.
   */
  suspend(): void {
    if (this.stopped || this.suspended) return
    this.suspended = true
    this.suspendedWidth = this.terminal.columns
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * Draws again after `suspend()`, once the screen is back as it was (the alternate screen
   * restores the main one and its cursor): the live region is redrawn in full, below the
   * lines committed meanwhile, in the order they came. A terminal resized in between is
   * handled like any resize.
   */
  resume(): void {
    if (!this.suspended) return
    this.suspended = false
    this.forceFull = true
    if (this.terminal.columns !== this.suspendedWidth) {
      // The main screen may have been re-wrapped while hidden, but the cursor it saved was
      // not moved with it (xterm.js), so where the live region starts is not known. Draw
      // from the cursor instead of moving up: an old copy may stay above, but nothing is
      // drawn over the scrollback.
      this.prev = undefined
      this.row = 0
    }
    const held = this.held
    this.held = []
    this.draw(held)
  }

  /**
   * Leaves the cursor below the live region (or clears it) and shows it. Until `start()` is
   * called again, rendering and committing do nothing. A suspended renderer resumes first,
   * so lines it held back are not lost; leave any full-screen view before.
   */
  stop(opts: { clear?: boolean } = {}): void {
    if (this.stopped) return
    this.resume()
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
    if (this.suspended) {
      for (const line of committed) this.held.push(line)
      return
    }
    clearTimeout(this.timer)
    this.timer = undefined
    this.lastFrameAt = performance.now()
    const width = this.terminal.columns
    const frame = this.layout(width, this.terminal.rows, committed)
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

  /** Renders the root. Lines components commit while rendering are added to `committed`. */
  private layout(width: number, height: number, committed: string[]): Frame {
    this.context.rows = height
    let open = true
    const commit = (lines: string[]) => {
      // A component that kept the context cannot commit outside the frame it was given for.
      if (!open) return
      for (const l of lines) for (const part of sanitize(l).split("\n")) committed.push(part)
    }
    let lines: string[]
    try {
      lines = this.root.render(width, { ...this.context, commit })
    } finally {
      open = false
    }
    let pos: Frame["cursor"]
    let found = false
    lines = lines.map((line, row) => {
      const at = line.indexOf(CURSOR_MARKER)
      if (at === -1) return this.finish(truncateToWidth(line, width))
      if (!found) {
        found = true
        // A caret past the last visible cell has nowhere to go; hide the cursor instead.
        const col = visibleWidth(line.slice(0, at))
        if (col < width) pos = { row, col }
      }
      return this.finish(truncateToWidth(line.replaceAll(CURSOR_MARKER, ""), width))
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
    for (const line of committed) out += `${this.finish(line)}\r\n`
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

  /** Closes what a line opened, and strips its colors when they are off. */
  private finish(line: string): string {
    return closeStyles(this.context.color ? line : stripColors(line))
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

function sameCursor(a: Frame["cursor"], b: Frame["cursor"]): boolean {
  return a?.row === b?.row && a?.col === b?.col
}
