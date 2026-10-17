import { cursor, erase, syncOutput } from "./ansi.ts"
import { type Component, CURSOR_MARKER, type RenderContext } from "./component.ts"
import type { Glyphs } from "./glyphs.ts"
import { findImageMarker, imageState, onImageSettled, placeImage, releaseImage } from "./images/placement.ts"
import { type Commit, fitScreen, type Line, lineRows, RendererHistory, rowsFor } from "./renderer-history.ts"
import { defaultTheme, isColorEnabled, stripColors, type Theme } from "./style.ts"
import type { Terminal } from "./terminal.ts"
import { closeStyles, presentEmoji, sanitize, truncateToWidth, visibleWidth } from "./width.ts"

export interface RendererOptions {
  /** Wrap frames in synchronized-output sequences (mode 2026). */
  synchronizedOutput?: boolean
  /** Minimum time between frames scheduled with `requestRender()`. */
  frameIntervalMs?: number
  /** Handed to components in the render context. Defaults to `defaultTheme`. */
  theme?: Theme
  glyphs?: Glyphs
  /** Whether colors reach the terminal. Defaults to `isColorEnabled()`, which follows NO_COLOR. */
  color?: boolean
  /**
   * Whether the terminal re-wraps its lines when it gets narrower (default true). Off, moving
   * back to the top of the live region after a resize counts rows as they were drawn.
   */
  reflow?: boolean
  /** Committed lines kept for `redraw()` to print again (default 1000). */
  historyLines?: number
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
  /** Absolute origin established by redraw; subsequent commits/growth account for terminal scrolling. */
  private top = 0
  private width = 0
  private forceFull = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastFrameAt = 0
  private offResize: (() => void) | undefined
  private stopped = false
  /** See `RendererOptions.reflow`. */
  reflow: boolean
  /** Committed blocks and their semantic identities, oldest first; see `redraw()`. */
  private history: RendererHistory
  /** The next frame clears the screen and prints recent history first. */
  private clearScreen = false
  private suspended = false
  /** Lines committed while suspended, printed in order on `resume()`. */
  private held: Commit<string>[] = []
  /**
   * Committed lines held back behind an image still loading (the first of them), in order.
   * Meanwhile they are drawn at the top of the live region, the image as its fallback.
   */
  private waiting: Commit<string>[] = []
  private offWait: (() => void) | undefined
  private waitTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private terminal: Terminal,
    private root: Component,
    opts: RendererOptions = {},
  ) {
    this.synchronizedOutput = opts.synchronizedOutput ?? false
    this.frameIntervalMs = opts.frameIntervalMs ?? 16
    this.reflow = opts.reflow ?? true
    this.history = new RendererHistory(Math.max(0, opts.historyLines ?? 1000))
    this.context = {
      theme: opts.theme ?? defaultTheme,
      glyphs: opts.glyphs,
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

  /** Prints above the live region; optional semantic rows repaint on redraw while retained in history. */
  commit(lines: string[], redraw?: (width: number, ctx: RenderContext) => string[]): void {
    this.draw([this.prepareCommit(lines, redraw)])
  }

  private prepareCommit(
    lines: string[],
    redraw?: (width: number, ctx: RenderContext) => string[],
  ): Commit<string> {
    const safe = lines.flatMap(safeLines)
    const semantic =
      redraw && this.history.limit && !this.stopped
        ? { redraw, remaining: safe.length, remembered: false, truncated: false }
        : undefined
    return { lines: safe, semantic }
  }

  get isSuspended(): boolean {
    return this.suspended
  }

  /** Screen row of the live frame, for pointer coordinates after establishing the origin with redraw(). */
  get screenTop(): number {
    return this.top
  }

  get liveRows(): number {
    return this.prev?.lines.length ?? 0
  }

  /**
   * Stops drawing while something else has the screen, such as a full-screen view on the
   * alternate screen. The live region is cleared first, leaving the cursor where it started,
   * so the main screen holds only committed lines while hidden. Committed lines are held
   * back meanwhile, and nothing more is written.
   */
  suspend(): void {
    if (this.stopped || this.suspended) return
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.prev) {
      const out = this.toTop(this.terminal.columns) + erase.toScreenEnd
      this.terminal.write(this.synchronizedOutput ? syncOutput.begin + out + syncOutput.end : out)
    }
    this.prev = undefined
    this.row = 0
    this.suspended = true
  }

  /**
   * Draws again after `suspend()`, once the screen is back as it was (the alternate screen
   * restores the main one and its cursor): the live region is drawn from the cursor, below
   * the lines committed meanwhile, in the order they came. Nothing of the old live region is
   * left to replace, so a terminal resized in between (which may have re-wrapped the main
   * screen, or not moved the cursor it saved along with it) leaves no stale copy behind.
   */
  resume(redraw = false): void {
    if (!this.suspended) return
    this.suspended = false
    this.forceFull = true
    this.clearScreen ||= redraw
    const held = this.held
    this.held = []
    this.draw(held)
  }

  /**
   * Clears the screen and draws it again: the most recent committed blocks that fit, then the
   * live region. For a screen that something else wrote over, or one a resize left in pieces.
   * The scrollback is left alone, so what was printed before stays there too. Does nothing
   * while suspended: the screen that comes back on `resume()` is the one left behind.
   */
  redraw(): void {
    if (this.stopped || this.suspended) return
    this.clearScreen = true
    this.draw([])
  }

  /**
   * Leaves the cursor below the live region (or clears it) and shows it. Until `start()` is
   * called again, rendering and committing do nothing. A suspended renderer resumes first,
   * so lines it held back are not lost; leave any full-screen view before.
   */
  stop(opts: { clear?: boolean } = {}): void {
    if (this.stopped) return
    this.resume()
    // Lines waiting for an image go out now, the image as its fallback if it is not there yet.
    if (this.waiting.length) this.draw([], true)
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.unwatch()
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

  private draw(incoming: Commit<string>[], release = false): void {
    if (this.stopped) {
      dropImages(incoming.flatMap((block) => block.lines))
      return
    }
    if (this.suspended) {
      this.held.push(...incoming)
      return
    }
    clearTimeout(this.timer)
    this.timer = undefined
    this.lastFrameAt = performance.now()
    const width = this.terminal.columns
    const height = this.terminal.rows
    const frame = this.layout(width, height, incoming)
    const settled = this.settle(incoming, frame, width, height, release)
    const committed = settled.flatMap((block) => block.lines)
    const full =
      !this.prev || committed.length > 0 || this.forceFull || this.clearScreen || width !== this.width
    let body = this.clearScreen
      ? this.clearBody(frame, committed, width)
      : full
        ? this.fullBody(frame, committed, width)
        : this.diffBody(frame)
    this.history.remember(settled)
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
  private layout(width: number, height: number, committed: Commit<string>[]): Frame {
    this.context.rows = height
    let open = true
    const commit: NonNullable<RenderContext["commit"]> = (lines, redraw) => {
      // A component that kept the context cannot commit outside the frame it was given for.
      if (!open) {
        dropImages(lines)
        return
      }
      committed.push(this.prepareCommit(lines, redraw))
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

  /**
   * Of the lines waiting and those just committed, returns the ones that can go to the
   * scrollback now: all up to the first image still loading within its time. The rest wait,
   * drawn at the top of the frame. When they would not fit on the screen with it, or on
   * `release`, the image goes as its fallback instead of waiting; a ready image that no longer
   * fits the width does too.
   */
  private settle(
    incoming: Commit<string>[],
    frame: Frame,
    width: number,
    height: number,
    release: boolean,
  ): Commit<Line>[] {
    const blocks = this.waiting.length ? [...this.waiting, ...incoming] : incoming
    const out: Commit<Line>[] = []
    let i = 0
    let j = 0
    let force = release
    for (;;) {
      for (; i < blocks.length; i++, j = 0) {
        const block = blocks[i]!
        const lines: Line[] = []
        for (; j < block.lines.length; j++) {
          const line = block.lines[j]!
          const m = findImageMarker(line)
          if (!m) {
            // Unknown markers are dropped with the other escapes.
            lines.push(sanitize(line))
          } else {
            const state = imageState(m.id, performance.now(), force)
            if (state.kind === "wait") break
            releaseImage(m.id)
            force = release
            const fallback = fallbackRows(m.prefix, state.fallback)
            if (state.kind === "image")
              lines.push(...fitScreen({ prefix: m.prefix, block: state.block, fallback }, width, height))
            else if (state.kind === "rows") lines.push(...fallbackRows(m.prefix, state.rows))
            else lines.push(...fallback)
          }
          if (block.semantic) block.semantic.remaining--
        }
        if (lines.length || !block.lines.length) {
          const last = out.at(-1)
          if (last && last.semantic === block.semantic) last.lines.push(...lines)
          else out.push({ lines, semantic: block.semantic })
        }
        if (j < block.lines.length) break
      }
      const rest = blocks.slice(i)
      if (rest.length) rest[0] = { ...rest[0]!, lines: rest[0]!.lines.slice(j) }
      const shown = rest.flatMap((block) =>
        block.lines.flatMap((line) => {
          const m = findImageMarker(line)
          const rows = m ? fallbackRows(m.prefix, imageState(m.id).fallback) : [line]
          return rows.map((r) => this.finish(truncateToWidth(r, width)))
        }),
      )
      if (rest.length && shown.length + frame.lines.length > height) {
        force = true
        continue
      }
      this.waiting = rest
      if (shown.length) {
        frame.lines = [...shown, ...frame.lines]
        if (frame.cursor) frame.cursor = { row: frame.cursor.row + shown.length, col: frame.cursor.col }
      }
      this.watch()
      return out
    }
  }

  /** Draws again when the image the lines wait for settles or its time is up. */
  private watch(): void {
    this.unwatch()
    const m = this.waiting.length ? findImageMarker(this.waiting[0]!.lines[0]!) : undefined
    if (!m) return
    this.offWait = onImageSettled(m.id, () => this.requestRender())
    const state = imageState(m.id)
    if (state.kind === "wait")
      this.waitTimer = setTimeout(
        () => this.requestRender(),
        Math.max(0, state.deadline - performance.now()) + 1,
      )
  }

  private unwatch(): void {
    this.offWait?.()
    this.offWait = undefined
    clearTimeout(this.waitTimer)
    this.waitTimer = undefined
  }

  /** A committed line as printed: an image is drawn after the text before it. */
  private print(line: Line): string {
    if (typeof line === "string") return this.finish(line)
    return this.finish(line.prefix) + placeImage(line.block, visibleWidth(line.prefix))
  }

  private fullBody(frame: Frame, committed: Line[], width: number): string {
    const committedRows = committed.reduce((rows, line) => rows + lineRows(line, width), 0)
    this.top = Math.max(0, Math.min(this.top + committedRows, this.terminal.rows - frame.lines.length))
    let out = this.prev ? this.toTop(width) : "\r"
    out += erase.toScreenEnd
    for (const line of committed) out += `${this.print(line)}\r\n`
    out += frame.lines.join("\r\n")
    this.row = Math.max(0, frame.lines.length - 1)
    return out
  }

  /**
   * The screen from the top: the end of the history, as many rows as the live region and the
   * new lines leave, then the new lines and the frame.
   */
  private clearBody(frame: Frame, committed: Line[], width: number): string {
    this.clearScreen = false
    const rows = (lines: Line[]) => lines.reduce((n, l) => n + lineRows(l, width), 0)
    let room = this.terminal.rows - frame.lines.length - rows(committed)
    const shown: Line[][] = []
    for (let i = this.history.blocks.length - 1; i >= 0 && room > 0; i--) {
      // Only a complete, retained semantic commit can repaint its original boundary.
      const saved = this.history.blocks[i]!
      const semantic = saved.semantic
      const block = (
        semantic?.remembered && !semantic.truncated
          ? semantic.redraw(width, this.context).flatMap(safeLines).map(sanitize)
          : saved.lines
      ).flatMap((l) => fitScreen(l, width, this.terminal.rows))
      const need = rows(block)
      if (need <= room) {
        shown.unshift(block)
        room -= need
        continue
      }
      // The first block that does not fit fills what is left with its end.
      const tail: Line[] = []
      for (let j = block.length - 1; j >= 0; j--) {
        const n = lineRows(block[j]!, width)
        if (n > room) break
        tail.unshift(block[j]!)
        room -= n
      }
      shown.unshift(tail)
      break
    }
    // ED 0 from the top-left, not ED 2: Windows Terminal and conhost answer ED 2 by scrolling
    // the screen into the scrollback, which would keep a copy of it and the live region there.
    const above = [...shown.flat(), ...committed]
    this.top = Math.max(0, Math.min(rows(above), this.terminal.rows - frame.lines.length))
    let out = `${cursor.to(0)}${erase.toScreenEnd}`
    for (const line of above) out += `${this.print(line)}\r\n`
    out += frame.lines.join("\r\n")
    this.row = Math.max(0, frame.lines.length - 1)
    return out
  }

  private diffBody(frame: Frame): string | undefined {
    this.top = Math.max(0, Math.min(this.top, this.terminal.rows - frame.lines.length))
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

  /** Closes what a line opened, strips its colors when they are off, and asks for emoji as measured. */
  private finish(line: string): string {
    return presentEmoji(closeStyles(this.context.color ? line : stripColors(line)))
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
   * re-wrapped our lines, so count the rows they take up at the new width, unless it is known
   * not to re-wrap (`reflow` off).
   */
  private toTop(width = this.width): string {
    let up = this.row
    if (this.reflow && this.prev && width < this.width) {
      up = 0
      for (let i = 0; i < this.row; i++) up += rowsFor(visibleWidth(this.prev.lines[i] ?? ""), width)
      up += Math.floor(this.col / width)
    }
    this.row = 0
    return `\r${cursor.up(up)}`
  }
}

/** Forgets the images of lines that will never be printed, so their markers are not kept. */
function dropImages(lines: string[]): void {
  for (const line of lines) {
    const m = findImageMarker(line)
    if (m) releaseImage(m.id)
  }
}

/** Lines to commit, made safe to print: an image marker is kept as it is. */
function safeLines(line: string): string[] {
  const m = findImageMarker(line)
  if (m && !m.prefix.includes("\n")) return [sanitize(m.prefix) + line.slice(m.prefix.length)]
  return sanitize(line).split("\n")
}

/** An image's fallback rows after the text that was in front of it, later rows indented to match. */
function fallbackRows(prefix: string, fallback: string[]): string[] {
  if (!fallback.length) return [prefix]
  const indent = " ".repeat(visibleWidth(prefix))
  return fallback.map((row, i) => (i === 0 ? prefix : indent) + row)
}

function sameCursor(a: Frame["cursor"], b: Frame["cursor"]): boolean {
  return a?.row === b?.row && a?.col === b?.col
}
