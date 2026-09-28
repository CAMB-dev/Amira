import { cursor, erase, modes, syncOutput } from "./ansi.ts"
import { type Component, CURSOR_MARKER, type RenderContext } from "./component.ts"
import type { RendererOptions } from "./renderer.ts"
import { defaultTheme, isColorEnabled, stripColors } from "./style.ts"
import type { Terminal } from "./terminal.ts"
import { closeStyles, sanitize, truncateToWidth } from "./width.ts"

/**
 * Draws a component over the whole terminal on the alternate screen, for views that own the
 * screen for a while (a transcript viewer, a dashboard). The component gets `ctx.rows` and
 * should return that many lines; fewer are padded with blank rows and more are cut at the
 * bottom. Rows are addressed absolutely, so nothing ever scrolls, and only rows that changed
 * are rewritten; a resize redraws everything. The cursor stays hidden.
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
    this.terminal.disableMode(modes.alternateScroll)
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

  /** Draws a frame now. */
  render(): void {
    if (!this.opened) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.lastFrameAt = performance.now()
    const { columns, rows } = this.terminal
    this.context.rows = rows
    const drawn = this.root.render(columns, { ...this.context })
    const lines: string[] = []
    for (let i = 0; i < rows; i++) {
      const line = sanitize(drawn[i] ?? "")
        .split("\n")[0]!
        .replaceAll(CURSOR_MARKER, "")
      lines.push(this.finish(truncateToWidth(line, columns)))
    }
    const full = !this.prev || columns !== this.size.columns || rows !== this.size.rows
    let body = full ? erase.screen : ""
    for (let i = 0; i < rows; i++) {
      if (!full && this.prev![i] === lines[i]) continue
      body += `${cursor.to(i)}${erase.line}${lines[i]}`
    }
    this.prev = lines
    this.size = { columns, rows }
    if (!body) return
    const out = cursor.hide + body
    this.terminal.write(this.synchronizedOutput ? syncOutput.begin + out + syncOutput.end : out)
  }

  private finish(line: string): string {
    return closeStyles(this.context.color ? line : stripColors(line))
  }
}
