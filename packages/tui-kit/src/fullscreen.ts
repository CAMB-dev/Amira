import { cursor, erase, modes, syncOutput } from "./ansi.ts"
import { type Component, CURSOR_MARKER, type RenderContext } from "./component.ts"
import { type ImagePlacement, ScreenImageLayer } from "./images/screen.ts"
import type { RendererOptions } from "./renderer.ts"
import { defaultTheme, isColorEnabled, stripColors } from "./style.ts"
import type { Terminal } from "./terminal.ts"
import { closeStyles, sanitize, truncateToWidth, visibleWidth } from "./width.ts"

/**
 * Draws a component over the whole terminal on the alternate screen, for views that own the
 * screen for a while (a transcript viewer, a dashboard). The component gets `ctx.rows` and
 * should return that many lines; fewer are padded with blank rows and more are cut at the
 * bottom. Rows are addressed absolutely, so nothing ever scrolls, and only rows that changed
 * are rewritten; a resize redraws everything. The cursor stays hidden, unless a line holds
 * `CURSOR_MARKER` (a focused text input): then the terminal cursor is shown there, which is
 * also where input methods (IME) put their composition window.
 *
 * Images are shown with `ctx.place` over blank rows of the frame: drawn after the text, only
 * when they appear, move or change (see `ScreenImageLayer`), and cleared from rows they leave.
 *
 * Leaving the alternate screen gives the main screen back exactly as it was, cursor
 * included, so an inline `LiveRenderer` can be suspended while this one is open and resumed
 * after it closes. Entering goes through `Terminal.enterAltScreen()`, so a crash while open
 * still restores the main screen.
 */
export class FullScreenRenderer {
  synchronizedOutput: boolean
  context: RenderContext
  private frameIntervalMs: number
  private prev: string[] | undefined
  private size = { columns: 0, rows: 0 }
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastFrameAt = 0
  private offResize: (() => void) | undefined
  private opened = false
  /** Where the cursor was shown by the last frame; undefined when hidden. */
  private cursorAt: { row: number; col: number } | undefined
  private images = new ScreenImageLayer()

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

  get isOpen(): boolean {
    return this.opened
  }

  /** Switches to the alternate screen and draws the first frame. */
  open(): void {
    if (this.opened) return
    this.opened = true
    this.prev = undefined
    this.cursorAt = undefined
    this.terminal.enterAltScreen()
    this.terminal.enableMode(modes.alternateScroll)
    this.offResize = this.terminal.onResize(() => {
      this.prev = undefined
      this.requestRender()
    })
    this.render()
  }

  /** Leaves the alternate screen; the main screen and its cursor come back as they were. */
  close(): void {
    if (!this.opened) return
    this.opened = false
    clearTimeout(this.timer)
    this.timer = undefined
    this.offResize?.()
    this.offResize = undefined
    this.prev = undefined
    const free = this.images.close()
    if (free) this.terminal.write(free)
    this.terminal.disableMode(modes.alternateScroll)
    // The alternate screen does not save whether the cursor was shown; it was before we hid it.
    this.terminal.write(cursor.show)
    this.terminal.exitAltScreen()
  }

  /** Schedules a frame, coalescing calls to at most one per frame interval. */
  requestRender(): void {
    if (!this.opened || this.timer) return
    const wait = Math.max(0, this.lastFrameAt + this.frameIntervalMs - performance.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.render()
    }, wait)
  }

  /** Clears the screen and draws every row again, for a screen something else wrote over. */
  redraw(): void {
    this.prev = undefined
    this.render()
  }

  /** Draws a frame now. */
  render(): void {
    if (!this.opened) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.lastFrameAt = performance.now()
    const { columns, rows } = this.terminal
    this.context.rows = rows
    const placed: ImagePlacement[] = []
    const drawn = this.root.render(columns, { ...this.context, place: (p) => placed.push(p) })
    const lines: string[] = []
    let at: { row: number; col: number } | undefined
    for (let i = 0; i < rows; i++) {
      const raw = sanitize(drawn[i] ?? "").split("\n")[0]!
      const marker = raw.indexOf(CURSOR_MARKER)
      if (marker !== -1 && !at) {
        // A caret past the last cell has nowhere to go; the cursor stays hidden then.
        const col = visibleWidth(raw.slice(0, marker))
        if (col < columns) at = { row: i, col }
      }
      lines.push(this.finish(truncateToWidth(raw.replaceAll(CURSOR_MARKER, ""), columns)))
    }
    const full = !this.prev || columns !== this.size.columns || rows !== this.size.rows
    const prev = this.prev
    const images = this.images.frame(placed, {
      full,
      rows,
      columns,
      changed: (i) => !prev || prev[i] !== lines[i],
    })
    let body = (full ? erase.screen : "") + images.before
    for (let i = 0; i < rows; i++) {
      if (!full && prev![i] === lines[i] && !images.repaint.has(i)) continue
      body += `${cursor.to(i)}${erase.line}${lines[i]}`
    }
    body += images.after
    this.prev = lines
    this.size = { columns, rows }
    const moved = at?.row !== this.cursorAt?.row || at?.col !== this.cursorAt?.col
    if (!body && !moved) return
    this.cursorAt = at
    const out = cursor.hide + body + (at ? cursor.to(at.row, at.col) + cursor.show : "")
    this.terminal.write(this.synchronizedOutput ? syncOutput.begin + out + syncOutput.end : out)
  }

  private finish(line: string): string {
    return closeStyles(this.context.color ? line : stripColors(line))
  }
}
