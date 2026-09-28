import { stripAnsi } from "../ansi.ts"
import { supportsHyperlinks } from "../capabilities.ts"
import type { Component, RenderContext } from "../component.ts"
import { defaultGlyphs, type Glyphs } from "../glyphs.ts"
import {
  type BlockState,
  cloneState,
  commitOpenBlocks,
  type Env,
  endOpenBlocks,
  finish,
  hasOpenBlock,
  type LineRender,
  newState,
  partialRender,
  renderLine,
  type Sink,
  step,
} from "../markdown/blocks.ts"
import { markdownStyles } from "../markdown/inline.ts"
import { defaultTheme } from "../style.ts"
import { TAB_WIDTH } from "../width.ts"

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
/** An escape sequence or `\r\n` that a chunk may end in the middle of. */
const UNFINISHED =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
  /(?:\x1b(?:\[[0-?]*[ -/]*|[\]P_^X][^\x07\x1b]*\x1b?|[ -/]*)?|\r)$/

export interface MarkdownStreamOptions {
  glyphs?: Glyphs
  /** Make links clickable with OSC 8. Defaults to what the terminal is known to support. */
  hyperlinks?: boolean
  /** Color keywords, strings and comments in code blocks of the languages it knows. */
  highlight?: boolean
}

/** The start of a partial line whose first rows were committed already. */
interface Cut {
  render: LineRender
  /** Delimiters of the spans open at the cut, parsed again in front of the rest. */
  carry: string
}

/**
 * Markdown that streams in, such as a model's reply, rendered block by block so that nothing
 * shown in the scrollback ever has to change.
 *
 * A block is committed to the scrollback as soon as it is complete: a paragraph line once the
 * next line shows it is not a heading's text or a table's header, a heading, list item or quote
 * line at its line break, a table when a line that is not a row follows, and each line of a code
 * block as soon as it ends. Only the block still being written is drawn in the live region,
 * re-rendered each frame, so the work per frame is bounded by that block and a width change
 * re-wraps only it. When it grows past `maxRows`, its rows that can no longer change are
 * committed too (like `StreamText`): a table then keeps the column widths it had.
 *
 * Source line breaks are kept. Committing needs the renderer's `ctx.commit`; without it every
 * row is returned. Escape sequences and control characters in the text are dropped.
 */
export class MarkdownStream implements Component {
  /** Rows the text may take in the live region; set by the parent before each render. */
  maxRows = Number.POSITIVE_INFINITY
  /** Rows committed to the scrollback since the text was last taken. */
  committedRows = 0
  private readonly glyphs: Glyphs
  private readonly hyperlinks: boolean
  private readonly highlight: boolean
  private state = newState()
  /** Text not processed yet: complete lines, then the partial line being written. */
  private src = ""
  /** Where the rest of the partial line starts, when its first rows were committed. */
  private cut: Cut | undefined
  /** Rows finished while no renderer could commit them. */
  private done: string[] = []
  /** The end of the last chunk when it may continue in the next: a split escape or `\r`. */
  private pending = ""
  private theme = defaultTheme

  constructor(opts: MarkdownStreamOptions = {}) {
    this.glyphs = opts.glyphs ?? defaultGlyphs
    this.hyperlinks = opts.hyperlinks ?? supportsHyperlinks()
    this.highlight = opts.highlight ?? true
  }

  /** Adds streamed text. */
  append(chunk: string): void {
    let s = this.pending + chunk
    this.pending = s.match(UNFINISHED)?.[0] ?? ""
    if (this.pending) s = s.slice(0, -this.pending.length)
    s = stripAnsi(s).replace(/\r\n?/g, "\n").replace(CONTROLS, "")
    if (!s.includes("\t")) {
      this.src += s
      return
    }
    for (const part of s.split(/(\t)/)) {
      if (part !== "\t") {
        this.src += part
        continue
      }
      // Measured from the text, not summed per chunk: a chunk may end inside a grapheme.
      const col = Bun.stringWidth(this.src.slice(this.src.lastIndexOf("\n") + 1))
      this.src += " ".repeat(TAB_WIDTH - (col % TAB_WIDTH))
    }
  }

  /** Whether nothing was added since the text was last taken. */
  isEmpty(): boolean {
    return this.src === "" && !this.state.emitted && this.done.length === 0
  }

  render(width: number, ctx: RenderContext): string[] {
    this.theme = ctx.theme
    const env = this.env(width)
    const sink: Sink = ctx.commit
      ? (rows) => {
          ctx.commit!(rows)
          this.committedRows += rows.length
        }
      : (rows) => this.done.push(...rows)
    this.processLines(env, sink)
    let live = this.live(env)
    if (ctx.commit && live.length > this.maxRows) {
      if (hasOpenBlock(this.state)) {
        commitOpenBlocks(this.state, env, sink)
        live = this.live(env)
      }
      if (live.length > this.maxRows && this.commitPartial(env, sink)) live = this.live(env)
    }
    return this.done.length ? [...this.done, ...live] : live
  }

  /**
   * Returns the rows not committed yet, rendered to `width` as the end of the text (an unclosed
   * code block is closed), without trailing blank rows, and starts over empty.
   */
  take(width: number): string[] {
    const env = this.env(width)
    const rows = this.done
    const sink: Sink = (r) => rows.push(...r)
    if (this.src !== "" && !this.src.endsWith("\n")) this.src += "\n"
    this.processLines(env, sink)
    finish(this.state, env, sink)
    while (rows.length > 0 && rows[rows.length - 1]!.trim() === "") rows.pop()
    this.state = newState()
    this.src = ""
    this.cut = undefined
    this.done = []
    this.pending = ""
    this.committedRows = 0
    return rows
  }

  private env(width: number): Env {
    return {
      width: Math.max(1, width),
      styles: markdownStyles(this.theme),
      glyphs: this.glyphs,
      hyperlinks: this.hyperlinks,
      highlight: this.highlight,
    }
  }

  /** Processes the complete lines, leaving the partial one. */
  private processLines(env: Env, sink: Sink) {
    let from = 0
    for (;;) {
      const nl = this.src.indexOf("\n", from)
      if (nl === -1) break
      const line = this.src.slice(from, nl)
      if (this.cut) {
        sink(renderLine(this.cut.render, line, env, this.cut.carry).rows)
        this.cut = undefined
      } else step(this.state, line, env, sink)
      from = nl + 1
    }
    if (from > 0) this.src = this.src.slice(from)
  }

  /** The rows of what is still open, as they would render if the text ended here. */
  private live(env: Env): string[] {
    const line = this.src
    if (this.cut) return line !== "" ? renderLine(this.cut.render, line, env, this.cut.carry).rows : []
    const rows: string[] = []
    const sink: Sink = (r) => rows.push(...r)
    const s = cloneState(this.state)
    if (line !== "") step(s, line, env, sink)
    endOpenBlocks(s, env, sink)
    return rows
  }

  /**
   * Commits the rows of the partial line that can no longer change, keeping the last; returns
   * whether it did. Spans open at the cut are carried over, so the rest renders as it would have.
   */
  private commitPartial(env: Env, sink: Sink): boolean {
    const line = this.src
    let render: LineRender
    let state: BlockState | undefined
    let carry: string | undefined
    if (this.cut) {
      render = this.cut.render
      carry = this.cut.carry
    } else {
      const p = partialRender(this.state, line, env)
      if (!p) return false
      render = p.render
      state = p.state
    }
    const r = renderLine(render, line, env, carry)
    const skip = carry?.length ?? 0
    let n = r.layout.length - 1
    for (; n > 0; n--) {
      const row = r.layout[n - 1]!
      const cell = r.cells[row.next]
      if (!row.stable || !cell) continue
      const run = r.runs[cell.run]!
      if (run.cuttable && cell.src >= skip) break
    }
    if (n === 0) return false
    const cell = r.cells[r.layout[n - 1]!.next]!
    if (state) {
      // Committed rows follow a pending blank line like any others.
      const blank = state.blankPending && state.emitted
      state.blankPending = false
      state.emitted = true
      this.state = state
      if (blank) sink([""])
    }
    sink(r.rows.slice(0, n))
    this.cut = {
      render: { ...render, start: render.start + cell.src - skip, prefix: render.rest, trim: 0 },
      carry: r.runs[cell.run]!.carry,
    }
    return true
  }
}
